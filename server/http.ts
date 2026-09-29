/**
 * JSON responses encoded once per view object. Views are memoised per league core, so the same
 * object comes back until the core changes: it is serialised, hashed and compressed a single time,
 * and clients polling an unchanged view get a 304 instead of the payload.
 */
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Context } from 'hono';

interface Encoded { etag: string; raw: Buffer; br?: Buffer; gzip?: Buffer }
const encoded = new WeakMap<object, Encoded>();
/** Below this, compression isn't worth the CPU. */
const MIN_COMPRESS = 1024;

export function encode(data: object): Encoded {
  let e = encoded.get(data);
  if (!e) {
    const raw = Buffer.from(JSON.stringify(data));
    e = { etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"`, raw };
    encoded.set(data, e);
  }
  return e;
}

const brotli = (raw: Buffer) => brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 7, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });

/** Encode and pre-compress (brotli, which every current browser sends) ahead of the first request. */
export function prepare(data: object) {
  const e = encode(data);
  if (e.raw.length >= MIN_COMPRESS) e.br ??= brotli(e.raw);
}

export function sendJson(c: Context, data: object, maxAge: number): Response {
  const e = encode(data);
  c.header('Cache-Control', `private, max-age=${maxAge}`);
  c.header('ETag', e.etag);
  c.header('Vary', 'Accept-Encoding');
  if (c.req.header('If-None-Match') === e.etag) return c.body(null, 304);
  c.header('Content-Type', 'application/json; charset=UTF-8');
  const accept = c.req.header('Accept-Encoding') ?? '';
  if (e.raw.length >= MIN_COMPRESS && /\bbr\b/.test(accept)) {
    e.br ??= brotli(e.raw);
    c.header('Content-Encoding', 'br');
    return c.body(new Uint8Array(e.br));
  }
  if (e.raw.length >= MIN_COMPRESS && /\bgzip\b/.test(accept)) {
    e.gzip ??= gzipSync(e.raw, { level: 6 });
    c.header('Content-Encoding', 'gzip');
    return c.body(new Uint8Array(e.gzip));
  }
  return c.body(new Uint8Array(e.raw));
}
