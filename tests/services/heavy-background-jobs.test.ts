/**
 * The heavy follow-up jobs of a protect (src/services/vault/heavy-background-jobs.ts): they hold no photo while they wait,
 * read it back from the Vault when their turn comes, call the same functions with the same bytes, and survive a full line, a
 * stuck job, a storage hiccup and a shutdown.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const MB = 1024 * 1024;

const mockRetrieve = jest.fn<(vaultId: string, ownerUserId: string) => Promise<{ originalBuffer: Buffer; originalMimeType: string }>>();
const mockBuildIndex = jest.fn<(p: { buffer: Buffer; mimeType: string; dnaRecordId: string; vaultId: string; ownerUserId: string }) => Promise<{ patchCount: number; indexId: string } | null>>();
const mockEnrollBlock = jest.fn<(p: { imageBuffer: Buffer; dnaRecordId: string }) => Promise<void>>();
const mockEnrollVnext = jest.fn<(p: { imageBuffer: Buffer; dnaRecordId: string; vaultId: string; certificateId: string | null; mimeType: string }) => Promise<void>>();
const mockResolveCertificate = jest.fn<(id: string) => Promise<string | null>>();
const mockIndexRow = jest.fn<() => Promise<unknown>>();
const mockDnaRow = jest.fn<() => Promise<unknown>>();

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    localFeatureIndex: { findUnique: (...a: unknown[]) => (mockIndexRow as unknown as (...x: unknown[]) => unknown)(...a) },
    dnaRecord: { findUnique: (...a: unknown[]) => (mockDnaRow as unknown as (...x: unknown[]) => unknown)(...a) },
  },
}));
jest.mock('../../src/services/vault/vault.service', () => ({
  VaultService: class { retrieve(v: string, o: string) { return mockRetrieve(v, o); } },
}));
jest.mock('../../src/services/forensics/local-dna-index.service', () => ({
  localDnaIndexService: { buildIndex: (p: never) => mockBuildIndex(p) },
}));
jest.mock('../../src/services/block-dna/investigate', () => ({ enrollBlockDnaForVaultImage: (p: never) => mockEnrollBlock(p) }));
jest.mock('../../src/services/dna-vnext/enroll', () => ({ enrollDnaVnextForVaultImage: (p: never) => mockEnrollVnext(p) }));
jest.mock('../../src/services/identity/identity-embedding-pipeline.service', () => ({
  identityEmbeddingPipeline: { resolveCertificateId: (id: string) => mockResolveCertificate(id) },
}));

import { heavyBackground } from '../../src/lib/background-queue';
import {
  queueLocalDnaIndex,
  queueVaultEnrolment,
  setLoadRetryDelaysForTests,
  isRetryableLoadError,
} from '../../src/services/vault/heavy-background-jobs';
import { stopHeavyBackground } from '../../src/services/vault/heavy-background-recovery';

const job = (n: number | string = 1) => ({ dnaRecordId: `dna-${n}`, vaultId: `vault-${n}`, ownerUserId: 'owner-1', mimeType: 'image/jpeg' });
const photo = (bytes = 1024) => ({ originalBuffer: Buffer.alloc(bytes, 9), originalMimeType: 'image/jpeg' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storageDown = () => Object.assign(new Error('Your file storage is temporarily unreachable.'), { statusCode: 503, details: { code: 'STORAGE_UNAVAILABLE' } });

/** Holds the only place in the line until released. */
function holdTheLine() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  void heavyBackground.enqueue('test-blocker', 'blocker', () => gate);
  return release;
}

beforeEach(() => {
  process.env['HEAVY_BACKGROUND_DELAY_MS'] = '0';
  delete process.env['HEAVY_BACKGROUND_MAX_WAITING'];
  delete process.env['HEAVY_BACKGROUND_JOB_TIMEOUT_MS'];
  heavyBackground.resetForTests();
  mockRetrieve.mockReset().mockResolvedValue(photo());
  mockBuildIndex.mockReset().mockResolvedValue({ patchCount: 5, indexId: 'idx' });
  mockEnrollBlock.mockReset().mockResolvedValue(undefined);
  mockEnrollVnext.mockReset().mockResolvedValue(undefined);
  mockResolveCertificate.mockReset().mockResolvedValue('cert-from-lookup');
  mockIndexRow.mockReset().mockResolvedValue(null);
  mockDnaRow.mockReset().mockResolvedValue({ fileAnalysis: null });
  setLoadRetryDelaysForTests([20, 20, 20]);
});

afterEach(async () => {
  await sleep(20);
  delete process.env['HEAVY_BACKGROUND_DELAY_MS'];
  delete process.env['HEAVY_BACKGROUND_MAX_WAITING'];
  delete process.env['HEAVY_BACKGROUND_JOB_TIMEOUT_MS'];
  setLoadRetryDelaysForTests(null);
});

describe('what the jobs do (same results as before)', () => {
  test('the patch index is built from the stored photo, with exactly the bytes the Vault returns', async () => {
    const stored = photo(2048);
    mockRetrieve.mockResolvedValue(stored);
    const result = await queueLocalDnaIndex(job());
    expect(result).toEqual({ patchCount: 5, indexId: 'idx' });
    expect(mockRetrieve).toHaveBeenCalledWith('vault-1', 'owner-1');
    const args = mockBuildIndex.mock.calls[0]![0];
    expect(args.buffer).toBe(stored.originalBuffer); // the very same bytes, not a copy or a re-encode
    expect(args).toMatchObject({ mimeType: 'image/jpeg', dnaRecordId: 'dna-1', vaultId: 'vault-1', ownerUserId: 'owner-1' });
  });

  test('enrolment runs the block step and then the vNext step with the stored bytes and the upload\'s certificate', async () => {
    const stored = photo(4096);
    mockRetrieve.mockResolvedValue(stored);
    const order: string[] = [];
    mockEnrollBlock.mockImplementation(async () => { order.push('block'); });
    mockEnrollVnext.mockImplementation(async () => { order.push('vnext'); });
    await queueVaultEnrolment({ ...job(), certificateId: 'cert-upload' });
    expect(order).toEqual(['block', 'vnext']);
    expect(mockEnrollBlock.mock.calls[0]![0].imageBuffer).toBe(stored.originalBuffer);
    expect(mockEnrollVnext.mock.calls[0]![0]).toMatchObject({ dnaRecordId: 'dna-1', vaultId: 'vault-1', certificateId: 'cert-upload', mimeType: 'image/jpeg' });
    expect(mockResolveCertificate).not.toHaveBeenCalled(); // the certificate known at upload time is used, not looked up again
  });

  test('enrolment waits its turn in the memory gate, like the other large-photo work', async () => {
    const gate = await import('../../src/lib/memory-gate');
    const spy = jest.spyOn(gate, 'withMemoryGate');
    await queueVaultEnrolment({ ...job(), certificateId: null });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe('vault-enrol');
    expect(mockEnrollBlock).toHaveBeenCalledTimes(1); // and the work still ran
    spy.mockRestore();
  });

  test('a block failure stops enrolment before the vNext step, exactly as it did inline', async () => {
    mockEnrollBlock.mockRejectedValue(new Error('decode failed'));
    await expect(queueVaultEnrolment({ ...job(), certificateId: null })).resolves.toBeUndefined();
    expect(mockEnrollVnext).not.toHaveBeenCalled();
  });

  test('the same photo asked for twice at once is indexed once', async () => {
    const release = holdTheLine();
    const a = queueLocalDnaIndex(job());
    const b = queueLocalDnaIndex(job());
    release();
    await Promise.all([a, b]);
    expect(mockBuildIndex).toHaveBeenCalledTimes(1);
  });

  test('an index build that returns nothing (engine failure) is passed on, and the line goes on', async () => {
    mockBuildIndex.mockResolvedValueOnce(null);
    expect(await queueLocalDnaIndex(job(1))).toBeNull();
    expect(await queueLocalDnaIndex(job(2))).toEqual({ patchCount: 5, indexId: 'idx' });
  });

  test('anything that is not an image is left alone', async () => {
    await queueLocalDnaIndex({ ...job(), mimeType: 'application/pdf' });
    await queueVaultEnrolment({ ...job(), mimeType: 'video/mp4', certificateId: null });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe('memory: a waiting job holds no photo', () => {
  test('200 waiting jobs for 17 MB photos read nothing and hold almost nothing until their turn', async () => {
    const release = holdTheLine();
    const before = process.memoryUsage().arrayBuffers;
    const done: Array<Promise<unknown>> = [];
    for (let i = 0; i < 200; i++) done.push(queueLocalDnaIndex(job(i)));
    const heldMb = (process.memoryUsage().arrayBuffers - before) / MB;
    expect(mockRetrieve).not.toHaveBeenCalled(); // nothing has been loaded from storage yet
    expect(heldMb).toBeLessThan(5);              // 16 photos x 17 MB would have been 272 MB
    expect(heavyBackground.stats().waiting).toBe(200);
    release();
    await Promise.all(done);
  }, 30_000);

  test('the photo is read only when the job starts, and let go as soon as it ends (one at a time)', async () => {
    let loaded = 0;
    let alive = 0;
    let peak = 0;
    mockRetrieve.mockImplementation(async () => { loaded++; return photo(1024); });
    mockBuildIndex.mockImplementation(async () => { alive++; peak = Math.max(peak, alive); await sleep(5); alive--; return { patchCount: 1, indexId: 'i' }; });
    const release = holdTheLine();
    const all = [1, 2, 3, 4, 5].map((n) => queueLocalDnaIndex(job(n)));
    expect(loaded).toBe(0);
    release();
    await Promise.all(all);
    expect(loaded).toBe(5);
    expect(peak).toBe(1); // never two builds at the same time
  });
});

describe('overflow: a full line never runs a heavy job straight away', () => {
  test('jobs past the limit are not run and not thrown; the ones in line still run', async () => {
    process.env['HEAVY_BACKGROUND_MAX_WAITING'] = '3';
    const release = holdTheLine();
    await sleep(10); // the blocker is running, the line is empty
    const results = [1, 2, 3, 4, 5, 6].map((n) => queueLocalDnaIndex(job(n)));
    await sleep(30);
    expect(mockRetrieve).not.toHaveBeenCalled(); // nothing ran on top of the running job, not even the refused ones
    expect(heavyBackground.stats()).toMatchObject({ waiting: 3, refusedFull: 3 });
    release();
    const settled = await Promise.all(results);
    expect(settled.filter((r) => r !== null)).toHaveLength(3);        // the three that were in line
    expect(mockBuildIndex).toHaveBeenCalledTimes(3);
    const built = mockBuildIndex.mock.calls.map((c) => c[0].dnaRecordId).sort();
    expect(built).toEqual(['dna-1', 'dna-2', 'dna-3']);
  });
});

describe('timeout: a stuck job gives its place back', () => {
  test('a photo read that never answers does not hold the line for ever', async () => {
    process.env['HEAVY_BACKGROUND_JOB_TIMEOUT_MS'] = '80';
    mockRetrieve.mockImplementationOnce(() => new Promise(() => undefined)); // the first job hangs
    const stuck = queueLocalDnaIndex(job(1));
    const next = queueLocalDnaIndex(job(2));
    expect(await stuck).toBeNull();                                         // given up on, absorbed, not thrown
    expect(await next).toEqual({ patchCount: 5, indexId: 'idx' });         // the next job ran
    expect(heavyBackground.stats().timedOut).toBe(1);
  });
});

describe('failure recovery', () => {
  test('storage not answering: the job is queued again later and then succeeds', async () => {
    mockRetrieve.mockRejectedValueOnce(storageDown()).mockResolvedValue(photo());
    expect(await queueLocalDnaIndex(job())).toBeNull(); // this attempt gave way to a retry
    expect(mockBuildIndex).not.toHaveBeenCalled();
    await sleep(120);
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
    expect(mockBuildIndex).toHaveBeenCalledTimes(1);
  });

  test('it stops retrying after the allowed number of tries', async () => {
    mockRetrieve.mockRejectedValue(storageDown());
    await queueLocalDnaIndex(job());
    await sleep(300);
    expect(mockRetrieve).toHaveBeenCalledTimes(4); // the first try and three retries
    expect(mockBuildIndex).not.toHaveBeenCalled();
  });

  test('a missing or unreadable file is not retried', async () => {
    mockRetrieve.mockRejectedValue(new Error('Vault record not found: vault-1'));
    await queueLocalDnaIndex(job());
    await sleep(120);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  test('which load failures count as passing', () => {
    expect(isRetryableLoadError(storageDown())).toBe(true);
    expect(isRetryableLoadError({ code: 'P1001' })).toBe(true);
    expect(isRetryableLoadError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableLoadError(new Error('Vault record not found'))).toBe(false);
    expect(isRetryableLoadError(new Error('Vault decrypt failed for x: Unsupported state or unable to authenticate data'))).toBe(false);
    expect(isRetryableLoadError(Object.assign(new Error('too large'), { statusCode: 413 }))).toBe(false);
  });
});

describe('recovery mode only does work that is missing', () => {
  test('a finished index is left alone', async () => {
    mockIndexRow.mockResolvedValue({ status: 'COMPLETE', patchCount: 12 });
    await queueLocalDnaIndex(job(), { source: 'recovery' });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockBuildIndex).not.toHaveBeenCalled();
  });

  test('an unfinished index is built', async () => {
    mockIndexRow.mockResolvedValue({ status: 'COMPLETE', patchCount: 0 });
    await queueLocalDnaIndex(job(), { source: 'recovery' });
    expect(mockBuildIndex).toHaveBeenCalledTimes(1);
  });

  test('finished enrolment is left alone; missing enrolment is done with a certificate looked up at run time', async () => {
    mockDnaRow.mockResolvedValue({
      fileAnalysis: {
        pinitBlockDnaV1: { tagsB64: 'x', imageId: 'dna-1' },
        pinitDnaVnextV1: { vaultId: 'vault-1', watermarkLookupId: 'w', rootAuthenticationHex16: 'r' },
      },
    });
    await queueVaultEnrolment({ ...job(1) }, { source: 'recovery' });
    expect(mockEnrollBlock).not.toHaveBeenCalled();

    mockDnaRow.mockResolvedValue({ fileAnalysis: null });
    await queueVaultEnrolment({ ...job(2) }, { source: 'recovery' });
    expect(mockEnrollBlock).toHaveBeenCalledTimes(1);
    expect(mockEnrollVnext.mock.calls[0]![0].certificateId).toBe('cert-from-lookup');
  });

  test('an upload\'s own job never skips, even if an index already exists (it behaves as before)', async () => {
    mockIndexRow.mockResolvedValue({ status: 'COMPLETE', patchCount: 12 });
    await queueLocalDnaIndex(job());
    expect(mockBuildIndex).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown', () => {
  test('waiting jobs are not started, nothing throws, and the count left is reported', async () => {
    const release = holdTheLine();
    await sleep(10);
    const waiting = [1, 2, 3].map((n) => queueLocalDnaIndex(job(n)));
    const left = stopHeavyBackground();
    expect(left).toEqual({ waiting: 3, running: 1 });
    expect(await Promise.all(waiting)).toEqual([null, null, null]);
    expect(await queueLocalDnaIndex(job(9))).toBeNull(); // and nothing new is taken
    release();
    await sleep(20);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});
