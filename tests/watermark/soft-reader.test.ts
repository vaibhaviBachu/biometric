/**
 * Step C: the soft-decision reader. It must find more of the marks that are
 * really there (harsher degradations, crops cut anywhere), find the marks of
 * every earlier version, and never report a mark that is not there.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the mark on for this test of its mechanics
import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  embedRobustProvenanceWatermark,
  extractWatermarkLookupId,
  extractWatermarkMatch,
  measureMainMarkEvidence,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';

const SLOW = 600_000;
const LOOKUP = watermarkLookupId('vault-soft', 'dna-soft');

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

async function scene(kind: 'sky' | 'texture' | 'gradient' | 'stripes', seed: number, W = 1280, H = 960): Promise<Buffer> {
  const rnd = rng(seed);
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let c: [number, number, number];
      if (kind === 'sky') {
        const sky = y < H * 0.6;
        const d = x > W * 0.3 && x < W * 0.7 && y > H * 0.2;
        c = d ? [168, 28, 42] : sky ? [190, 205, 225] : [100, 90, 80];
      } else if (kind === 'gradient') {
        c = [60 + (x / W) * 150, 90 + (y / H) * 100, 160 - (x / W) * 60];
      } else if (kind === 'stripes') {
        const v = x % 40 < 20 ? 200 : 60;
        c = [v + (rnd() - 0.5) * 8, v * 0.8, 255 - v];
      } else {
        const v = 128 + 90 * Math.sin(x / (60 + (seed % 40))) * Math.cos(y / (50 + (seed % 30)));
        c = [v + (rnd() - 0.5) * 12, v * 0.8 + 40 * Math.cos(y / 130) + (rnd() - 0.5) * 12, 255 - v + 30 * Math.sin((x + y) / 160) + (rnd() - 0.5) * 12];
      }
      raw[i] = Math.max(0, Math.min(255, c[0]));
      raw[i + 1] = Math.max(0, Math.min(255, c[1]));
      raw[i + 2] = Math.max(0, Math.min(255, c[2]));
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

describe('the soft reader never reports a mark that is not there', () => {
  test('pictures with no mark, including gradients and stripes that lean every tile the same way', async () => {
    const pictures: Array<[string, Buffer]> = [];
    for (const kind of ['sky', 'texture', 'gradient', 'stripes'] as const) {
      pictures.push([kind, await scene(kind, 5)]);
    }
    for (const [name, png] of pictures) {
      const variants: Buffer[] = [
        png,
        await sharp(png).jpeg({ quality: 75 }).toBuffer(),
        await sharp(png).jpeg({ quality: 20 }).toBuffer(),
        await sharp(png).resize(640).png().toBuffer(),
        await sharp(png).extract({ left: 117, top: 63, width: 640, height: 600 }).png().toBuffer(),
      ];
      for (const v of variants) {
        expect({ name, found: await extractWatermarkMatch(v) }).toEqual({ name, found: null });
      }
      // The evidence score stays well below the level a real mark reaches (0.5 even at JPEG quality 5).
      expect(await measureMainMarkEvidence(png)).toBeLessThan(0.4);
    }
  }, SLOW);

  test('a mark belonging to a different asset is read as that asset, never as another', async () => {
    const src = await scene('sky', 1);
    const other = await embedRobustProvenanceWatermark({ buffer: src, mimeType: 'image/png', vaultId: 'vault-other', dnaRecordId: 'dna-other' });
    expect(await extractWatermarkLookupId(other.buffer)).toBe(watermarkLookupId('vault-other', 'dna-other'));
    expect(await extractWatermarkLookupId(other.buffer)).not.toBe(LOOKUP);
  }, SLOW);
});

describe('the soft reader finds marks the first reader gave up on', () => {
  test('harsher compression and stacked degradations on a protected picture', async () => {
    const src = await scene('texture', 11);
    const marked = await embedRobustProvenanceWatermark({ buffer: src, mimeType: 'image/png', vaultId: 'vault-soft', dnaRecordId: 'dna-soft' });
    expect(marked.embedded).toBe(true);
    const cases: Array<[string, (b: Buffer) => Promise<Buffer>]> = [
      ['JPEG q20', (b) => sharp(b).jpeg({ quality: 20 }).toBuffer()],
      ['JPEG q10', (b) => sharp(b).jpeg({ quality: 10 }).toBuffer()],
      ['25%', (b) => sharp(b).resize(320).png().toBuffer()],
      ['60% + blur + JPEG 70', async (b) => sharp(await sharp(b).resize(768).blur(1).toBuffer()).jpeg({ quality: 70 }).toBuffer()],
      ['50% + JPEG 50', async (b) => sharp(await sharp(b).resize(640).toBuffer()).jpeg({ quality: 50 }).toBuffer()],
      ['WhatsApp-like (1080 wide, JPEG 75)', (b) => sharp(b).resize(1080).jpeg({ quality: 75 }).toBuffer()],
    ];
    const read: Record<string, boolean> = {};
    for (const [name, f] of cases) read[name] = (await extractWatermarkLookupId(await f(marked.buffer))) === LOOKUP;
    // Measured 2026-10-13: all of these read with the soft reader. The first reader lost JPEG q10,
    // 60% + blur + JPEG 70 and 50% + JPEG 50 on pictures like this one.
    expect(read).toEqual({
      'JPEG q20': true,
      'JPEG q10': true,
      '25%': true,
      '60% + blur + JPEG 70': true,
      '50% + JPEG 50': true,
      'WhatsApp-like (1080 wide, JPEG 75)': true,
    });
  }, SLOW);

  test('a copy marked by an earlier version (fixed crop step, already shared) still reads, also after compression', async () => {
    const old = fs.readFileSync(path.join(__dirname, 'fixtures', 'old-crop-style-768.png'));
    const oldLookup = watermarkLookupId('vault-fixture', 'dna-fixture');
    expect(await extractWatermarkLookupId(old)).toBe(oldLookup);
    expect(await extractWatermarkLookupId(await sharp(old).jpeg({ quality: 40 }).toBuffer())).toBe(oldLookup);
    expect(await extractWatermarkLookupId(await sharp(old).resize(480).jpeg({ quality: 60 }).toBuffer())).toBe(oldLookup);
  }, SLOW);

  // Measured 2026-10-13 on four pictures and six crops each, read at PNG and after JPEG 50: the first reader
  // found 0 of 24 (it only looked at crops whose edge fell on an 8-pixel boundary), this reader found 17 of 24.
  // What it cannot read: a crop too small to hold a whole 256-pixel block, and a block that contains a hard
  // edge (the picture itself then overrules the mark in those tiles). The crops below read on all four pictures.
  test('a crop cut at an arbitrary position (not aligned to anything) that holds a whole clean block reads, also after JPEG', async () => {
    const src = await scene('sky', 1);
    const marked = await embedRobustProvenanceWatermark({ buffer: src, mimeType: 'image/png', vaultId: 'vault-soft', dnaRecordId: 'dna-soft' });
    expect(['full', 'balanced', 'gentle', 'light', 'soft+crop', 'faint+crop']).toContain(marked.clarity?.rung);
    for (const [left, top, width, height] of [[97, 41, 700, 500], [333, 101, 600, 560], [503, 333, 400, 300]] as const) {
      const crop = await sharp(marked.buffer).extract({ left, top, width, height }).png().toBuffer();
      expect(await extractWatermarkLookupId(crop)).toBe(LOOKUP);
      expect(await extractWatermarkLookupId(await sharp(crop).jpeg({ quality: 50 }).toBuffer())).toBe(LOOKUP);
    }
  }, SLOW);
});
