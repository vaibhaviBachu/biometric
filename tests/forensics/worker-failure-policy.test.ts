/**
 * F6: what happens when a worker fails.
 *
 * The old rule repeated ANY failed worker job on the server's main thread. A picture that crashes a worker, runs it out of memory or
 * keeps it busy until the time limit would then do the same to the server's only thread. The policy now:
 *   - worker could not start / unusable protocol  -> the work may be done on the main thread (the picture is not to blame)
 *   - crash, out of memory, timeout, job error    -> NOT repeated on the main thread; "could not finish" (inconclusive)
 *   - the caller gave up                          -> nothing more is done
 *   - a picture that keeps doing this             -> refused for a while, then one trial
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { forensicWorkerPool, poisonInputs, readMark, runWithWorkerPolicy } from '../../src/services/forensics/forensic-workers';
import * as robustWatermark from '../../src/services/dna-vnext/robust-watermark';
import { AbortedError } from '../../src/lib/cancellation';
import {
  WorkerCrashedError, WorkerOutOfMemoryError, WorkerProtocolError, WorkerStartupError, WorkerTimeoutError,
} from '../../src/lib/worker-pool';
import { WorkerWorkFailedError, isInconclusiveWorkerFailure } from '../../src/lib/worker-failure';
import { getOpsSnapshot } from '../../src/lib/ops-metrics';
import { inputFingerprint } from '../../src/lib/poison-input-guard';

const MARK = { lookupId: 'lookup-1', strengthPercent: 91 };
const pic = (n: number) => Buffer.from(`picture number ${n} ${'x'.repeat(50)}`);

/** The error a call fails with, typed as the "could not finish" error (the test then checks that it really is one). */
const failureOf = async (p: Promise<unknown>): Promise<WorkerWorkFailedError> => (await p.then(() => null, (e: unknown) => e)) as WorkerWorkFailedError;

let inProcess: jest.SpiedFunction<typeof robustWatermark.extractWatermarkMatch>;
let pool: jest.SpiedFunction<typeof forensicWorkerPool.use>;

const counter = (name: string): number => (getOpsSnapshot() as unknown as { counters: Record<string, number> }).counters[name] ?? 0;

beforeEach(() => {
  process.env['FORENSIC_WORKERS'] = 'on'; // the setup file turns workers off; these tests are about the case where they are on
  delete process.env['FORENSIC_POISON_GUARD'];
  delete process.env['FORENSIC_POISON_MAX_FAILURES'];
  delete process.env['FORENSIC_POISON_TTL_MS'];
  poisonInputs.clear();
  inProcess = jest.spyOn(robustWatermark, 'extractWatermarkMatch').mockResolvedValue(MARK);
  pool = jest.spyOn(forensicWorkerPool, 'use');
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env['FORENSIC_WORKERS'] = 'off';
  delete process.env['FORENSIC_POISON_GUARD'];
  delete process.env['FORENSIC_POISON_MAX_FAILURES'];
  delete process.env['FORENSIC_POISON_TTL_MS'];
});
afterAll(() => poisonInputs.clear());

describe('failures that may be the picture\'s own doing are NOT repeated on the main thread', () => {
  const cases: Array<[string, () => Error, string]> = [
    ['a worker crash', () => new WorkerCrashedError('it exited with code 3'), 'crash'],
    ['an out-of-memory stop', () => new WorkerOutOfMemoryError('ERR_WORKER_OUT_OF_MEMORY'), 'oom'],
    ['a timeout on this input', () => new WorkerTimeoutError(30_000), 'timeout'],
    ['an error raised by the job itself', () => Object.assign(new Error('Input buffer contains unsupported image format'), { name: 'Error' }), 'job-error'],
  ];

  test.each(cases)('%s: no main-thread retry, an inconclusive error that says what happened', async (_label, make, kind) => {
    pool.mockRejectedValueOnce(make());
    const err = await failureOf(readMark(pic(1)));
    expect(err).toBeInstanceOf(WorkerWorkFailedError);
    expect(err.kind).toBe(kind);
    expect(err.inconclusive).toBe(true);
    expect(isInconclusiveWorkerFailure(err)).toBe(true);
    expect(err.message).toMatch(/could not be completed/i);
    expect(inProcess).not.toHaveBeenCalled(); // the old behaviour ran it here
    expect(pool).toHaveBeenCalledTimes(1);
  });

  test('it is counted as a worker failure, not as a fallback', async () => {
    const failures = counter('worker_failures');
    const fallbacks = counter('worker_fallbacks');
    pool.mockRejectedValueOnce(new WorkerCrashedError('x'));
    await expect(readMark(pic(2))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    expect(counter('worker_failures')).toBe(failures + 1);
    expect(counter('worker_fallbacks')).toBe(fallbacks);
  });
});

describe('failures that say nothing about the picture may fall back to the main thread', () => {
  test.each([
    ['the worker could not start', () => new WorkerStartupError('Cannot find module')],
    ['the worker spoke an unusable protocol', () => new WorkerProtocolError('missing id or ok')],
  ])('%s: the answer still comes, from the main thread', async (_label, make) => {
    const fallbacks = counter('worker_fallbacks');
    pool.mockRejectedValueOnce(make());
    expect(await readMark(pic(3))).toEqual(MARK);
    expect(inProcess).toHaveBeenCalledTimes(1);
    expect(counter('worker_fallbacks')).toBe(fallbacks + 1);
  });

  test('startup and protocol failures never count against the picture, however many there are', async () => {
    for (let i = 0; i < 5; i++) {
      pool.mockRejectedValueOnce(new WorkerStartupError('down'));
      expect(await readMark(pic(4))).toEqual(MARK);
    }
    pool.mockRejectedValueOnce(new WorkerCrashedError('first real crash'));
    await expect(readMark(pic(4))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    expect(poisonInputs.isBlocked(inputFingerprint(pic(4)))).toBe(false);
  });
});

describe('a caller that gave up', () => {
  test('is not retried on the main thread and does not count against the picture', async () => {
    for (let i = 0; i < 5; i++) {
      pool.mockRejectedValueOnce(new AbortedError('window ended'));
      await expect(readMark(pic(5))).rejects.toBeInstanceOf(AbortedError);
    }
    expect(inProcess).not.toHaveBeenCalled();
    // Five abandoned attempts later the picture is still tried normally.
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(5))).toEqual(MARK);
  });
});

describe('a picture that keeps failing is not tried again and again', () => {
  const crash = () => pool.mockRejectedValueOnce(new WorkerCrashedError('boom'));

  test('after two crashes the third request is refused at once, without starting any worker work', async () => {
    crash(); await expect(readMark(pic(6))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    crash(); await expect(readMark(pic(6))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    expect(pool).toHaveBeenCalledTimes(2);

    const refused = counter('worker_inputs_refused');
    const err = await failureOf(readMark(pic(6)));
    expect(err).toBeInstanceOf(WorkerWorkFailedError);
    expect(err.refusedInput).toBe(true);
    expect(err.inconclusive).toBe(true);
    expect(pool).toHaveBeenCalledTimes(2); // no third worker job
    expect(inProcess).not.toHaveBeenCalled(); // and no main-thread run either
    expect(counter('worker_inputs_refused')).toBe(refused + 1);
  });

  test('another picture is not affected', async () => {
    crash(); await expect(readMark(pic(7))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    crash(); await expect(readMark(pic(7))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(8))).toEqual(MARK);
  });

  test('the limit and the block time are tunable', async () => {
    process.env['FORENSIC_POISON_MAX_FAILURES'] = '1';
    crash(); await expect(readMark(pic(9))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    await expect(readMark(pic(9))).rejects.toMatchObject({ refusedInput: true });
  });

  test('a success in between forgets the earlier failure', async () => {
    crash(); await expect(readMark(pic(10))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(10))).toEqual(MARK);
    crash(); await expect(readMark(pic(10))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(10))).toEqual(MARK); // the count started again after the success, so it is still being tried
  });

  test('when the block ends exactly one request is let through; if it also fails the block starts again, if it succeeds the picture is forgiven', async () => {
    process.env['FORENSIC_POISON_TTL_MS'] = '1000';
    const real = Date.now();
    let clock = real;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    crash(); await expect(readMark(pic(11))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    crash(); await expect(readMark(pic(11))).rejects.toBeInstanceOf(WorkerWorkFailedError);
    await expect(readMark(pic(11))).rejects.toMatchObject({ refusedInput: true });

    clock = real + 1_500; // the block has ended
    crash(); // the trial fails again
    await expect(readMark(pic(11))).rejects.toMatchObject({ refusedInput: false });
    await expect(readMark(pic(11))).rejects.toMatchObject({ refusedInput: true }); // blocked again at once

    clock = real + 3_000;
    pool.mockResolvedValueOnce(MARK); // the trial succeeds
    expect(await readMark(pic(11))).toEqual(MARK);
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(11))).toEqual(MARK); // forgiven: normal again
  });

  test('FORENSIC_POISON_GUARD=off never refuses a picture (failures are still not retried on the main thread)', async () => {
    process.env['FORENSIC_POISON_GUARD'] = 'off';
    for (let i = 0; i < 4; i++) { crash(); await expect(readMark(pic(12))).rejects.toMatchObject({ refusedInput: false }); }
    expect(pool).toHaveBeenCalledTimes(4);
    expect(inProcess).not.toHaveBeenCalled();
  });
});

describe('the other settings are untouched', () => {
  test('with workers off nothing goes near the pool and the work runs on the main thread, as before', async () => {
    process.env['FORENSIC_WORKERS'] = 'off';
    expect(await readMark(pic(13))).toEqual(MARK);
    expect(pool).not.toHaveBeenCalled();
  });

  test('a successful worker job is returned as it is', async () => {
    pool.mockResolvedValueOnce(MARK);
    expect(await readMark(pic(14))).toEqual(MARK);
    expect(inProcess).not.toHaveBeenCalled();
  });

  test('the patch search follows the same policy (runWithWorkerPolicy is the one place that decides)', async () => {
    const main = jest.fn(async () => 'main-thread' as const);
    await expect(runWithWorkerPolicy('patch search', pic(15), async () => { throw new WorkerCrashedError('x'); }, main))
      .rejects.toBeInstanceOf(WorkerWorkFailedError);
    expect(main).not.toHaveBeenCalled();
    expect(await runWithWorkerPolicy('patch search', pic(16), async () => { throw new WorkerStartupError('x'); }, main)).toBe('main-thread');
    expect(main).toHaveBeenCalledTimes(1);
  });

  test('one CPU: the patch search still stays on the main thread and the automatic worker count is unchanged', async () => {
    const { matchWorkersEnabled } = await import('../../src/services/forensics/forensic-workers');
    const { automaticWorkerCount } = await import('../../src/lib/worker-pool');
    expect(matchWorkersEnabled({ FORENSIC_WORKERS: 'on' } as NodeJS.ProcessEnv, 1)).toBe(false);
    expect(matchWorkersEnabled({ FORENSIC_WORKERS: 'on' } as NodeJS.ProcessEnv, 2)).toBe(true);
    expect(automaticWorkerCount(1)).toBe(1);
    expect(automaticWorkerCount(2)).toBe(1);
    expect(automaticWorkerCount(12)).toBe(2);
  });
});
