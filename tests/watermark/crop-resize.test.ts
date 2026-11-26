/**
 * Crop-resistant owner mark (2026-10-16). Measured, not assumed.
 *
 * Before: a crop read only at its original size, only on pictures where the clarity gate kept the crop copy, and
 * only when a block happened to be found from one block's evidence: 6 of 24 crop cases read on two test pictures.
 * Now: the resize factor is estimated from the crop copy's own row rhythm and the picture is scaled back; detailed
 * photos keep a faint crop copy (soft+crop / faint+crop); the reader scores alignments on several blocks, steps 4
 * rows vertically and polishes to the exact pixel. 24 of 24 read. No database: no ownerUserId is passed.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the mark on for this test of its mechanics
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
import {
  embedRobustProvenanceWatermark,
  extractWatermarkLookupId,
  extractWatermarkMatch,
  estimateResizeFactors,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';

const SLOW = 300_000;
const VAULT = 'vault-crop-resize';
const DNA = 'dna-crop-resize';
const LOOKUP = watermarkLookupId(VAULT, DNA);

/** Photo-like picture: smooth gradients, soft shapes and mild noise (same family as the transcode tests). */
async function photo(width: number, height: number, seed: number): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(width * height * 3);
  const fx = 60 + rnd() * 80;
  const fy = 50 + rnd() * 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const v = 128 + 90 * Math.sin(x / fx) * Math.cos(y / fy);
      raw[i] = Math.max(0, Math.min(255, v + 40 * Math.sin(x / 200) + (rnd() - 0.5) * 14));
      raw[i + 1] = Math.max(0, Math.min(255, v * 0.8 + 50 * Math.cos(y / 130) + (rnd() - 0.5) * 14));
      raw[i + 2] = Math.max(0, Math.min(255, 255 - v + 30 * Math.sin((x + y) / 160) + (rnd() - 0.5) * 14));
    }
  }
  const shapes = Array.from({ length: 40 }, () =>
    `<circle cx="${(rnd() * width) | 0}" cy="${(rnd() * height) | 0}" r="${20 + rnd() * 90}" ` +
    `fill="rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})" fill-opacity="0.55"/>`).join('');
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`);
  return sharp(raw, { raw: { width, height, channels: 3 } }).composite([{ input: svg }]).jpeg({ quality: 92 }).toBuffer();
}

async function centerCrop(buffer: Buffer, fraction: number): Promise<Buffer> {
  const m = await sharp(buffer).metadata();
  const w = Math.round(m.width! * fraction);
  const h = Math.round(m.height! * fraction);
  return sharp(buffer).extract({ left: Math.round((m.width! - w) / 2), top: Math.round((m.height! - h) / 2), width: w, height: h }).png().toBuffer();
}

const resizeBy = async (b: Buffer, r: number) => sharp(b).resize(Math.round((await sharp(b).metadata()).width! * r)).png().toBuffer();
const longSide = (b: Buffer, side: number, q: number) => sharp(b).resize({ width: side, height: side, fit: 'inside' }).jpeg({ quality: q }).toBuffer();

describe('crop + resize: a cropped share that was then resized still names its copy', () => {
  let marked: Buffer;
  beforeAll(async () => {
    const out = await embedRobustProvenanceWatermark({ buffer: await photo(2000, 1500, 7), mimeType: 'image/jpeg', vaultId: VAULT, dnaRecordId: DNA });
    expect(out.embedded).toBe(true);
    marked = out.buffer;
  }, SLOW);

  test.each([
    ['half the picture, resized to 75%', async (b: Buffer) => resizeBy(await centerCrop(b, 0.5), 0.75)],
    ['half the picture, resized to 50%', async (b: Buffer) => resizeBy(await centerCrop(b, 0.5), 0.5)],
    ['half the picture, enlarged to 130%', async (b: Buffer) => resizeBy(await centerCrop(b, 0.5), 1.3)],
    ['messenger: 60% crop sent at 1600 px, JPEG 75', async (b: Buffer) => longSide(await centerCrop(b, 0.6), 1600, 75)],
    ['messenger: 60% crop sent at 800 px, JPEG 75', async (b: Buffer) => longSide(await centerCrop(b, 0.6), 800, 75)],
  ])('%s', async (_label, transform) => {
    expect(await extractWatermarkLookupId(await transform(marked))).toBe(LOOKUP);
  }, SLOW);

  test('the resize factor is measured from the picture itself', async () => {
    const probe = await resizeBy(await centerCrop(marked, 0.5), 0.75);
    const { data, info } = await sharp(probe).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const factors = estimateResizeFactors(data, info.width, info.height);
    expect(factors.some((f) => Math.abs(f - 0.75) < 0.02)).toBe(true);
  }, SLOW);

  test('the crop + resize search can be switched off (the duplicate check during Protect does)', async () => {
    const probe = await resizeBy(await centerCrop(marked, 0.5), 0.75);
    expect(await extractWatermarkMatch(probe, { resizedCrops: false })).toBeNull();
  }, SLOW);
});

describe('detailed photos keep a crop copy', () => {
  test('a detailed photo the normal crop copy would show on gets a faint one, and its crops read', async () => {
    const out = await embedRobustProvenanceWatermark({ buffer: await photo(4000, 3000, 11), mimeType: 'image/jpeg', vaultId: VAULT, dnaRecordId: DNA });
    expect(out.embedded).toBe(true);
    expect(['soft+crop', 'faint+crop']).toContain(out.clarity?.rung);
    expect(out.clarity?.passed).toBe(true); // still within every invisibility limit
    for (const fraction of [0.6, 0.4, 0.25]) {
      expect(await extractWatermarkLookupId(await centerCrop(out.buffer, fraction))).toBe(LOOKUP);
    }
    expect(await extractWatermarkLookupId(await longSide(await centerCrop(out.buffer, 0.6), 800, 75))).toBe(LOOKUP);
  }, SLOW);
});

describe('no false readings', () => {
  test.each([
    ['an unmarked photo', () => photo(2000, 1500, 3)],
    ['an unmarked photo, cropped and resized', async () => resizeBy(await centerCrop(await photo(2000, 1500, 5), 0.5), 0.75)],
  ])('%s reads nothing', async (_label, make) => {
    expect(await extractWatermarkLookupId(await make())).toBeNull();
  }, SLOW);
});
