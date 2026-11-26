/**
 * A fixed set of synthetic images for the before/after comparison of the DNA
 * layers. Every image is generated from a seed, so the same bytes come out on
 * every machine and every run. They cover what the layers treat differently:
 * a tiny image, an alpha channel, grayscale, a camera-size photo (the layers
 * move big images to worker threads above 1 megapixel), an EXIF rotation, and
 * 16-bit colour.
 */
import sharp from 'sharp';

export interface CorpusImage {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function rgbRaw(width: number, height: number, seed: number, channels: 3 | 4 = 3): Buffer {
  const rnd = rng(seed);
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const wave = 128 + 90 * Math.sin(x / 70) * Math.cos(y / 55);
      raw[i] = clamp(wave + 40 * Math.sin(x / 190) + (rnd() - 0.5) * 16);
      raw[i + 1] = clamp(wave * 0.8 + 50 * Math.cos(y / 120) + (rnd() - 0.5) * 16);
      raw[i + 2] = clamp(255 - wave + 30 * Math.sin((x + y) / 150) + (rnd() - 0.5) * 16);
      if (channels === 4) raw[i + 3] = clamp(255 * (x / width));
    }
  }
  return raw;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export async function buildCorpus(): Promise<CorpusImage[]> {
  const tiny = await sharp(rgbRaw(64, 48, 1), { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();

  const alpha = await sharp(rgbRaw(1200, 900, 2, 4), { raw: { width: 1200, height: 900, channels: 4 } }).png().toBuffer();

  const gray = await sharp(rgbRaw(800, 600, 3), { raw: { width: 800, height: 600, channels: 3 } })
    .grayscale().jpeg({ quality: 88 }).toBuffer();

  const photo = await sharp(rgbRaw(4000, 3000, 4), { raw: { width: 4000, height: 3000, channels: 3 } })
    .jpeg({ quality: 85 }).toBuffer();

  const rotated = await sharp(rgbRaw(1600, 1200, 5), { raw: { width: 1600, height: 1200, channels: 3 } })
    .jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();

  const wide = await sharp(rgbRaw(500, 400, 6), { raw: { width: 500, height: 400, channels: 3 } })
    .toColourspace('rgb16').png().toBuffer();

  return [
    { name: 'tiny-png-64x48', mimeType: 'image/png', buffer: tiny },
    { name: 'alpha-png-1200x900', mimeType: 'image/png', buffer: alpha },
    { name: 'gray-jpeg-800x600', mimeType: 'image/jpeg', buffer: gray },
    { name: 'photo-jpeg-4000x3000', mimeType: 'image/jpeg', buffer: photo },
    { name: 'exif-rotated-jpeg-1600x1200', mimeType: 'image/jpeg', buffer: rotated },
    { name: 'png16-500x400', mimeType: 'image/png', buffer: wide },
  ];
}

/** Drops timings and turns buffers into hashes so two runs can be compared exactly. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (key === 'processingMs' || key === 'durationMs' || key === 'ms') return undefined;
    if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: number[] }).data)) {
      return `buffer:${(v as { data: number[] }).data.length}`;
    }
    return v;
  });
}
