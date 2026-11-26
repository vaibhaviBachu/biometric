/** A share link's code is written into a delivered picture without changing a single pixel. */
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
import { tagImageFile, readImageTagCode } from '../../src/lib/image-tag';

const raw = async (b: Buffer) => (await sharp(b).raw().toBuffer({ resolveWithObject: true }));

async function sample(format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  return format === 'jpeg' ? base.jpeg({ quality: 90 }).toBuffer() : format === 'webp' ? base.webp({ quality: 80 }).toBuffer() : base.png().toBuffer();
}

describe('tagImageFile', () => {
  test.each(['jpeg', 'png', 'webp'] as const)('%s: the code is readable and the pixels are identical', async (format) => {
    const original = await sample(format);
    const tagged = tagImageFile(original, 'PINIT-DNA:WM-AB23-XY78');
    expect(tagged).not.toBeNull();
    expect(tagged!.length).toBeGreaterThan(original.length);
    expect(readImageTagCode(tagged!)).toBe('WM-AB23-XY78');
    const [a, b] = await Promise.all([raw(original), raw(tagged!)]);
    expect(b.info).toEqual(a.info);
    expect(b.data.equals(a.data)).toBe(true);
  });

  test('a JPEG keeps its leading application segments first and stays a valid file', async () => {
    const withExif = await sharp(await sample('jpeg')).withExif({ IFD0: { Copyright: 'x' } }).jpeg().toBuffer();
    const tagged = tagImageFile(withExif, 'PINIT-DNA:WM-AB23-XY78')!;
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    expect(tagged.indexOf(Buffer.from([0xff, 0xfe]))).toBeGreaterThan(tagged.indexOf(Buffer.from('Exif')));
  });

  test('a large WebP still reads its code from the end of the file, and its RIFF size stays right', async () => {
    const big = await sharp({ create: { width: 900, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).webp({ quality: 95 }).toBuffer();
    expect(big.length).toBeGreaterThan(256 * 1024);
    const tagged = tagImageFile(big, 'PINIT-DNA:WM-AB23-XY78')!;
    expect(tagged.readUInt32LE(4) + 8).toBe(tagged.length);
    expect(readImageTagCode(tagged)).toBe('WM-AB23-XY78');
    expect((await raw(tagged)).data.equals((await raw(big)).data)).toBe(true);
  });

  test.each(['gif', 'tiff', 'avif'] as const)('%s: any other picture format carries the code too, pixels unchanged', async (format) => {
    const base = sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 90, b: 200 } } });
    const original = await (format === 'gif' ? base.gif() : format === 'tiff' ? base.tiff() : base.avif()).toBuffer();
    const tagged = tagImageFile(original, 'PINIT-DNA:WM-AB23-XY78');
    expect(tagged).not.toBeNull();
    expect(readImageTagCode(tagged!)).toBe('WM-AB23-XY78');
    expect((await raw(tagged!)).data.equals((await raw(original)).data)).toBe(true);
  });

  test('text that is not plain is left alone', async () => {
    expect(tagImageFile(await sample('jpeg'), 'bad\ntext')).toBeNull();
    expect(readImageTagCode(await sample('webp'))).toBeNull();
  });

  test('a file without the code, or with a malformed one, reads as nothing', async () => {
    expect(readImageTagCode(await sample('jpeg'))).toBeNull();
    expect(readImageTagCode(Buffer.from('PINIT-DNA:WM-short'))).toBeNull();
  });
});
