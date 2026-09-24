import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

export const CACHE_DIR = process.env.SLA_CACHE_DIR ?? path.resolve(import.meta.dirname, '..', '.cache');

interface Entry { value: unknown; expires: number; storedAt: number }
const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_MEMORY_ENTRIES = 400;

export const FOREVER = Number.POSITIVE_INFINITY;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface CacheOptions {
  /** Persist to disk so restarts and research scripts reuse it. */
  disk?: boolean;
}

const fileFor = (key: string) => path.join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json.gz`);

async function readDisk(key: string): Promise<{ value: unknown; mtime: number } | null> {
  try {
    const file = fileFor(key);
    const [buffer, info] = await Promise.all([readFile(file), stat(file)]);
    return { value: JSON.parse(gunzipSync(buffer).toString('utf8')), mtime: info.mtimeMs };
  } catch {
    return null;
  }
}

async function writeDisk(key: string, value: unknown): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, gzipSync(JSON.stringify(value), { level: 6 }));
    await rename(tmp, file);
  } catch (error) {
    console.warn(`[cache] could not persist ${key}:`, (error as Error).message);
  }
}

function remember(key: string, value: unknown, ttl: number, storedAt = Date.now()) {
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.delete(key);
  memory.set(key, { value, expires: storedAt + ttl, storedAt });
}

/**
 * Read-through cache with in-flight de-duplication and stale-on-error fallback:
 * if a refresh fails, the last good value is served rather than failing the page.
 */
export async function cached<T>(key: string, ttl: number, load: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    let stale: unknown = hit?.value;
    if (options.disk) {
      const disk = await readDisk(key);
      if (disk) {
        if (disk.mtime + ttl > Date.now()) {
          remember(key, disk.value, ttl, disk.mtime);
          return disk.value as T;
        }
        stale ??= disk.value;
      }
    }
    try {
      const value = await load();
      remember(key, value, ttl);
      if (options.disk) await writeDisk(key, value);
      return value;
    } catch (error) {
      if (stale !== undefined) {
        console.warn(`[cache] serving stale ${key}:`, (error as Error).message);
        remember(key, stale, Math.min(ttl, 2 * MINUTE));
        return stale as T;
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
