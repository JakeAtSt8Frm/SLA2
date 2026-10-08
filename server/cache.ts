import { mkdir, readFile, stat, writeFile, rename, rm, utimes } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

export const CACHE_DIR = process.env.SLA_CACHE_DIR ?? path.resolve(import.meta.dirname, '..', '.cache');

/** `etag` is the upstream validator of the cached copy (HTTP ETag), when the loader reported one. */
interface Entry { value: unknown; expires: number; storedAt: number; etag: string | null }
const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_MEMORY_ENTRIES = 400;
/** How long an expired copy keeps being served while one refresh runs (or after one fails). */
const HOLD = 30_000;

export const FOREVER = Number.POSITIVE_INFINITY;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** A loader's answer when the upstream copy still matches the cached one (HTTP 304): keep it. */
export const NOT_MODIFIED: unique symbol = Symbol('not-modified');

/**
 * Lets a loader revalidate instead of re-downloading: send `etag` upstream (If-None-Match) and
 * return NOT_MODIFIED on a 304; set `next` to the validator of a fresh response. A 304 keeps the
 * cached value object itself, so identity-keyed work downstream is skipped too.
 */
export interface Revalidation { readonly etag: string | null; next: string | null }

export interface CacheOptions {
  /** Persist to disk so restarts and research scripts reuse it. */
  disk?: boolean;
  /**
   * Stale-while-revalidate: if an expired copy exists (memory or disk), return it immediately
   * and refresh in the background. Keeps cold starts on slow hosts fast.
   */
  swr?: boolean;
}

type Loader<T> = (rv: Revalidation) => Promise<T | typeof NOT_MODIFIED>;
interface Base { value: unknown; storedAt: number; etag: string | null }

const refreshing = new Map<string, Promise<void>>();

function refreshInBackground<T>(key: string, ttl: number, load: Loader<T>, disk: boolean, base: Base) {
  if (refreshing.has(key)) return;
  const task = revalidate(key, ttl, load, disk, base)
    .then(() => undefined)
    .catch(error => console.warn(`[cache] background refresh failed for ${key}:`, (error as Error).message))
    .finally(() => refreshing.delete(key));
  refreshing.set(key, task);
}

/**
 * Resolves once every background refresh running now has finished, or null if none is. Lets a
 * caller that was just served stale copies redo its work as soon as fresh ones land.
 */
export function refreshesSettled(): Promise<void> | null {
  if (!refreshing.size) return null;
  return Promise.allSettled([...refreshing.values()]).then(() => undefined);
}

const fileFor = (key: string) => path.join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json.gz`);
const etagFileFor = (key: string) => `${fileFor(key)}.etag`;

async function readDisk(key: string): Promise<{ value: unknown; storedAt: number; etag: string | null } | null> {
  try {
    const file = fileFor(key);
    const [buffer, info, etag] = await Promise.all([readFile(file), stat(file), readFile(etagFileFor(key), 'utf8').catch(() => '')]);
    return { value: JSON.parse(gunzipSync(buffer).toString('utf8')), storedAt: info.mtimeMs, etag: etag || null };
  } catch {
    return null;
  }
}

async function writeDisk(key: string, value: unknown, etag: string | null): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, gzipSync(JSON.stringify(value), { level: 6 }));
    await rename(tmp, file);
    // Written after the value: a crash in between leaves an older validator, which only costs a download.
    if (etag) await writeFile(etagFileFor(key), etag);
    else await rm(etagFileFor(key), { force: true });
  } catch (error) {
    console.warn(`[cache] could not persist ${key}:`, (error as Error).message);
  }
}

/** A revalidated copy is as good as a new download: mark it fresh for the next process too. */
async function touchDisk(key: string): Promise<void> {
  const now = new Date();
  await utimes(fileFor(key), now, now).catch(() => undefined);
}

function remember(key: string, value: unknown, expires: number, storedAt: number, etag: string | null) {
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.delete(key);
  memory.set(key, { value, expires, storedAt, etag });
}

/** Load a fresh copy, conditionally when there is a cached one to fall back on. */
async function revalidate<T>(key: string, ttl: number, load: Loader<T>, disk: boolean, base: Base | null): Promise<T> {
  const rv: Revalidation = { etag: base?.etag ?? null, next: null };
  const result = await load(rv);
  const now = Date.now();
  if (result === NOT_MODIFIED) {
    if (!base) throw new Error(`${key}: upstream says not modified, but nothing is cached`);
    remember(key, base.value, now + ttl, now, base.etag);
    if (disk) await touchDisk(key);
    return base.value as T;
  }
  remember(key, result, now + ttl, now, rv.next);
  if (disk) await writeDisk(key, result, rv.next);
  return result;
}

/**
 * Read-through cache with in-flight de-duplication, conditional revalidation and stale-on-error
 * fallback: if a refresh fails, the last good value is served rather than failing the page.
 */
export async function cached<T>(key: string, ttl: number, load: Loader<T>, options: CacheOptions = {}): Promise<T> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  if (options.swr && hit) {
    hit.expires = now + HOLD;
    refreshInBackground(key, ttl, load, !!options.disk, hit);
    return hit.value as T;
  }

  const task = (async () => {
    // An in-memory copy is never re-read from disk: keeping the same object lets identity-keyed work be reused.
    let base: Base | null = hit ?? null;
    if (options.disk && !base) {
      const disk = await readDisk(key);
      if (disk) {
        if (disk.storedAt + ttl > Date.now()) {
          remember(key, disk.value, disk.storedAt + ttl, disk.storedAt, disk.etag);
          return disk.value as T;
        }
        if (options.swr) {
          remember(key, disk.value, Date.now() + HOLD, disk.storedAt, disk.etag);
          refreshInBackground(key, ttl, load, true, disk);
          return disk.value as T;
        }
        base = disk;
      }
    }
    try {
      return await revalidate(key, ttl, load, !!options.disk, base);
    } catch (error) {
      if (base) {
        console.warn(`[cache] serving stale ${key}:`, (error as Error).message);
        remember(key, base.value, Date.now() + Math.min(ttl, 2 * MINUTE), base.storedAt, base.etag);
        return base.value as T;
      }
      throw error;
    }
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/** Memoise a pure computation on its inputs' identity key (no disk). */
export function memo<T>(key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
  return cached(`memo:${key}`, ttl, compute);
}

export function invalidate(prefix: string) {
  for (const key of memory.keys()) if (key.startsWith(prefix) || key.startsWith(`memo:${prefix}`)) memory.delete(key);
}
