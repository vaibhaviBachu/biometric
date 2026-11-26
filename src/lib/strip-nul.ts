/**
 * Postgres cannot store the NUL character (U+0000) in `text` or `jsonb` columns: the write fails with
 * 22P05 "unsupported Unicode escape sequence" and takes the whole transaction with it.
 * File metadata (EXIF, IPTC, XMP) often carries NUL padding — camera and phone text fields, Windows XP tags,
 * UserComment's "ASCII\0\0\0" prefix — so anything copied from a file into the database goes through here first.
 *
 * Strings lose their NUL characters; objects and arrays are cleaned recursively (keys included).
 * Buffers, typed arrays, Dates and other non-plain values are returned untouched.
 */
const NUL = /\u0000/g;

export function stripNul<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return (value.includes('\u0000') ? value.replace(NUL, '') : value) as T;
  if (value === null || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => stripNul(v, depth + 1)) as T;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof Date) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.includes('\u0000') ? k.replace(NUL, '') : k] = stripNul(v, depth + 1);
  }
  return out as T;
}
