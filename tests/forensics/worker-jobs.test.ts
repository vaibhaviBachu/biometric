/**
 * The patch search and the hidden-mark search in real worker threads: same answers as on the main thread, stopped for real when
 * abandoned, and a worker failure falls back to doing the work in-process.
 */
import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import sharp from 'sharp';
import { performance } from 'perf_hooks';
import { forensicWorkerPool, matchOffThread, poisonInputs, readMark, indexKey, type OffThreadIndex } from '../../src/services/forensics/forensic-workers';
import { matchAllIndexesSync } from '../../src/services/forensics/local-dna-match-core';
import { AbortedError } from '../../src/lib/cancellation';
import { WorkerCrashedError, WorkerStartupError } from '../../src/lib/worker-pool';
import { WorkerWorkFailedError } from '../../src/lib/worker-failure';
import { buildSyntheticVault } from './fixtures/synthetic-vault';
import { embedRobustProvenanceWatermark, extractWatermarkMatch } from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';

jest.setTimeout(120_000);

const withKeys = (indexes: ReturnType<typeof buildSyntheticVault>['indexes']): OffThreadIndex[] =>
  indexes.map((i, n) => ({ ...i, id: `idx-${n}`, updatedAt: new Date(1_700_000_000_000 + n), patchCount: i.vaultPatches.length }));

beforeAll(() => { process.env['FORENSIC_WORKERS'] = 'on'; });
afterAll(async () => { delete process.env['FORENSIC_WORKERS']; await forensicWorkerPool.close(); });

describe('the patch search in a worker', () => {
  const vault = buildSyntheticVault({ seed: 3, indexes: 6, patchesPerIndex: 400, probePatches: 500 });
  const indexes = withKeys(vault.indexes);

  test('gives exactly the hits the main thread gives, again on a second search, and holds the indexes between searches', async () => {
    const expected = matchAllIndexesSync(vault.probe, vault.indexes);
    expect(expected.length).toBeGreaterThan(0);
    expect(await matchOffThread(vault.probe, indexes)).toEqual(expected);
    expect(await matchOffThread(vault.probe, indexes)).toEqual(expected);
    // After the first search the worker holds all six, so the second sent none of them again.
    const held = await forensicWorkerPool.use(async (w) => w.loaded.size);
    expect(held).toBe(6);
  });

  test('an index that changed (new update time) is sent again and used', async () => {
    const changed = indexes.map((i, n) => (n === 0 ? { ...i, updatedAt: new Date(1_800_000_000_000) } : i));
    expect(indexKey(changed[0]!)).not.toBe(indexKey(indexes[0]!));
    expect(await matchOffThread(vault.probe, changed)).toEqual(matchAllIndexesSync(vault.probe, vault.indexes));
  });

  test('abandoning a long search stops the worker at once, the main thread stays responsive, and the next search works', async () => {
    const big = buildSyntheticVault({ seed: 6, indexes: 40, patchesPerIndex: 1200, probePatches: 1500 });
    const bigIndexes = withKeys(big.indexes);
    const controller = new AbortController();
    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; }, 10);
    setTimeout(() => controller.abort(new AbortedError('abandoned')), 400);
    const started = performance.now();
    await expect(matchOffThread(big.probe, bigIndexes, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    const took = performance.now() - started;
    clearInterval(ticker);
    expect(took).toBeLessThan(10_000);
    expect(longestGap).toBeLessThan(1_000);
    expect(await matchOffThread(vault.probe, indexes)).toEqual(matchAllIndexesSync(vault.probe, vault.indexes));
  });
});

describe('the hidden-mark search in a worker', () => {
  let marked: Buffer;
  let unmarked: Buffer;
  const vaultId = 'vault-worker-test';
  const dnaRecordId = 'dna-worker-test';

  beforeAll(async () => {
    const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 18, g: 64, b: 90 } } }).png().toBuffer();
    const embedded = await embedRobustProvenanceWatermark({ buffer: png, mimeType: 'image/png', vaultId, dnaRecordId });
    expect(embedded.embedded).toBe(true);
    marked = embedded.buffer;
    unmarked = await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 200, g: 30, b: 60 } } }).png().toBuffer();
  });

  test('reads the same mark as the main thread does (the worker has no database)', async () => {
    const inProcess = await extractWatermarkMatch(marked);
    const inWorker = await readMark(marked);
    expect(inWorker).toEqual(inProcess);
    expect(inWorker?.lookupId).toBe(watermarkLookupId(vaultId, dnaRecordId));
  });

  test('a picture with no mark gives null in a worker too', async () => {
    expect(await readMark(unmarked)).toBeNull();
  });

  test('a mark search that is abandoned is stopped, not started again on the main thread', async () => {
    const photo = await sharp({ create: { width: 3200, height: 2400, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 50 } } }).jpeg({ quality: 90 }).toBuffer();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new AbortedError('window ended')), 150);
    const started = performance.now();
    await expect(readMark(photo, {}, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('if the worker could not start, the search is done in-process and still gives the answer', async () => {
    const spy = jest.spyOn(forensicWorkerPool, 'use').mockRejectedValueOnce(new WorkerStartupError('simulated'));
    const hit = await readMark(marked);
    expect(hit?.lookupId).toBe(watermarkLookupId(vaultId, dnaRecordId));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('if the worker crashes, the search is NOT started again on the main thread: it ends as "could not finish"', async () => {
    const spy = jest.spyOn(forensicWorkerPool, 'use').mockRejectedValueOnce(new WorkerCrashedError('simulated'));
    await expect(readMark(marked)).rejects.toBeInstanceOf(WorkerWorkFailedError);
    spy.mockRestore();
    poisonInputs.clear();
  });

  test('with FORENSIC_WORKERS=off the search runs in-process and never touches the pool', async () => {
    process.env['FORENSIC_WORKERS'] = 'off';
    try {
      const spy = jest.spyOn(forensicWorkerPool, 'use');
      expect((await readMark(marked))?.lookupId).toBe(watermarkLookupId(vaultId, dnaRecordId));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      process.env['FORENSIC_WORKERS'] = 'on';
    }
  });
});

describe('when the patch search uses workers', () => {
  const { matchWorkersEnabled } = require('../../src/services/forensics/forensic-workers') as typeof import('../../src/services/forensics/forensic-workers');
  test.each([
    [{}, 1, false],      // one CPU: in-process slices are as responsive, faster and lighter
    [{}, 2, true],
    [{}, 12, true],
    [{ FORENSIC_WORKER_MATCH: 'on' }, 1, true],
    [{ FORENSIC_WORKER_MATCH: 'off' }, 12, false],
    [{ FORENSIC_WORKERS: 'off' }, 12, false],
    [{ FORENSIC_WORKERS: 'off', FORENSIC_WORKER_MATCH: 'on' }, 12, false],
  ])('%j with %s CPU(s) -> %s', (env, cpus, expected) => {
    expect(matchWorkersEnabled(env as NodeJS.ProcessEnv, cpus as number)).toBe(expected);
  });
});
