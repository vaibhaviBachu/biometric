import './helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
import { embedRobustProvenanceWatermark, extractWatermarkLookupId } from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';
import { protectedFileProperties, publicVerifyUrl, VERIFY_ID_PATTERN } from '../../src/services/dna-vnext/verify-link';

const SLOW = 120_000;

async function photo(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = 90 + 80 * Math.sin(x / 37) + 30 * Math.cos(y / 53);
      raw[i + 1] = 110 + 70 * Math.cos(x / 61 + y / 90);
      raw[i + 2] = 130 + 60 * Math.sin((x + y) / 71);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('verify link in the file properties', () => {
  test('the properties carry only the link and a notice, never owner details', () => {
    const id = 'a1b2c3d4e5f60718';
    const props = protectedFileProperties(id);
    expect(VERIFY_ID_PATTERN.test(id)).toBe(true);
    expect(props.IFD0.ImageDescription).toContain(publicVerifyUrl(id));
    expect(publicVerifyUrl(id)).toMatch(/\/scan\?id=a1b2c3d4e5f60718$/);
    expect(JSON.stringify(props)).not.toMatch(/@|owner|email|vault|dna/i);
  });

  test.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
  ])('a protected %s copy carries the link and the mark still reads', async (mimeType, format) => {
    const source = await photo(800, 600);
    const input = format === 'png' ? source : await sharp(source).jpeg({ quality: 95 }).toBuffer();
    const out = await embedRobustProvenanceWatermark({
      buffer: input,
      mimeType,
      vaultId: 'vault-link-test',
      dnaRecordId: 'dna-link-test',
    });
    expect(out.embedded).toBe(true);
    const lookup = watermarkLookupId('vault-link-test', 'dna-link-test');
    expect(out.lookupId).toBe(lookup);

    const meta = await sharp(out.buffer).metadata();
    const text = (meta.exif ?? Buffer.alloc(0)).toString('latin1');
    expect(text).toContain('Protected by PINIT');
    expect(text).toContain(`/scan?id=${lookup}`);

    // The link is the properties only: the hidden mark is unaffected.
    expect(await extractWatermarkLookupId(out.buffer)).toBe(lookup);
    // Size and format are unchanged.
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe(format);
  }, SLOW);
});
