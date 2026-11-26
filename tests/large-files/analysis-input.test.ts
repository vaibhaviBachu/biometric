import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  SAMPLE_HEAD_BYTES,
  SAMPLE_MAX_BYTES,
  SAMPLE_TAIL_BYTES,
  SAMPLE_WINDOWS,
  SAMPLE_WINDOW_BYTES,
  buildAnalysisInput,
  readSampledSegments,
  samplePlan,
} from '../../src/services/large-files/analysis-input';

const MiB = 1024 * 1024;
let dir: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'analysis-input-'));
});
afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('sample plan', () => {
  it('takes a small file whole', () => {
    expect(samplePlan(0)).toEqual([]);
    expect(samplePlan(1000)).toEqual([{ offset: 0, length: 1000 }]);
    expect(samplePlan(SAMPLE_MAX_BYTES)).toEqual([{ offset: 0, length: SAMPLE_MAX_BYTES }]);
  });

  it('is head, evenly spaced windows and tail, ordered, non-overlapping and bounded for any large size', () => {
    for (const size of [SAMPLE_MAX_BYTES + 1, 300 * MiB, 7 * 1024 * MiB + 12345, 64 * 1024 * MiB]) {
      const plan = samplePlan(size);
      expect(plan).toHaveLength(SAMPLE_WINDOWS + 2);
      expect(plan[0]).toEqual({ offset: 0, length: SAMPLE_HEAD_BYTES });
      expect(plan[plan.length - 1]).toEqual({ offset: size - SAMPLE_TAIL_BYTES, length: SAMPLE_TAIL_BYTES });
      plan.slice(1, -1).forEach((p) => expect(p.length).toBe(SAMPLE_WINDOW_BYTES));
      for (let i = 1; i < plan.length; i++) expect(plan[i]!.offset).toBeGreaterThanOrEqual(plan[i - 1]!.offset + plan[i - 1]!.length);
      expect(plan.reduce((s, p) => s + p.length, 0)).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
      expect(samplePlan(size)).toEqual(plan); // depends only on the size
    }
  });
});

describe('sampled segments', () => {
  it('reads exactly the planned bytes and hashes each segment', async () => {
    const size = SAMPLE_MAX_BYTES + 5 * MiB + 3;
    const data = crypto.randomBytes(size);
    const file = path.join(dir, 'random.bin');
    await fs.promises.writeFile(file, data);
    const { buffer, segments } = await readSampledSegments(file, size);
    const expected = Buffer.concat(samplePlan(size).map((p) => data.subarray(p.offset, p.offset + p.length)));
    expect(buffer.equals(expected)).toBe(true);
    for (const s of segments) {
      expect(s.sha256).toBe(crypto.createHash('sha256').update(data.subarray(s.offset, s.offset + s.length)).digest('hex'));
    }
    // Magic bytes stay first, the tail stays last.
    expect(buffer.subarray(0, 16).equals(data.subarray(0, 16))).toBe(true);
    expect(buffer.subarray(buffer.length - 16).equals(data.subarray(size - 16))).toBe(true);
  });

  it('builds a sampled analysis input for a large non-image file', async () => {
    const size = SAMPLE_MAX_BYTES + 1;
    const file = path.join(dir, 'video.bin');
    await fs.promises.writeFile(file, crypto.randomBytes(size));
    const input = await buildAnalysisInput(file, size, 'video/mp4', { maxPixels: 1e9 });
    expect(input.mode).toBe('SAMPLED_SEGMENTS');
    expect(input.mimeType).toBe('video/mp4');
    expect(input.buffer.length).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
    expect(input.segments).toHaveLength(SAMPLE_WINDOWS + 2);
  });
});

describe('image analysis copy', () => {
  it('decodes a large image from its path into a reduced JPEG copy', async () => {
    const file = path.join(dir, 'big.png');
    await sharp({ create: { width: 6000, height: 3000, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toFile(file);
    const { size } = await fs.promises.stat(file);
    const input = await buildAnalysisInput(file, size, 'image/png', { maxPixels: 1e9 });
    expect(input.mode).toBe('IMAGE_REDUCED_COPY');
    expect(input.mimeType).toBe('image/jpeg');
    expect(input.originalWidth).toBe(6000);
    const meta = await sharp(input.buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2400);
  });

  it('falls back to samples when the image is over the pixel guard', async () => {
    const file = path.join(dir, 'guarded.png');
    await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#888' } }).png().toFile(file);
    const { size } = await fs.promises.stat(file);
    const input = await buildAnalysisInput(file, size, 'image/png', { maxPixels: 1_000_000 });
    expect(input.mode).toBe('WHOLE_FILE'); // small enough to sample whole; still never decoded
    expect(input.mimeType).toBe('image/png');
  });
});
