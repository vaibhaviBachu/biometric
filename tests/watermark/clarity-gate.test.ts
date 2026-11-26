/**
 * Step B: the clarity gate. A delivered copy is either clear (it passes the
 * limits when measured against the original) or it carries no pixel mark. A
 * visible artifact is never shipped.
 */
import './helpers/pixel-mark-on'; // first: the mark is off on delivered copies by default; this tests the gate with it on
import { describe, test, expect, afterEach } from '@jest/globals';
import sharp from 'sharp';
import { clarityThresholds, measureClarity } from '../../src/services/dna-vnext/clarity-gate';
import {
  embedRobustProvenanceWatermark,
  extractWatermarkLookupId,
  measureEveryCropStrength,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';

const SLOW = 300_000;
const LOOKUP = watermarkLookupId('vault-gate', 'dna-gate');

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

type Maker = (x: number, y: number, rnd: () => number) => [number, number, number];

function pixels(width: number, height: number, make: Maker, seed = 5): Buffer {
  const rnd = rng(seed);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = make(x, y, rnd);
      const i = (y * width + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, r));
      rgba[i + 1] = Math.max(0, Math.min(255, g));
      rgba[i + 2] = Math.max(0, Math.min(255, b));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

async function png(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(rgba, { raw: { width, height, channels: 4 } }).removeAlpha().png().toBuffer();
}

const W = 960;
const H = 720;

const SAMPLES: Array<[string, Maker]> = [
  ['flat sky, wall and dress', (x, y) => { const sky = y < H * 0.6; const d = x > W * 0.3 && x < W * 0.7 && y > H * 0.2; return d ? [168, 28, 42] : sky ? [190, 205, 225] : [100, 90, 80]; }],
  ['soft gradient', (x, y) => [60 + (x / W) * 150, 90 + (y / H) * 100, 160 - (x / W) * 60]],
  ['dark night scene', (x, y, r) => { const v = 14 + 12 * Math.sin(x / 90) * Math.cos(y / 70) + r() * 3; return [v, v * 1.1, v * 1.5]; }],
  ['bright overexposed', (x, _y, r) => { const v = 232 + 10 * Math.sin(x / 120) + r() * 2; return [v, v - 4, v - 10]; }],
  ['text on white (screenshot-like)', (x, y) => { const on = (Math.floor(x / 14) + Math.floor(y / 9)) % 7 === 0 && y % 40 < 18; return on ? [20, 20, 20] : [250, 250, 250]; }],
  ['photo-like texture', (x, y, r) => { const v = 128 + 90 * Math.sin(x / 70) * Math.cos(y / 55) + (r() - 0.5) * 14; return [v, v * 0.8, 255 - v]; }],
  ['heavy noise', (_x, _y, r) => { const v = 128 + (r() - 0.5) * 60; return [v, v, v]; }],
  ['hard stripes', (x) => (Math.floor(x / 24) % 2 ? [220, 220, 220] : [40, 40, 40])],
];

describe('measuring clarity', () => {
  test('identical pixels are perfectly clear', () => {
    const a = pixels(256, 256, () => [120, 130, 140]);
    const r = measureClarity(a, Buffer.from(a), 256, 256);
    expect(r.passed).toBe(true);
    expect(r.psnrDb).toBe(99);
    expect(r.flatPeakDeviation).toBe(0);
  });

  test('a fixed brightness step in a flat area fails on the flat-area limits, not only on PSNR', () => {
    const a = pixels(256, 256, () => [120, 130, 140]);
    const b = Buffer.from(a);
    for (let i = 0; i < b.length; i += 4) { b[i] = b[i]! + 9; b[i + 1] = b[i + 1]! + 9; b[i + 2] = b[i + 2]! + 9; }
    const r = measureClarity(a, b, 256, 256);
    expect(r.passed).toBe(false);
    expect(r.failed).toEqual(expect.arrayContaining(['flat-mean', 'flat-peak']));
    expect(r.flatShare).toBeGreaterThan(0.95);
  });

  test('the same step in a busy area is masked, so only the whole-picture limit applies', () => {
    const a = pixels(256, 256, (_x, _y, r) => { const v = 128 + (r() - 0.5) * 70; return [v, v, v]; });
    const b = Buffer.from(a);
    for (let i = 0; i < b.length; i += 4) { b[i] = b[i]! + 2; b[i + 1] = b[i + 1]! + 2; b[i + 2] = b[i + 2]! + 2; }
    const r = measureClarity(a, b, 256, 256);
    expect(r.flatShare).toBeLessThan(0.05);
    expect(r.passed).toBe(true);
  });

  test('a repeating 8-pixel column pattern is caught', () => {
    const a = pixels(512, 256, () => [120, 130, 140]);
    const b = Buffer.from(a);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 512; x++) {
        const shift = Math.floor(x / 8) % 2 ? 6 : -6;
        const i = (y * 512 + x) * 4;
        b[i] = b[i]! + shift; b[i + 1] = b[i + 1]! + shift; b[i + 2] = b[i + 2]! + shift;
      }
    }
    const r = measureClarity(a, b, 512, 256);
    expect(r.passed).toBe(false);
    expect(r.failed).toContain('grid');
  });

  test('limits can be tightened by environment and are read each time', () => {
    process.env['CLARITY_MIN_PSNR_DB'] = '60';
    try {
      expect(clarityThresholds().minPsnrDb).toBe(60);
    } finally {
      delete process.env['CLARITY_MIN_PSNR_DB'];
    }
    expect(clarityThresholds().minPsnrDb).toBe(36);
  });
});

describe('the delivery gate never ships a visible mark', () => {
  afterEach(() => { delete process.env['CLARITY_MIN_PSNR_DB']; });

  test.each(SAMPLES)('%s: either clear by independent measurement, or no pixel mark', async (_name, make) => {
    const rgba = pixels(W, H, make);
    const original = await png(rgba, W, H);
    const out = await embedRobustProvenanceWatermark({ buffer: original, mimeType: 'image/png', vaultId: 'vault-gate', dnaRecordId: 'dna-gate' });

    if (!out.embedded) {
      // No invisible strength existed: the original bytes come back, untouched.
      expect(Buffer.compare(out.buffer, original)).toBe(0);
      // Either no strength was invisible, or the only invisible one was too faint to read.
      expect(out.clarity?.passed === false || out.method.includes('too faint')).toBe(true);
      expect(out.method).toContain('clarity-gate');
      return;
    }
    expect(out.clarity?.passed).toBe(true);
    // Re-measure from the delivered file itself, not from the gate's own numbers.
    const delivered = await sharp(out.buffer).ensureAlpha().raw().toBuffer();
    const again = measureClarity(rgba, delivered, W, H);
    expect(again.passed).toBe(true);
    expect(again.psnrDb).toBeGreaterThanOrEqual(36);
    // And the mark is still readable.
    expect(await extractWatermarkLookupId(out.buffer)).toBe(LOOKUP);
  }, SLOW);

  test('a flat image is never marked visibly: the visible check refuses the mark and the original bytes go out (2026-11-20)', async () => {
    // This test used to require a flat image to BE marked. That is how the dotted grid reached shared links and downloads:
    // on a flat or smooth area every strength of the current mark shows. Now the gate must refuse it.
    const original = await png(pixels(W, H, SAMPLES[0]![1]), W, H);
    const flat = await embedRobustProvenanceWatermark({ buffer: original, mimeType: 'image/png', vaultId: 'vault-gate', dnaRecordId: 'dna-gate' });
    if (flat.embedded) {
      const delivered = await sharp(flat.buffer).ensureAlpha().raw().toBuffer();
      expect(measureClarity(pixels(W, H, SAMPLES[0]![1]), delivered, W, H).failed).not.toContain('visible');
    } else {
      expect(flat.method).toContain('clarity-gate');
      expect(Buffer.compare(flat.buffer, original)).toBe(0);
    }
  }, SLOW);

  test('if the limits cannot be met, the file is delivered with no pixel mark and the original bytes', async () => {
    process.env['CLARITY_MIN_PSNR_DB'] = '70';
    const original = await png(pixels(W, H, SAMPLES[0]![1]), W, H);
    const out = await embedRobustProvenanceWatermark({ buffer: original, mimeType: 'image/png', vaultId: 'vault-gate', dnaRecordId: 'dna-gate' });
    expect(out.embedded).toBe(false);
    expect(out.method).toContain('clarity-gate');
    expect(Buffer.compare(out.buffer, original)).toBe(0);
    expect(await extractWatermarkLookupId(out.buffer)).toBeNull();
  }, SLOW);

  test('every strength is measured, strongest first, and weaker strengths always look cleaner', () => {
    const rgba = pixels(W, H, SAMPLES[0]![1]);
    const all = measureEveryCropStrength(rgba, W, H, LOOKUP);
    expect(all.map((a) => a.rung)).toEqual([
      'full', 'balanced', 'gentle', 'light', 'main-mark-only', 'soft+crop', 'main-soft', 'faint+crop', 'main-faint',
    ]);
    const psnr = (rung: string) => all.find((a) => a.rung === rung)!.report.psnrDb;
    // Within each family, every weaker strength looks cleaner.
    for (const family of [
      ['full', 'balanced', 'gentle', 'light', 'main-mark-only', 'main-soft', 'main-faint'],
      ['light', 'soft+crop', 'faint+crop'],
    ]) {
      for (let i = 1; i < family.length; i++) expect(psnr(family[i]!)).toBeGreaterThanOrEqual(psnr(family[i - 1]!) - 0.01);
    }
    // A softened main mark with its crop copy is never cleaner than the same main mark alone (the crop copy costs
    // a little), so the ladder offers the crop copy first and the mark alone only if that still shows.
    expect(psnr('soft+crop')).toBeLessThanOrEqual(psnr('main-soft') + 0.01);
    expect(psnr('faint+crop')).toBeLessThanOrEqual(psnr('main-faint') + 0.01);
  }, SLOW);
});
