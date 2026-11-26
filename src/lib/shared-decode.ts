/**
 * One decode of a photo, shared by the layers that run together.
 *
 * Layers 1, 2 and 4 each used to decode the same photo into raw RGB pixels
 * on their own, all at once: three copies of a buffer that is 3 bytes per
 * pixel. Inside `withSharedDecode` the first caller decodes and the others
 * receive the same result. The decode call is exactly the one the layers made
 * themselves (`removeAlpha().raw()`), so every pixel is identical, and the
 * layers only ever read the buffer.
 *
 * The shared copy lives only while the scope runs and is dropped at the end,
 * so it is never kept alive for the rest of the request. Outside a scope (or
 * for a different buffer) `decodeRgb` simply decodes, as before.
 */
import { AsyncLocalStorage } from 'async_hooks';
import sharp from 'sharp';
import type { OutputInfo } from 'sharp';

export interface DecodedRgb {
  data: Buffer;
  info: OutputInfo;
}

interface Scope {
  buffer: Buffer;
  active: boolean;
  decoded?: Promise<DecodedRgb>;
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Large decodes are moved into a SharedArrayBuffer. Layers 2 and 4 hand the pixels to worker threads, and a normal
 * buffer is copied into each worker (3 bytes per pixel each time, ~144 MB per worker for a 48 MP photo). A shared one
 * is read in place. The bytes are the same, so every result is the same; only where they live changes.
 */
const SHARE_MIN_BYTES = 4 * 1024 * 1024;

async function decodeFresh(buffer: Buffer): Promise<DecodedRgb> {
  const decoded = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.data.length < SHARE_MIN_BYTES || typeof SharedArrayBuffer === 'undefined') return decoded;
  const shared = Buffer.from(new SharedArrayBuffer(decoded.data.length));
  decoded.data.copy(shared);
  return { data: shared, info: decoded.info };
}

/** Raw 3-channel RGB of the image: shared inside a `withSharedDecode` for the same buffer, a fresh decode otherwise. */
export function decodeRgb(buffer: Buffer): Promise<DecodedRgb> {
  const current = scope.getStore();
  if (current && current.active && current.buffer === buffer) {
    current.decoded ??= decodeFresh(buffer);
    return current.decoded;
  }
  return decodeFresh(buffer);
}

/** Runs `fn`; every `decodeRgb(buffer)` inside shares a single decode, released when `fn` ends. */
export async function withSharedDecode<T>(buffer: Buffer, fn: () => Promise<T>): Promise<T> {
  if ((process.env['SHARED_DECODE'] ?? '').toLowerCase() === 'off') return fn();
  const state: Scope = { buffer, active: true };
  try {
    return await scope.run(state, fn);
  } finally {
    state.active = false;
    state.decoded = undefined;
  }
}
