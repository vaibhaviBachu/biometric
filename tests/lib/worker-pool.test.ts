/**
 * The worker pool with real worker threads (started through ts-node, as when running from source).
 * Uses the test-only operations of the worker (FORENSIC_WORKER_TEST_OPS=1): echo, spin, crash, throw.
 */
import { describe, test, expect, afterEach, beforeAll } from '@jest/globals';
import { performance } from 'perf_hooks';
import { WorkerPool, WorkerTimeoutError, WorkerCrashedError, defaultSpawn, automaticWorkerCount } from '../../src/lib/worker-pool';
import { AbortedError } from '../../src/lib/cancellation';

jest.setTimeout(20_000);
beforeAll(() => { process.env['FORENSIC_WORKER_TEST_OPS'] = '1'; });

let pool: WorkerPool | null = null;
const make = (size = 1, idleMs = 60_000) => (pool = new WorkerPool({ size: () => size, spawn: defaultSpawn, idleMs }));
afterEach(async () => { await pool?.close(); pool = null; });

describe('WorkerPool', () => {
  test('runs an operation in a worker and returns its result', async () => {
    const p = make();
    const out = await p.use((w) => w.call<{ a: number }>('test.echo', { a: 1 }));
    expect(out).toEqual({ a: 1 });
    expect(p.stats()).toMatchObject({ workers: 1, jobs: 1, crashes: 0 });
  });

  test('an error in the worker comes back as an error with its name', async () => {
    const p = make();
    const err = await p.use((w) => w.call('test.throw', null)).catch((e) => e as Error);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('TestError');
    // The worker is still fine afterwards.
    expect(await p.use((w) => w.call('test.echo', 5))).toBe(5);
  });

  test('a worker that dies fails its job with WorkerCrashedError, and the next job gets a fresh worker', async () => {
    const p = make();
    await expect(p.use((w) => w.call('test.crash', null))).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(p.stats().crashes).toBe(1);
    expect(await p.use((w) => w.call('test.echo', 'again'))).toBe('again');
    expect(p.stats().spawned).toBe(2);
  });

  test('a job that runs too long is stopped for real, and the main thread stays responsive meanwhile', async () => {
    const p = make();
    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; }, 10);
    const started = performance.now();
    await expect(p.use((w) => w.call('test.spin', { ms: 20_000 }), { timeoutMs: 300 })).rejects.toBeInstanceOf(WorkerTimeoutError);
    const took = performance.now() - started;
    clearInterval(ticker);
    expect(took).toBeLessThan(5_000); // stopped at the limit, not after the 20 s of work
    expect(longestGap).toBeLessThan(500); // the spinning ran off this thread
    expect(p.stats().stoppedOnTimeoutOrAbort).toBe(1);
    expect(await p.use((w) => w.call('test.echo', 'ok'))).toBe('ok');
  });

  test('aborting stops the worker at once', async () => {
    const p = make();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new AbortedError('person went away')), 300);
    const started = performance.now();
    await expect(p.use((w) => w.call('test.spin', { ms: 20_000 }), { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('with one worker, a second job waits for the first; a waiting job that is aborted leaves the line', async () => {
    const p = make(1);
    const order: string[] = [];
    const first = p.use(async (w) => { await w.call('test.spin', { ms: 400 }); order.push('first'); });
    await new Promise((r) => setTimeout(r, 50));
    const second = p.use(async (w) => { await w.call('test.echo', 1); order.push('second'); });
    const controller = new AbortController();
    const third = p.use(async (w) => { order.push('third'); return w.call('test.echo', 1); }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    expect(p.stats().waiting).toBe(2);
    controller.abort(new AbortedError('left'));
    await expect(third).rejects.toBeInstanceOf(AbortedError);
    await first; await second;
    expect(order).toEqual(['first', 'second']);
    expect(p.stats().waiting).toBe(0);
  });

  test('with two workers two jobs run at the same time', async () => {
    const p = make(2);
    // Start both workers first, so the timing below is the work and not the start-up (which is slow on a busy machine).
    await Promise.all([p.use((w) => w.call('test.echo', 1)), p.use((w) => w.call('test.echo', 2))]);
    expect(p.stats().workers).toBe(2);
    const started = performance.now();
    await Promise.all([
      p.use((w) => w.call('test.spin', { ms: 600 })),
      p.use((w) => w.call('test.spin', { ms: 600 })),
    ]);
    // One after the other would take 1,200 ms or more.
    expect(performance.now() - started).toBeLessThan(1_150);
  });

  test('an idle worker is stopped after a while, and made again when needed', async () => {
    const p = make(1, 150);
    await p.use((w) => w.call('test.echo', 1));
    expect(p.stats().workers).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(p.stats().workers).toBe(0);
    expect(await p.use((w) => w.call('test.echo', 2))).toBe(2);
  });

  test('what a worker already holds is remembered between jobs, and forgotten if it dies', async () => {
    const p = make();
    await p.use(async (w) => { w.loaded.add('k1'); });
    await p.use(async (w) => { expect(w.loaded.has('k1')).toBe(true); });
    await p.use((w) => w.call('test.crash', null)).catch(() => undefined);
    await p.use(async (w) => { expect(w.loaded.has('k1')).toBe(false); });
  });
});

describe('automaticWorkerCount', () => {
  test.each([[1, 1], [2, 1], [3, 2], [12, 2]])('%s CPUs -> %s worker(s)', (cpus, expected) => {
    expect(automaticWorkerCount(cpus)).toBe(expected);
  });
});
