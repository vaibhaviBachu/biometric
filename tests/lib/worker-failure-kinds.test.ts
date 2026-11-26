/**
 * F6: the pool tells WHY a worker failed (real worker threads), and the poison-input guard and classifier behave as designed.
 */
import { describe, test, expect, afterEach, beforeAll } from '@jest/globals';
import { Worker } from 'worker_threads';
import {
  WorkerPool, WorkerCrashedError, WorkerOutOfMemoryError, WorkerProtocolError, WorkerStartupError, WorkerTimeoutError, defaultSpawn,
} from '../../src/lib/worker-pool';
import { AbortedError } from '../../src/lib/cancellation';
import { classifyWorkerFailure, countsAgainstInput, mayFallBackToMainThread, WorkerWorkFailedError, isInconclusiveWorkerFailure } from '../../src/lib/worker-failure';
import { PoisonInputGuard, inputFingerprint } from '../../src/lib/poison-input-guard';

jest.setTimeout(30_000);
beforeAll(() => { process.env['FORENSIC_WORKER_TEST_OPS'] = '1'; });

let pool: WorkerPool | null = null;
const make = (spawn: () => Worker, extra: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) =>
  (pool = new WorkerPool({ size: () => 1, spawn, idleMs: 60_000, ...extra }));
afterEach(async () => { await pool?.close(); pool = null; });

/** A worker made from a small piece of code instead of the real worker file. */
const fake = (code: string, resourceLimits?: ConstructorParameters<typeof Worker>[1] extends infer O ? (O extends { resourceLimits?: infer R } ? R : never) : never) =>
  () => new Worker(code, { eval: true, resourceLimits });

describe('the pool says why a worker failed', () => {
  test('the real worker announces itself: it is ready before its first job and a crash after that is a crash, not a start failure', async () => {
    const p = make(defaultSpawn);
    expect(await p.use((w) => w.call('test.echo', 'hi'))).toBe('hi');
    await expect(p.use((w) => w.call('test.crash', null))).rejects.toBeInstanceOf(WorkerCrashedError);
  });

  test('a worker that dies before it is ready is a WorkerStartupError', async () => {
    const p = make(fake('process.exit(1)'));
    const err = await p.use((w) => w.call('test.echo', 1)).catch((e) => e as Error);
    expect(err).toBeInstanceOf(WorkerStartupError);
    expect(err).not.toBeInstanceOf(WorkerCrashedError);
    expect(classifyWorkerFailure(err)).toBe('startup');
  });

  test('a worker whose file cannot be loaded is a WorkerStartupError', async () => {
    const p = make(fake('require("this-module-does-not-exist-anywhere");'));
    const err = await p.use((w) => w.call('test.echo', 1)).catch((e) => e as Error);
    expect(err).toBeInstanceOf(WorkerStartupError);
  });

  test('after repeated start failures the pool pauses: no new worker is made, the caller is told at once', async () => {
    const p = make(fake('process.exit(1)'), { startupFailureLimit: 2, startupPauseMs: 60_000 });
    for (let i = 0; i < 2; i++) await expect(p.use((w) => w.call('test.echo', 1))).rejects.toBeInstanceOf(WorkerStartupError);
    const spawned = p.stats().spawned;
    const started = Date.now();
    await expect(p.use((w) => w.call('test.echo', 1))).rejects.toBeInstanceOf(WorkerStartupError);
    expect(p.stats().spawned).toBe(spawned); // nothing was spawned while paused
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('the pause ends: workers are tried again afterwards', async () => {
    let healthy = false;
    const spawn = () => (healthy ? defaultSpawn() : fake('process.exit(1)')());
    const p = make(spawn, { startupFailureLimit: 1, startupPauseMs: 300 });
    await expect(p.use((w) => w.call('test.echo', 1))).rejects.toBeInstanceOf(WorkerStartupError);
    await expect(p.use((w) => w.call('test.echo', 1))).rejects.toBeInstanceOf(WorkerStartupError); // paused
    healthy = true;
    await new Promise((r) => setTimeout(r, 400));
    expect(await p.use((w) => w.call('test.echo', 'back'))).toBe('back');
  });

  test('running out of memory in the worker is a WorkerOutOfMemoryError (a kind of crash)', async () => {
    const code = `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', (m) => { const keep = []; for (;;) keep.push(new Array(1e5).fill(m.id)); });`;
    const p = make(fake(code, { maxOldGenerationSizeMb: 24 }));
    const err = await p.use((w) => w.call('x', null)).catch((e) => e as Error);
    expect(err).toBeInstanceOf(WorkerOutOfMemoryError);
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect(classifyWorkerFailure(err)).toBe('oom');
  });

  test('a message the pool cannot read is a WorkerProtocolError, and that worker is dropped', async () => {
    const code = `
      const { parentPort } = require('worker_threads');
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', () => parentPort.postMessage({ nonsense: true }));`;
    const p = make(fake(code));
    const err = await p.use((w) => w.call('x', null)).catch((e) => e as Error);
    expect(err).toBeInstanceOf(WorkerProtocolError);
    expect(classifyWorkerFailure(err)).toBe('protocol');
    expect(p.stats().workers).toBe(0);
  });

  test('the real worker reports an operation it does not know as a protocol problem (a version or packaging mismatch)', async () => {
    const p = make(defaultSpawn);
    const err = await p.use((w) => w.call('no.such.operation', null)).catch((e) => e as Error);
    expect(err).toBeInstanceOf(WorkerProtocolError);
    // and the worker is still usable
    expect(await p.use((w) => w.call('test.echo', 2))).toBe(2);
  });

  test('a job that runs too long is a WorkerTimeoutError, and a worker error of the job\'s own stays a plain error', async () => {
    const p = make(defaultSpawn);
    const slow = await p.use((w) => w.call('test.spin', { ms: 5_000 }), { timeoutMs: 200 }).catch((e) => e as Error);
    expect(slow).toBeInstanceOf(WorkerTimeoutError);
    expect(classifyWorkerFailure(slow)).toBe('timeout');
    const own = await p.use((w) => w.call('test.throw', null)).catch((e) => e as Error);
    expect(classifyWorkerFailure(own)).toBe('job-error');
  });
});

describe('what each kind of failure allows', () => {
  test('only a worker that could not start, or spoke an unusable protocol, may be answered on the main thread', () => {
    const kinds = ['startup', 'protocol', 'crash', 'oom', 'timeout', 'aborted', 'job-error', 'unknown'] as const;
    expect(kinds.filter(mayFallBackToMainThread)).toEqual(['startup', 'protocol']);
    expect(kinds.filter(countsAgainstInput)).toEqual(['crash', 'oom', 'timeout']);
  });

  test('a caller that gave up is "aborted", whichever way it is reported', () => {
    expect(classifyWorkerFailure(new AbortedError('x'))).toBe('aborted');
    expect(classifyWorkerFailure('nonsense')).toBe('unknown');
  });

  test('the "could not finish" error is inconclusive and never reads like a "no match"', () => {
    const e = new WorkerWorkFailedError('crash', 'worker exited');
    expect(e.inconclusive).toBe(true);
    expect(isInconclusiveWorkerFailure(e)).toBe(true);
    expect(isInconclusiveWorkerFailure(new Error('x'))).toBe(false);
    expect(e.message).not.toMatch(/no match|not found|clean/i);
    expect(new WorkerWorkFailedError('crash', '', true).message).not.toMatch(/no match|not found|clean/i);
  });
});

describe('the poison-input guard', () => {
  const guard = (state: { now: number }, max = 2, ttl = 1_000, maxEntries?: number) =>
    new PoisonInputGuard({ maxFailures: () => max, ttlMs: () => ttl, now: () => state.now, maxEntries });

  test('blocks after the limit, lets one trial through when the block ends, and forgives a success', () => {
    const t = { now: 1_000 };
    const g = guard(t);
    expect(g.allow('a')).toBe(true);
    g.failed('a');
    expect(g.allow('a')).toBe(true);
    g.failed('a');
    expect(g.allow('a')).toBe(false);
    t.now += 999;
    expect(g.allow('a')).toBe(false);
    t.now += 2;
    expect(g.allow('a')).toBe(true); // the one trial
    expect(g.allow('a')).toBe(false); // nobody else while it runs
    g.succeeded('a');
    expect(g.allow('a')).toBe(true);
    expect(g.size()).toBe(0);
  });

  test('a failed trial blocks again for the full time', () => {
    const t = { now: 0 };
    const g = guard(t, 1, 1_000);
    g.failed('a');
    t.now = 1_001;
    expect(g.allow('a')).toBe(true);
    g.failed('a');
    expect(g.allow('a')).toBe(false);
    t.now = 2_000;
    expect(g.allow('a')).toBe(false);
    t.now = 2_002;
    expect(g.allow('a')).toBe(true);
  });

  test('a trial that was abandoned (the caller gave up) lets the next request be the trial', () => {
    const t = { now: 0 };
    const g = guard(t, 1, 1_000);
    g.failed('a');
    t.now = 1_001;
    expect(g.allow('a')).toBe(true);
    g.abandoned('a');
    expect(g.allow('a')).toBe(true);
  });

  test('the table is bounded and forgets the oldest first', () => {
    const t = { now: 0 };
    const g = guard(t, 1, 10_000, 3);
    ['a', 'b', 'c', 'd'].forEach((k) => g.failed(k));
    expect(g.size()).toBe(3);
    expect(g.allow('a')).toBe(true); // the oldest was forgotten
    expect(g.allow('d')).toBe(false);
  });

  test('a fingerprint depends on the bytes, not on where they came from, and large inputs are sampled but still tell apart', () => {
    expect(inputFingerprint(Buffer.from('abc'))).toBe(inputFingerprint(Buffer.from('abc')));
    expect(inputFingerprint(Buffer.from('abc'))).not.toBe(inputFingerprint(Buffer.from('abd')));
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const other = Buffer.from(big); other[other.length - 1] = 9;
    expect(inputFingerprint(big)).not.toBe(inputFingerprint(other)); // the tail is sampled
    expect(inputFingerprint(big)).not.toBe(inputFingerprint(big.subarray(1)));
  });
});
