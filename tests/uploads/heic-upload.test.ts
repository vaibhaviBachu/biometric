/**
 * HEIC phone photos are converted to JPEG when they are uploaded (src/lib/heic.ts, heic-upload.middleware.ts).
 * The fixtures are tiny synthetic pictures made with a standard HEIC encoder: no real person's photo is stored here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import exifr from 'exifr';
import type { Request } from 'express';
import { exifWithUprightOrientation, heicToJpeg, isHeicHeader, HeicConversionError } from '../../src/lib/heic';
import { convertHeicUploads, jpegFileName } from '../../src/api/middleware/heic-upload.middleware';

const FIX = path.join(__dirname, '..', 'fixtures', 'heic');
const plain = () => fs.readFileSync(path.join(FIX, 'plain.heic'));
const withExif = () => fs.readFileSync(path.join(FIX, 'with-exif.heic'));

describe('isHeicHeader', () => {
  it('recognises HEIC by its header, whatever the file is called', () => {
    expect(isHeicHeader(plain())).toBe(true);
    expect(isHeicHeader(withExif())).toBe(true);
  });

  it('does not claim a JPEG, a PNG or an AVIF', async () => {
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } }).png().toBuffer();
    const avif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).avif().toBuffer();
    expect(isHeicHeader(jpg)).toBe(false);
    expect(isHeicHeader(png)).toBe(false);
    expect(isHeicHeader(avif)).toBe(false); // sharp reads AVIF itself
    expect(isHeicHeader(Buffer.from('hello'))).toBe(false);
  });
});

describe('heicToJpeg', () => {
  it('turns a HEIC into a JPEG of the same size that other image tools can read', async () => {
    const out = await heicToJpeg(plain());
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect([out.width, out.height]).toEqual([160, 120]);
    expect([meta.width, meta.height]).toEqual([160, 120]);
    // the pixels really decode (the old failure was "support for this compression format has not been built in")
    const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(data.length).toBe(160 * 120 * 3);
  });

  it('is deterministic: the same HEIC always gives the same JPEG', async () => {
    const a = await heicToJpeg(plain());
    const b = await heicToJpeg(plain());
    expect(a.buffer.equals(b.buffer)).toBe(true);
  });

  it('keeps the camera details and sets the orientation to upright', async () => {
    const out = await heicToJpeg(withExif());
    expect(out.exifCopied).toBe(true);
    const tags = await exifr.parse(out.buffer, { translateValues: false, pick: ['Make', 'Model', 'Orientation', 'Software', 'DateTimeOriginal'] });
    expect(tags.Make).toBe('TestPhone');
    expect(tags.Model).toBe('T-1 Mini');
    expect(tags.Software).toBe('TestCam 1.0');
    expect(tags.Orientation).toBe(1); // the source said 6; the decoder already applies rotation
    expect(new Date(tags.DateTimeOriginal).getFullYear()).toBe(2026);
    expect((await sharp(out.buffer).metadata()).orientation).toBe(1);
  });

  it('copes with a HEIC that has no camera details', async () => {
    const out = await heicToJpeg(plain());
    expect(out.exifCopied).toBe(false);
    expect((await sharp(out.buffer).metadata()).format).toBe('jpeg');
  });

  it('refuses a damaged HEIC with an "unreadable" error, like the cut-off photo that came from a phone', async () => {
    const whole = withExif();
    const cutOff = whole.subarray(0, whole.length - 700);
    await expect(heicToJpeg(cutOff)).rejects.toMatchObject({ name: 'HeicConversionError', reason: 'unreadable' });
    await expect(heicToJpeg(Buffer.from('....ftypheic garbage that is not a picture')))
      .rejects.toBeInstanceOf(HeicConversionError);
  });

  it('refuses a picture bigger than the megapixel limit', async () => {
    process.env['HEIC_MAX_MEGAPIXELS'] = '0.01'; // 160 x 120 = 0.0192 MP
    try {
      await expect(heicToJpeg(plain())).rejects.toMatchObject({ reason: 'too_large' });
    } finally {
      delete process.env['HEIC_MAX_MEGAPIXELS'];
    }
  });
});

describe('exifWithUprightOrientation', () => {
  it('handles both byte orders and leaves other tags alone', () => {
    const make = (order: 'II' | 'MM') => {
      const little = order === 'II';
      const b = Buffer.alloc(6 + 8 + 2 + 12 + 4);
      b.write('Exif\0\0', 0, 'latin1');
      b.write(order, 6, 'latin1');
      (little ? b.writeUInt16LE : b.writeUInt16BE).call(b, 42, 8);
      (little ? b.writeUInt32LE : b.writeUInt32BE).call(b, 8, 10);
      (little ? b.writeUInt16LE : b.writeUInt16BE).call(b, 1, 14); // one entry
      (little ? b.writeUInt16LE : b.writeUInt16BE).call(b, 0x0112, 16);
      (little ? b.writeUInt16LE : b.writeUInt16BE).call(b, 3, 18);
      (little ? b.writeUInt32LE : b.writeUInt32BE).call(b, 1, 20);
      (little ? b.writeUInt16LE : b.writeUInt16BE).call(b, 8, 24); // orientation 8
      return b;
    };
    for (const order of ['II', 'MM'] as const) {
      const out = exifWithUprightOrientation(make(order))!;
      expect(order === 'II' ? out.readUInt16LE(24) : out.readUInt16BE(24)).toBe(1);
    }
  });

  it('returns null for something that is not Exif', () => {
    expect(exifWithUprightOrientation(Buffer.from('not exif at all, just text'))).toBeNull();
  });
});

describe('jpegFileName', () => {
  it('renames HEIC files and leaves JPEG names alone', () => {
    expect(jpegFileName('IMG_1.HEIC')).toBe('IMG_1.jpg');
    expect(jpegFileName('IMG_2.heif')).toBe('IMG_2.jpg');
    expect(jpegFileName('IMG_3.jpg')).toBe('IMG_3.jpg');
    expect(jpegFileName('IMG_4.jpeg')).toBe('IMG_4.jpg');
    expect(jpegFileName('IMG_5')).toBe('IMG_5.jpg');
  });
});

describe('convertHeicUploads middleware', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-mw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function request(name: string, bytes: Buffer, mimetype = 'image/heic') {
    const file = path.join(dir, `dna_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.writeFileSync(file, bytes);
    const req = { file: { path: file, originalname: name, mimetype, size: bytes.length } } as unknown as Request;
    return { req, file };
  }
  const run = (req: Request) => new Promise<unknown>((resolve) => { void convertHeicUploads(req, {} as never, (err?: unknown) => resolve(err)); });

  it('replaces a HEIC on disk with a JPEG and updates the upload entry', async () => {
    const { req, file } = request('IMG_20261020_133554.heic', plain());
    expect(await run(req)).toBeUndefined();
    const after = fs.readFileSync(file);
    expect((await sharp(after).metadata()).format).toBe('jpeg');
    expect(req.file).toMatchObject({ mimetype: 'image/jpeg', originalname: 'IMG_20261020_133554.jpg', size: after.length });
  });

  it('finds a HEIC that is called .jpg and declared as image/jpeg (the real phone case)', async () => {
    const { req, file } = request('IMG_20261020_133554_442.jpg', plain(), 'image/jpeg');
    expect(await run(req)).toBeUndefined();
    expect((await sharp(fs.readFileSync(file)).metadata()).format).toBe('jpeg');
    expect(req.file!.originalname).toBe('IMG_20261020_133554_442.jpg');
  });

  it('leaves an ordinary JPEG untouched, byte for byte', async () => {
    const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#789' } }).jpeg().toBuffer();
    const { req, file } = request('photo.jpg', jpg, 'image/jpeg');
    expect(await run(req)).toBeUndefined();
    expect(fs.readFileSync(file).equals(jpg)).toBe(true);
    expect(req.file!.size).toBe(jpg.length);
  });

  it('refuses a damaged HEIC with a clear 422 and removes the file', async () => {
    const whole = withExif();
    const { req, file } = request('IMG_cut.heic', whole.subarray(0, whole.length - 700));
    const err = await run(req) as { statusCode?: number; status?: number; message?: string };
    expect(err.statusCode ?? err.status).toBe(422);
    expect(err.message).toMatch(/could not be read/i);
    expect(fs.existsSync(file)).toBe(false);
  });
});
