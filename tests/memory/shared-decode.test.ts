import sharp from 'sharp';
import { decodeRgb, withSharedDecode } from '../../src/lib/shared-decode';

async function image(width = 320, height = 240, alpha = false): Promise<Buffer> {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + (i >> 5)) & 255;
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe('shared decode', () => {
  test('callers inside one scope share a single decode', async () => {
    const buf = await image();
    const [a, b, c] = await withSharedDecode(buf, async () => Promise.all([decodeRgb(buf), decodeRgb(buf), decodeRgb(buf)]));
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.data.length).toBe(320 * 240 * 3);
  });

  test('the shared decode is exactly what each layer decoded for itself, alpha dropped', async () => {
    for (const alpha of [false, true]) {
      const buf = await image(200, 150, alpha);
      const direct = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const shared = await withSharedDecode(buf, async () => decodeRgb(buf));
      expect(Buffer.compare(shared.data, direct.data)).toBe(0);
      expect(shared.info).toEqual(direct.info);
    }
  });

  test('outside a scope each call decodes on its own', async () => {
    const buf = await image();
    const [a, b] = await Promise.all([decodeRgb(buf), decodeRgb(buf)]);
    expect(b).not.toBe(a);
    expect(Buffer.compare(a.data, b.data)).toBe(0);
  });

  test('is dropped when the scope ends, and a different buffer is never shared', async () => {
    const buf = await image();
    const other = await image(100, 100);
    let inside: Awaited<ReturnType<typeof decodeRgb>> | undefined;
    await withSharedDecode(buf, async () => {
      inside = await decodeRgb(buf);
      const different = await decodeRgb(other);
      expect(different.info.width).toBe(100);
    });
    const after = await decodeRgb(buf);
    expect(after).not.toBe(inside);
    expect(Buffer.compare(after.data, inside!.data)).toBe(0);
  });

  test('a decode that fails reaches every caller and does not poison the next scope', async () => {
    const bad = Buffer.from('not an image');
    const results = await withSharedDecode(bad, async () =>
      Promise.allSettled([decodeRgb(bad), decodeRgb(bad)]));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const good = await image();
    expect((await withSharedDecode(good, async () => decodeRgb(good))).info.width).toBe(320);
  });

  test('can be switched off', async () => {
    process.env['SHARED_DECODE'] = 'off';
    try {
      const buf = await image();
      const [a, b] = await withSharedDecode(buf, async () => Promise.all([decodeRgb(buf), decodeRgb(buf)]));
      expect(b).not.toBe(a);
    } finally {
      delete process.env['SHARED_DECODE'];
    }
  });
});
