import { describe, test, expect } from '@jest/globals';
import crypto from 'crypto';
import sharp from 'sharp';
import {
  ANALYSIS_KEEP_BYTES, ANALYSIS_MAX_SIDE, prepareAnalysisCopy,
} from '../../src/services/forensics/analysis-copy';

/** Photo-like noise: compresses poorly, like a real camera original. */
async function photo(width: number, height: number, quality = 92, orientation?: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let s = 12345;
  for (let i = 0; i < raw.length; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    raw[i] = (s >>> 24) & 0xff;
  }
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (orientation) img = img.withMetadata({ orientation });
  return img.jpeg({ quality }).toBuffer();
}

describe('analysis copy', () => {
  test('a small image is returned untouched, as the very same buffer', async () => {
    const small = await photo(800, 600);
    expect(small.length).toBeLessThan(ANALYSIS_KEEP_BYTES);
    const out = await prepareAnalysisCopy(small, 'image/jpeg');
    expect(out.reduced).toBe(false);
    expect(out.buffer).toBe(small);
    expect(out.mimeType).toBe('image/jpeg');
  });

  test('a large camera original becomes a smaller upright JPEG, and the original is not changed', async () => {
    const big = await photo(6000, 4000);
    const before = Buffer.from(big);
    const out = await prepareAnalysisCopy(big, 'image/jpeg');
    expect(out.reduced).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(ANALYSIS_MAX_SIDE);
    expect(meta.width! / meta.height!).toBeCloseTo(6000 / 4000, 1);
    expect(out.buffer.length).toBeLessThan(big.length / 3);
    expect(out.originalWidth).toBe(6000);
    expect(big.equals(before)).toBe(true); // the input bytes were never touched
  }, 120000);

  test('a heavy file with modest dimensions is reduced too', async () => {
    const heavy = await sharp(crypto.randomBytes(2000 * 2000 * 3), { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    expect(heavy.length).toBeGreaterThan(ANALYSIS_KEEP_BYTES);
    const out = await prepareAnalysisCopy(heavy, 'image/png');
    expect(out.reduced).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');
  }, 120000);

  test('the camera orientation tag is applied, so the copy is upright', async () => {
    const tagged = await photo(4000, 3000, 90, 6); // stored sideways, tag says rotate a quarter turn
    const out = await prepareAnalysisCopy(tagged, 'image/jpeg');
    expect(out.reduced).toBe(true);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!); // portrait after rotation
  }, 120000);

  test('anything that cannot be decoded, or is not an image, is handed back unchanged', async () => {
    const junk = Buffer.from('this is not an image');
    expect((await prepareAnalysisCopy(junk, 'image/jpeg')).buffer).toBe(junk);
    expect((await prepareAnalysisCopy(junk, 'image/jpeg')).reduced).toBe(false);
    const pdf = Buffer.from('%PDF-1.4');
    expect((await prepareAnalysisCopy(pdf, 'application/pdf')).buffer).toBe(pdf);
  });
});
