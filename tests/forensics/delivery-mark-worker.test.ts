/**
 * The delivery mark (the mark written into a shared or downloaded picture) in a real worker thread.
 *
 * The search for a mark strength is seconds of plain arithmetic on a large photo. On the main thread it stopped the whole server
 * (9 to 15 s in the production log of 2026-11-11). In a worker: the same bytes come out, the main thread keeps answering, and a
 * worker that cannot finish is never replaced by doing the work on the main thread.
 */
import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import crypto from 'crypto';
import sharp from 'sharp';
import { performance } from 'perf_hooks';
import { forensicWorkerPool, markDeliveryCopyOffThread, poisonInputs } from '../../src/services/forensics/forensic-workers';
import * as robustWatermark from '../../src/services/dna-vnext/robust-watermark';
import { watermarkRecipientLookupId } from '../../src/services/dna-vnext/crypto';
import { WorkerWorkFailedError } from '../../src/lib/worker-failure';
import { dnaVnextConfig } from '../../src/config/dna-vnext';

jest.setTimeout(180_000);

const VAULT = 'vault-worker-mark';
const DNA = 'dna-worker-mark';

/** A smooth picture: the faintest mark is invisible on it, so it gets marked. */
async function gradient(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = 40 + (180 * x) / width;
      raw[i + 1] = 60 + (150 * y) / height;
      raw[i + 2] = 200 - (120 * x) / width;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Coarse noise: every strength of the mark shows on it, so no mark is written (the slowest case: all strengths are tried). */
async function noise(width: number, height: number, seed = 7): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const v = 128 + (rnd() - 0.5) * 120;
    raw[i * 3] = v; raw[i * 3 + 1] = v; raw[i * 3 + 2] = v;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Runs `fn` while a 10 ms timer ticks; returns its result and the longest the timer was kept waiting (the event-loop stall). */
async function withStallMeter<T>(fn: () => Promise<T>): Promise<{ value: T; longestStallMs: number; ms: number }> {
  let longest = 0;
  let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 10); last = now; }, 10);
  const started = performance.now();
  try {
    const value = await fn();
    // A block that lasted until the very end is seen only here (the timer never got to run after it).
    longest = Math.max(longest, performance.now() - last - 10);
    return { value, longestStallMs: Math.round(longest), ms: Math.round(performance.now() - started) };
  } finally {
    clearInterval(ticker);
  }
}

// A worker gets a copy of this process's environment when it starts. Jest's own process may not have loaded the project's .env
// before the mark key was read, so the key this process uses is handed to the workers explicitly (as the server's environment
// would be in production).
const SERVER_KEY = dnaVnextConfig.secret;
beforeAll(() => { process.env['FORENSIC_WORKERS'] = 'on'; process.env['DNA_VNEXT_SECRET'] = SERVER_KEY; });
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env['DELIVERY_MARK_TIMEOUT_MS'];
  poisonInputs.clear();
});
afterAll(async () => { process.env['FORENSIC_WORKERS'] = 'off'; await forensicWorkerPool.close(); });

describe('the delivery mark in a worker thread', () => {
  test('writes exactly the bytes the main thread writes, and the copy reads back as that recipient', async () => {
    const buffer = await gradient(1400, 1000);
    const params = { buffer, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-a' };
    const inWorker = await markDeliveryCopyOffThread(params);
    const onMain = await robustWatermark.markDeliveryCopy(params);
    expect(inWorker.embedded).toBe(true);
    expect(inWorker.clarity?.rung).toBe(onMain.clarity?.rung);
    expect(inWorker.lookupId).toBe(onMain.lookupId);
    expect(Buffer.isBuffer(inWorker.buffer)).toBe(true);
    expect(Buffer.compare(inWorker.buffer, onMain.buffer)).toBe(0);
    const hit = await robustWatermark.extractWatermarkMatch(inWorker.buffer);
    expect(hit?.lookupId).toBe(watermarkRecipientLookupId(VAULT, DNA, 'recipient-a'));
  });

  test('a picture no strength suits: the same ruling as the main thread, the caller\'s own original bytes, held for every recipient', async () => {
    const buffer = await noise(1000, 800);
    const params = { buffer, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-b' };
    const inWorker = await markDeliveryCopyOffThread(params);
    const onMain = await robustWatermark.markDeliveryCopy(params);
    expect(inWorker.embedded).toBe(false);
    expect(inWorker.method).toBe(onMain.method);
    expect(inWorker.forEveryRecipient).toBe(true);
    expect(onMain.forEveryRecipient).toBe(true);
    expect(inWorker.buffer).toBe(buffer); // not a copy sent back from the worker
  });

  test('the main thread keeps answering while the worker searches (measured against the same search on the main thread)', async () => {
    const buffer = await noise(2400, 1800, 11);
    const params = { buffer, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-c' };
    await markDeliveryCopyOffThread({ ...params, buffer: await noise(400, 300) }); // the worker is started outside the measurement
    const inWorker = await withStallMeter(() => markDeliveryCopyOffThread(params));
    // The same kind of pixel arithmetic on the main thread (every strength measured once, as the search does): that is the stall
    // every other request used to wait through. A smaller picture, because code under Jest runs many times slower than in the server.
    const { data, info } = await sharp(await noise(640, 480, 11)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const onMain = await withStallMeter(async () => {
      await new Promise((r) => setTimeout(r, 30)); // let the meter tick once first
      return robustWatermark.measureEveryCropStrength(data, info.width, info.height, '0123456789abcdef');
    });
    // eslint-disable-next-line no-console
    console.log(`[delivery-mark] 2400x1800: worker search ${inWorker.ms} ms, longest main-thread stall ${inWorker.longestStallMs} ms; 640x480 pixel work on the main thread: longest stall ${onMain.longestStallMs} ms`);
    expect(typeof inWorker.value.embedded).toBe('boolean');
    expect(inWorker.longestStallMs).toBeLessThan(250);
    expect(onMain.longestStallMs).toBeGreaterThan(500);
  }, 600_000);

  test('a timeout stops the worker, is never repeated on the main thread, and the next mark works', async () => {
    const onMain = jest.spyOn(robustWatermark, 'markDeliveryCopy');
    process.env['DELIVERY_MARK_TIMEOUT_MS'] = '40';
    const slow = await noise(2400, 1800, 13);
    const { value: failure, longestStallMs } = await withStallMeter(() => markDeliveryCopyOffThread(
      { buffer: slow, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-d' },
    ).then(() => null, (e: unknown) => e));
    expect(failure).toBeInstanceOf(WorkerWorkFailedError);
    expect((failure as WorkerWorkFailedError).kind).toBe('timeout');
    expect(onMain).not.toHaveBeenCalled();
    expect(longestStallMs).toBeLessThan(250);

    delete process.env['DELIVERY_MARK_TIMEOUT_MS'];
    const next = await markDeliveryCopyOffThread({ buffer: await gradient(800, 600), mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-d' });
    expect(next.embedded).toBe(true);
    expect(onMain).not.toHaveBeenCalled();
  });

  test('a picture that keeps timing out workers is refused for a while, without touching a worker or the main thread', async () => {
    const onMain = jest.spyOn(robustWatermark, 'markDeliveryCopy');
    process.env['DELIVERY_MARK_TIMEOUT_MS'] = '40';
    const slow = await noise(2400, 1800, 17);
    const params = { buffer: slow, mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: crypto.randomBytes(4).toString('hex') };
    for (let i = 0; i < 2; i++) await expect(markDeliveryCopyOffThread(params)).rejects.toBeInstanceOf(WorkerWorkFailedError);
    const use = jest.spyOn(forensicWorkerPool, 'use');
    const refused = await markDeliveryCopyOffThread(params).then(() => null, (e: unknown) => e) as WorkerWorkFailedError;
    expect(refused).toBeInstanceOf(WorkerWorkFailedError);
    expect(refused.refusedInput).toBe(true);
    expect(use).not.toHaveBeenCalled();
    expect(onMain).not.toHaveBeenCalled();
  });
});

describe('a worker whose key differs from the server key', () => {
  test('its marked copy is refused (never delivered) and nothing is done on the main thread', async () => {
    await forensicWorkerPool.close();
    process.env['DNA_VNEXT_SECRET'] = 'a-different-key';
    const onMain = jest.spyOn(robustWatermark, 'markDeliveryCopy');
    try {
      const failure = await markDeliveryCopyOffThread(
        { buffer: await gradient(800, 600), mimeType: 'image/png', vaultId: VAULT, dnaRecordId: DNA, recipientKey: 'recipient-e' },
      ).then(() => null, (e: unknown) => e) as WorkerWorkFailedError;
      expect(failure).toBeInstanceOf(WorkerWorkFailedError);
      expect(failure.kind).toBe('protocol');
      expect(onMain).not.toHaveBeenCalled();
    } finally {
      await forensicWorkerPool.close();
      process.env['DNA_VNEXT_SECRET'] = SERVER_KEY;
    }
  });
});
