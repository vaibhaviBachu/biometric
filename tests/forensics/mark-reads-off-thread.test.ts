/**
 * The hidden-mark reads a Trace makes are seconds of plain arithmetic per picture. They ran on the main thread
 * (recoverRobustProvenanceWatermark → extractWatermarkMatch, and the older DCT read), freezing the server for 1–2 s per call
 * locally and up to 7.5 s under load (2026-11-17 profiles; 8.4 s in the production log). They now run in a worker thread
 * and give the same answers; the robust read is done once per investigation for the same picture.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import sharp from 'sharp';
import { performance } from 'perf_hooks';

jest.setTimeout(300_000);

import * as forensicWorkers from '../../src/services/forensics/forensic-workers';
import { forensicWorkerPool, readDctMark, readMark } from '../../src/services/forensics/forensic-workers';
import { embedImageDctWatermark, extractImageDctWatermark } from '../../src/services/watermark/phase3/image-dct-watermark';
import * as robustWatermark from '../../src/services/dna-vnext/robust-watermark';
import { withRetrievalCache } from '../../src/services/vault/investigation-retrieval-cache';
import { dnaVnextConfig } from '../../src/config/dna-vnext';

/** A busy picture (the kind the crop search works hardest on). */
async function picture(width: number, height: number, seed = 5): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 60 + rnd() * 120;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function dctMarked(payload: string): Promise<Buffer> {
  const { data, info } = await sharp(await picture(640, 480)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const marked = embedImageDctWatermark(data, info.width, info.height, payload);
  return sharp(marked, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Runs `fn` while a 10 ms timer ticks: the longest the main thread was kept from answering. */
async function longestStall<T>(fn: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let longest = 0; let last = performance.now();
  const t = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 10); last = now; }, 10);
  try { const value = await fn(); longest = Math.max(longest, performance.now() - last - 10); return { value, stallMs: Math.round(longest) }; }
  finally { clearInterval(t); }
}

const SERVER_KEY = dnaVnextConfig.secret;
beforeAll(() => { process.env['FORENSIC_WORKERS'] = 'on'; process.env['DNA_VNEXT_SECRET'] = SERVER_KEY; });
afterEach(() => { jest.restoreAllMocks(); });
afterAll(async () => { process.env['FORENSIC_WORKERS'] = 'off'; await forensicWorkerPool.close(); });

describe('the older DCT mark read', () => {
  test('in a worker: the same text as on the main thread, for a marked and an unmarked picture', async () => {
    for (const buffer of [await dctMarked('PINIT-IDT|abc123'), await picture(640, 480, 9)]) {
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const onMain = extractImageDctWatermark(data, info.width, info.height) ?? null;
      expect(await readDctMark(buffer)).toBe(onMain);
    }
  });
});

describe('the robust mark read used by recovery', () => {
  test('runs through the worker path (readMark), never extractWatermarkMatch on the main thread', async () => {
    const viaWorker = jest.spyOn(forensicWorkers, 'readMark');
    const onMain = jest.spyOn(robustWatermark, 'extractWatermarkMatch');
    await robustWatermark.recoverRobustProvenanceWatermark({ buffer: await picture(800, 600), mimeType: 'image/png', ownerUserId: 'owner' });
    expect(viaWorker).toHaveBeenCalledTimes(1);
    expect(onMain).not.toHaveBeenCalled();
  });

  test('read once per investigation for the same picture (the orchestrator asks more than once)', async () => {
    const viaWorker = jest.spyOn(forensicWorkers, 'readMark');
    const buffer = await picture(800, 600, 13);
    await withRetrievalCache(async () => {
      await robustWatermark.recoverRobustProvenanceWatermark({ buffer, mimeType: 'image/png', ownerUserId: 'owner' });
      await robustWatermark.recoverRobustProvenanceWatermark({ buffer, mimeType: 'image/png', ownerUserId: 'owner' });
    });
    expect(viaWorker).toHaveBeenCalledTimes(1);
  });

  test('the main thread keeps answering during the read (against the same read on the main thread)', async () => {
    const buffer = await picture(1600, 1200, 21);
    await readMark(await picture(200, 150)); // start the worker outside the measurement
    const inWorker = await longestStall(() => readMark(buffer));
    const onMain = await longestStall(async () => { await new Promise((r) => setTimeout(r, 30)); return robustWatermark.extractWatermarkMatch(buffer); });
    // eslint-disable-next-line no-console
    console.log(`[mark-read] 1600x1200: longest stall in worker ${inWorker.stallMs} ms, on the main thread ${onMain.stallMs} ms`);
    expect(inWorker.value).toEqual(onMain.value);
    expect(inWorker.stallMs).toBeLessThan(250);
    expect(onMain.stallMs).toBeGreaterThan(inWorker.stallMs);
  });
});
