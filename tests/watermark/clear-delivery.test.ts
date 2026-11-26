/**
 * Delivered copies must look like the original, and the protection must keep
 * working. Covers the 2026-10-13 fixes:
 *  - the crop copy no longer paints a visible block pattern;
 *  - copies marked the old way (already shared) still read;
 *  - the photo's rotation tag and colour profile survive delivery;
 *  - nothing private (camera or location details) is copied across.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the mark on for this test of its mechanics
import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  embedRobustProvenanceWatermark,
  extractWatermarkLookupId,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';
import { attachIccToJpeg, attachIccToPng, isRgbIccProfile } from '../../src/services/dna-vnext/colour-metadata';

const SLOW = 180_000;
const VAULT = 'vault-clear';
const DNA = 'dna-clear';
const LOOKUP = watermarkLookupId(VAULT, DNA);

async function smooth(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const sky = y < height * 0.6;
      raw[i] = sky ? 190 : 100;
      raw[i + 1] = sky ? 205 : 90;
      raw[i + 2] = sky ? 225 : 80;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function textured(width: number, height: number, seed: number): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const v = 128 + 90 * Math.sin(x / 70) * Math.cos(y / 55);
      raw[i] = Math.max(0, Math.min(255, v + (rnd() - 0.5) * 14));
      raw[i + 1] = Math.max(0, Math.min(255, v * 0.8 + (rnd() - 0.5) * 14));
      raw[i + 2] = Math.max(0, Math.min(255, 255 - v + (rnd() - 0.5) * 14));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function luma(buffer: Buffer, width: number, height: number): Promise<Float64Array> {
  const { data } = await sharp(buffer).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = 0.299 * data[i * 3]! + 0.587 * data[i * 3 + 1]! + 0.114 * data[i * 3 + 2]!;
  return out;
}

function psnr(a: Float64Array, b: Float64Array): number {
  let mse = 0;
  for (let i = 0; i < a.length; i++) mse += (a[i]! - b[i]!) ** 2;
  mse /= a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 31) { sum += Math.abs(a[i]! - b[i]!); n++; }
  return sum / n;
}

async function centreCrop(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const left = Math.round((width - 256) / 2) - 16;
  const top = Math.round((height - 256) / 2) - 16;
  return sharp(buffer).extract({ left, top, width: 288, height: 288 }).png().toBuffer();
}

describe('the crop copy is invisible and still reads', () => {
  test.each([
    ['smooth', 960, 800, () => smooth(960, 800)],
    ['textured', 960, 800, () => textured(960, 800, 77)],
  ] as const)('%s image: clear (the gate guarantees PSNR of at least 36 dB; the old fixed step gave about 29)', async (_name, w, h, make) => {
    const original = await make();
    const marked = await embedRobustProvenanceWatermark({ buffer: original, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA });
    expect(marked.embedded).toBe(true);
    expect(psnr(await luma(original, w, h), await luma(marked.buffer, w, h))).toBeGreaterThan(36);
    expect(await extractWatermarkLookupId(marked.buffer)).toBe(LOOKUP);
  }, SLOW);

  test.each([
    ['smooth', () => smooth(960, 800)],
    ['textured', () => textured(960, 800, 9011)],
  ] as const)('%s image: a centre crop reads whenever the gate wrote a crop copy, even after JPEG quality 50', async (_name, make) => {
    const marked = await embedRobustProvenanceWatermark({ buffer: await make(), mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA });
    const hasCropCopy = ['full', 'balanced', 'gentle', 'light', 'soft+crop', 'faint+crop'].includes(marked.clarity?.rung ?? '');
    const crop = await centreCrop(marked.buffer, 960, 800);
    for (const quality of [undefined, 85, 50]) {
      const copy = quality ? await sharp(crop).jpeg({ quality }).toBuffer() : crop;
      // With no crop copy (the gate found none that is invisible on this picture) a crop is not recoverable by the mark.
      expect(await extractWatermarkLookupId(copy)).toBe(hasCropCopy ? LOOKUP : null);
    }
  }, SLOW);

  test('a copy marked the old way (fixed step, already shared) still reads, whole and cropped', async () => {
    const old = fs.readFileSync(path.join(__dirname, 'fixtures', 'old-crop-style-768.png'));
    const oldLookup = watermarkLookupId('vault-fixture', 'dna-fixture');
    expect(await extractWatermarkLookupId(old)).toBe(oldLookup);
    // A crop from the sky (top left): one mark block with no hard edge in it. A block that holds a strong
    // edge cannot be read from a crop, old or new, because the picture itself overrules the mark.
    const skyCrop = await sharp(old).extract({ left: 0, top: 0, width: 288, height: 288 }).png().toBuffer();
    expect(await extractWatermarkLookupId(skyCrop)).toBe(oldLookup);
  }, SLOW);
});

describe('rotation and colour survive delivery', () => {
  async function scene(width: number, height: number): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = (x * 255) / width;
        raw[i + 1] = (y * 255) / height;
        raw[i + 2] = 255 - (x * 255) / width;
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  test.each(['jpeg', 'png'] as const)('%s: the rotation tag is kept, the verify link is there, the mark reads', async (format) => {
    const base = await scene(800, 600);
    const input = format === 'jpeg'
      ? await sharp(base).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toBuffer()
      : await sharp(base).png().withMetadata({ orientation: 6 }).toBuffer();
    const out = await embedRobustProvenanceWatermark({ buffer: input, mimeType: `image/${format}`, vaultId: VAULT, dnaRecordId: DNA });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.exif?.toString('latin1')).toContain('Protected by PINIT');
    expect(await extractWatermarkLookupId(out.buffer)).toBe(LOOKUP);
  }, SLOW);

  test.each(['jpeg', 'png'] as const)('%s: a Display P3 photo keeps its exact profile and its colours', async (format) => {
    const base = await scene(800, 600);
    const withP3 = sharp(base).withIccProfile('p3');
    const p3 = format === 'jpeg'
      ? await withP3.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
      : await withP3.png().toBuffer();
    const before = await sharp(p3).metadata();
    expect(isRgbIccProfile(before.icc)).toBe(true);

    const out = await embedRobustProvenanceWatermark({ buffer: p3, mimeType: `image/${format}`, vaultId: VAULT, dnaRecordId: DNA });
    const after = await sharp(out.buffer).metadata();
    expect(after.icc && before.icc && Buffer.compare(after.icc, before.icc)).toBe(0);

    const stored = (b: Buffer) => sharp(b).keepIccProfile().removeAlpha().raw().toBuffer();
    const viewed = (b: Buffer) => sharp(b).removeAlpha().raw().toBuffer();
    expect(meanAbsDiff(await stored(p3), await stored(out.buffer))).toBeLessThan(3);
    expect(meanAbsDiff(await viewed(p3), await viewed(out.buffer))).toBeLessThan(3.5);
    expect(await extractWatermarkLookupId(out.buffer)).toBe(LOOKUP);
  }, SLOW);

  test('a photo with no profile gets none added, and a grayscale photo still works', async () => {
    const base = await scene(640, 480);
    const plain = await sharp(base).jpeg({ quality: 92 }).toBuffer();
    const out = await embedRobustProvenanceWatermark({ buffer: plain, mimeType: 'image/jpeg', vaultId: VAULT, dnaRecordId: DNA });
    expect((await sharp(out.buffer).metadata()).icc).toBeUndefined();

    const gray = await sharp(base).grayscale().jpeg({ quality: 92 }).toBuffer();
    const grayOut = await embedRobustProvenanceWatermark({ buffer: gray, mimeType: 'image/jpeg', vaultId: VAULT, dnaRecordId: DNA });
    expect(grayOut.embedded).toBe(true);
    expect(await extractWatermarkLookupId(grayOut.buffer)).toBe(LOOKUP);
  }, SLOW);

  test('camera and owner details in the original are not copied to the delivered copy', async () => {
    const base = await scene(640, 480);
    const tagged = await sharp(base).jpeg({ quality: 92 }).withExif({ IFD0: { Artist: 'private-person-name', Make: 'secret-camera-make' } }).toBuffer();
    expect((await sharp(tagged).metadata()).exif?.toString('latin1')).toContain('private-person-name');
    const out = await embedRobustProvenanceWatermark({ buffer: tagged, mimeType: 'image/jpeg', vaultId: VAULT, dnaRecordId: DNA });
    const text = (await sharp(out.buffer).metadata()).exif?.toString('latin1') ?? '';
    expect(text).not.toContain('private-person-name');
    expect(text).not.toContain('secret-camera-make');
    expect(text).toContain('Protected by PINIT');
  }, SLOW);
});

describe('the colour profile writers produce valid files', () => {
  test('a profile attached to a JPEG or PNG reads back identically and the file still decodes', async () => {
    const icc = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).withIccProfile('p3').png().toBuffer());
    const profile = (await sharp(icc).metadata()).icc!;
    const raw = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } });
    const jpeg = attachIccToJpeg(await raw.jpeg().toBuffer(), profile);
    const png = attachIccToPng(await raw.png().toBuffer(), profile);
    for (const file of [jpeg, png]) {
      const meta = await sharp(file).metadata();
      expect(meta.icc && Buffer.compare(meta.icc, profile)).toBe(0);
      expect(meta.width).toBe(64);
      expect((await sharp(file).raw().toBuffer()).length).toBeGreaterThan(0);
    }
    // Attaching twice leaves one profile, not two.
    const twice = attachIccToJpeg(jpeg, profile);
    expect((await sharp(twice).metadata()).icc?.length).toBe(profile.length);
    // A profile that is not there changes nothing.
    expect(isRgbIccProfile(undefined)).toBe(false);
    expect(isRgbIccProfile(Buffer.alloc(10))).toBe(false);
  });
});
