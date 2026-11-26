/**
 * HEIC / HEIF phone photos.
 *
 * The image library used everywhere else (sharp) can read the AVIF flavour of HEIF but not HEIC, which is what many phones
 * save by default. A HEIC upload used to be accepted and then fail inside most of the protection steps, so the file was
 * stored as a partial protection without telling the owner. HEIC is now converted to a high-quality JPEG once, right after
 * the upload arrives, so every step downstream sees an ordinary image.
 *
 * The conversion is deterministic: the same HEIC always gives the same JPEG, so a HEIC uploaded again later (for example to
 * verify it) matches what was stored.
 */

import sharp from 'sharp';

/** Brands that mean HEVC-coded HEIF (HEIC). AVIF brands are excluded: sharp reads those itself. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** True when the first bytes of a file are a HEIC container. The file name and the declared type are never trusted. */
export function isHeicHeader(head: Buffer): boolean {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return false;
  const major = head.toString('latin1', 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!GENERIC_HEIF_BRANDS.has(major)) return false;
  // A generic HEIF file is HEIC when one of its compatible brands says so (compatible brands start after the minor version).
  const boxSize = head.readUInt32BE(0);
  const end = Math.min(boxSize > 0 ? boxSize : head.length, head.length);
  for (let i = 16; i + 4 <= end; i += 4) {
    if (HEIC_BRANDS.has(head.toString('latin1', i, i + 4))) return true;
  }
  return false;
}

/** Largest picture converted, in megapixels. Decoding holds the whole picture in memory (about 25 MB per megapixel at peak). */
export function maxHeicMegapixels(): number {
  const n = Number(process.env['HEIC_MAX_MEGAPIXELS'] ?? 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export class HeicConversionError extends Error {
  constructor(message: string, readonly reason: 'unreadable' | 'too_large') {
    super(message);
    this.name = 'HeicConversionError';
  }
}

export interface HeicConversion {
  buffer: Buffer;
  width: number;
  height: number;
  /** True when the camera details (make, model, date, location) were carried over to the JPEG. */
  exifCopied: boolean;
  /** True when the colour profile was carried over to the JPEG. */
  iccCopied: boolean;
}

type HeicDecode = (options: { buffer: Buffer | Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

async function loadDecoder(): Promise<HeicDecode> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('heic-decode');
  return (mod.default ?? mod) as HeicDecode;
}

// Decoding a large picture needs a few hundred MB, and the server has little to spare: one conversion at a time.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** Converts a HEIC photo to a JPEG (quality 95, no chroma loss), keeping camera details and colour profile. */
export function heicToJpeg(input: Buffer): Promise<HeicConversion> {
  return oneAtATime(() => convert(input));
}

async function convert(input: Buffer): Promise<HeicConversion> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(input, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new HeicConversionError(`HEIC header unreadable: ${errMessage(err)}`, 'unreadable');
  }
  const megapixels = ((meta.width ?? 0) * (meta.height ?? 0)) / 1_000_000;
  if (megapixels > maxHeicMegapixels()) {
    throw new HeicConversionError(`HEIC picture is ${megapixels.toFixed(0)} megapixels (limit ${maxHeicMegapixels()})`, 'too_large');
  }

  let decoded: { width: number; height: number; data: Uint8ClampedArray };
  try {
    decoded = await (await loadDecoder())({ buffer: input });
  } catch (err) {
    throw new HeicConversionError(`HEIC could not be decoded: ${errMessage(err)}`, 'unreadable');
  }

  const raw = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  let jpeg: Buffer = await sharp(raw, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  // Camera details and colour profile are not part of the decoded pixels, so they are copied from the HEIC container.
  const segments: Array<{ marker: number; payload: Buffer }> = [];
  let exifCopied = false;
  let iccCopied = false;
  if (meta.exif && meta.exif.length > 8) {
    const exif = exifWithUprightOrientation(meta.exif);
    if (exif && exif.length <= 65_533) {
      segments.push({ marker: 0xe1, payload: exif });
      exifCopied = true;
    }
  }
  if (meta.icc && meta.icc.length > 0) {
    for (const payload of iccSegments(meta.icc)) segments.push({ marker: 0xe2, payload });
    iccCopied = true;
  }
  if (segments.length > 0) jpeg = insertJpegSegments(jpeg, segments);

  return { buffer: jpeg, width: decoded.width, height: decoded.height, exifCopied, iccCopied };
}

function errMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0]!.slice(0, 200);
}

/**
 * The decoder already applies the photo's rotation, so the JPEG must say "upright". An Exif orientation left at 6 would turn
 * the picture a second time in every viewer. Returns the Exif block with its marker prefix, or null when it cannot be read.
 */
export function exifWithUprightOrientation(exif: Buffer): Buffer | null {
  const withHeader: Buffer = exif.toString('latin1', 0, 4) === 'Exif' ? Buffer.from(exif) : Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif]);
  const tiff = 6;
  if (withHeader.length < tiff + 8) return null;
  const order = withHeader.toString('latin1', tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (o: number) => (little ? withHeader.readUInt16LE(o) : withHeader.readUInt16BE(o));
  const u32 = (o: number) => (little ? withHeader.readUInt32LE(o) : withHeader.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > withHeader.length) return null;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > withHeader.length) return null;
    if (u16(entry) === 0x0112) {
      if (little) withHeader.writeUInt16LE(1, entry + 8); else withHeader.writeUInt16BE(1, entry + 8);
      break;
    }
  }
  return withHeader;
}

/** Splits an ICC profile into the numbered APP2 chunks the JPEG format uses. */
function iccSegments(icc: Buffer): Buffer[] {
  const chunkSize = 65_519; // 65533 less the 12-byte "ICC_PROFILE\0" tag and 2 counters
  const total = Math.ceil(icc.length / chunkSize);
  const out: Buffer[] = [];
  for (let n = 0; n < total; n++) {
    out.push(Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([n + 1, total]), icc.subarray(n * chunkSize, (n + 1) * chunkSize)]));
  }
  return out;
}

/** Writes extra APPn segments into a JPEG, after the JFIF header when there is one. */
function insertJpegSegments(jpeg: Buffer, segments: Array<{ marker: number; payload: Buffer }>): Buffer {
  let at = 2; // after the start-of-image marker
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4); // after JFIF
  const parts: Buffer[] = [jpeg.subarray(0, at)];
  for (const s of segments) {
    const header = Buffer.from([0xff, s.marker, 0, 0]);
    header.writeUInt16BE(s.payload.length + 2, 2);
    parts.push(header, s.payload);
  }
  parts.push(jpeg.subarray(at));
  return Buffer.concat(parts);
}
