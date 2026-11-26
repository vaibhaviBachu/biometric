/**
 * The line for heavy background work (src/lib/background-queue.ts): one job at a time, a short delay so the response goes out
 * first, the same job is never run twice at once, a full line refuses (never runs on top), a stuck job gives its place back.
 * What the real jobs do is tested in heavy-background-jobs.test.ts.
 */
import {
  BackgroundQueue,
  BackgroundQueueFullError,
  BackgroundJobTimeoutError,
  BackgroundQueueStoppedError,
  HEAVY_BACKGROUND_DEFAULT_MAX_WAITING,
  HEAVY_BACKGROUND_DEFAULT_JOB_TIMEOUT_MS,
} from '../../src/lib/background-queue';

const opts = (over: Partial<{ concurrency: number; startDelayMs: number; maxWaiting: number; jobTimeoutMs: number }> = {}) =>
  () => ({ concurrency: 1, startDelayMs: 100, maxWaiting: 3, ...over });

/** A job that finishes only when the test says so. */
function controllable() {
  let finish!: (v: string) => void;
  const done = new Promise<string>((r) => { finish = r; });
  const work = jest.fn(() => done);
  return { work, finish };
}

describe('BackgroundQueue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts a job after the delay, not at once', async () => {
    const q = new BackgroundQueue(opts());
    const job = jest.fn(async () => 'ok');
    const p = q.enqueue('a', 'a', job);
    expect(job).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(99);
    expect(job).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(job).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBe('ok');
  });

  it('runs one job at a time and starts the next only when the first ends', async () => {
    const q = new BackgroundQueue(opts());
    const first = controllable();
    const second = jest.fn(async () => 'second');
    const p1 = q.enqueue('a', 'a', first.work);
    const p2 = q.enqueue('b', 'b', second);
    await jest.advanceTimersByTimeAsync(500);
    expect(first.work).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(q.size).toEqual({ running: 1, waiting: 1 });
    first.finish('first');
    await expect(p1).resolves.toBe('first');
    await jest.advanceTimersByTimeAsync(150);
    expect(second).toHaveBeenCalledTimes(1);
    await expect(p2).resolves.toBe('second');
  });

  it('shares one result when the same key is queued twice, while it waits or runs', async () => {
    const q = new BackgroundQueue(opts());
    const job = jest.fn(async () => 'built');
    const p1 = q.enqueue('photo-1', 'index', job);
    const p2 = q.enqueue('photo-1', 'index', job);
    expect(p2).toBe(p1);
    await jest.advanceTimersByTimeAsync(200);
    await expect(Promise.all([p1, p2])).resolves.toEqual(['built', 'built']);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('builds again for the same key once the first has finished (a real rebuild)', async () => {
    const q = new BackgroundQueue(opts());
    const job = jest.fn(async () => 'built');
    const p1 = q.enqueue('photo-1', 'index', job);
    await jest.advanceTimersByTimeAsync(200);
    await p1;
    const p2 = q.enqueue('photo-1', 'index', job);
    await jest.advanceTimersByTimeAsync(200);
    await p2;
    expect(job).toHaveBeenCalledTimes(2);
  });

  it('REFUSES a job when the waiting line is full: it is never run on top of the job that is already running', async () => {
    const q = new BackgroundQueue(opts({ maxWaiting: 2 }));
    const blocker = controllable();
    q.enqueue('running', 'r', blocker.work);
    await jest.advanceTimersByTimeAsync(150); // the first job is now running, the line is empty
    const w1 = jest.fn(async () => 'w1');
    const w2 = jest.fn(async () => 'w2');
    const overflow = jest.fn(async () => 'ran');
    const p1 = q.enqueue('w1', 'w1', w1);
    const p2 = q.enqueue('w2', 'w2', w2);
    const refused = q.enqueue('w3', 'w3', overflow);
    await expect(refused).rejects.toBeInstanceOf(BackgroundQueueFullError);
    await jest.advanceTimersByTimeAsync(1000);
    expect(overflow).not.toHaveBeenCalled(); // not now, and not later either
    expect(w1).not.toHaveBeenCalled();       // the jobs in line still wait their turn
    expect(q.stats()).toMatchObject({ running: 1, waiting: 2, refusedFull: 1 });
    blocker.finish('done');
    await jest.advanceTimersByTimeAsync(500);
    await expect(Promise.all([p1, p2])).resolves.toEqual(['w1', 'w2']); // the accepted jobs were all worked off
    expect(overflow).not.toHaveBeenCalled();
  });

  it('a refused job can be queued again once there is room', async () => {
    const q = new BackgroundQueue(opts({ maxWaiting: 1 }));
    const blocker = controllable();
    q.enqueue('running', 'r', blocker.work);
    await jest.advanceTimersByTimeAsync(150);
    q.enqueue('w1', 'w1', async () => 'w1');
    await expect(q.enqueue('again', 'again', async () => 'x')).rejects.toBeInstanceOf(BackgroundQueueFullError);
    blocker.finish('done');
    await jest.advanceTimersByTimeAsync(500);
    const retry = q.enqueue('again', 'again', async () => 'x');
    await jest.advanceTimersByTimeAsync(500);
    await expect(retry).resolves.toBe('x');
  });

  it('a job that runs too long gives its place back, so the line keeps moving', async () => {
    const q = new BackgroundQueue(opts({ jobTimeoutMs: 1000 }));
    const stuck = controllable();
    const next = jest.fn(async () => 'next');
    const stuckResult = q.enqueue('stuck', 'stuck', stuck.work).then(() => 'resolved', (e: Error) => e);
    const p2 = q.enqueue('next', 'next', next);
    await jest.advanceTimersByTimeAsync(500);
    expect(next).not.toHaveBeenCalled(); // the stuck job still holds the only place
    await jest.advanceTimersByTimeAsync(700); // 1000 ms after it started
    expect(await stuckResult).toBeInstanceOf(BackgroundJobTimeoutError);
    await jest.advanceTimersByTimeAsync(200);
    await expect(p2).resolves.toBe('next');
    expect(q.stats()).toMatchObject({ timedOut: 1, abandonedStillRunning: 1, running: 0 });
  });

  it('a job that finishes after it was given up on does not give its place back a second time', async () => {
    const q = new BackgroundQueue(opts({ jobTimeoutMs: 1000, concurrency: 1 }));
    const slow = controllable();
    const slowResult = q.enqueue('slow', 'slow', slow.work).then(() => 'ok', () => 'timed out');
    const other = controllable();
    q.enqueue('other', 'other', other.work);
    await jest.advanceTimersByTimeAsync(1300); // slow timed out; "other" has now started
    expect(await slowResult).toBe('timed out');
    expect(q.size.running).toBe(1);
    slow.finish('late'); // the abandoned job ends now
    await jest.advanceTimersByTimeAsync(50);
    expect(q.size.running).toBe(1); // "other" still holds its place: the late end did not release another one
    expect(q.stats().abandonedStillRunning).toBe(0);
    other.finish('done');
  });

  it('a job that ends in time cancels its own watchdog', async () => {
    const q = new BackgroundQueue(opts({ jobTimeoutMs: 1000 }));
    const p = q.enqueue('quick', 'quick', async () => 'ok');
    await jest.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(5000);
    expect(q.stats().timedOut).toBe(0);
  });

  it('shutdown refuses what is waiting, refuses new work, and reports what was left', async () => {
    const q = new BackgroundQueue(opts());
    const blocker = controllable();
    q.enqueue('running', 'r', blocker.work);
    await jest.advanceTimersByTimeAsync(150);
    const waitingJob = jest.fn(async () => 'w');
    const waitingResult = q.enqueue('w', 'w', waitingJob).then(() => 'resolved', (e: Error) => e);
    expect(q.shutdown()).toEqual({ waiting: 1, running: 1 });
    expect(await waitingResult).toBeInstanceOf(BackgroundQueueStoppedError);
    await expect(q.enqueue('late', 'late', async () => 'x')).rejects.toBeInstanceOf(BackgroundQueueStoppedError);
    blocker.finish('done');
    await jest.advanceTimersByTimeAsync(500);
    expect(waitingJob).not.toHaveBeenCalled();
  });

  it('the shared line has a long waiting limit and a timeout that is longer than any normal job', () => {
    expect(HEAVY_BACKGROUND_DEFAULT_MAX_WAITING).toBeGreaterThanOrEqual(100);
    expect(HEAVY_BACKGROUND_DEFAULT_JOB_TIMEOUT_MS).toBeGreaterThanOrEqual(20 * 60 * 1000);
  });

  it('keeps going after a job fails, and the caller sees the failure', async () => {
    const q = new BackgroundQueue(opts());
    const bad = q.enqueue('bad', 'bad', async () => { throw new Error('boom'); });
    const badResult = bad.then(() => 'resolved', (e: Error) => e.message);
    const good = jest.fn(async () => 'fine');
    const p2 = q.enqueue('good', 'good', good);
    await jest.advanceTimersByTimeAsync(500);
    await expect(badResult).resolves.toBe('boom');
    await expect(p2).resolves.toBe('fine');
  });

  it('a job function that throws before returning a promise fails like any job and does not block the line', async () => {
    const q = new BackgroundQueue(opts());
    const bad = q.enqueue('bad', 'bad', (() => { throw new Error('sync boom'); }) as unknown as () => Promise<string>);
    const badResult = bad.then(() => 'resolved', (e: Error) => e.message);
    const good = jest.fn(async () => 'fine');
    const p2 = q.enqueue('good', 'good', good);
    await jest.advanceTimersByTimeAsync(500);
    await expect(badResult).resolves.toBe('sync boom');
    await expect(p2).resolves.toBe('fine');
    expect(q.size).toEqual({ running: 0, waiting: 0 });
  });

  it('with concurrency 0 runs at once, as before the queue existed', async () => {
    const q = new BackgroundQueue(opts({ concurrency: 0 }));
    const job = jest.fn(async () => 'now');
    const p = q.enqueue('a', 'a', job);
    expect(job).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBe('now');
  });

  it('allows more jobs at once when concurrency is raised', async () => {
    const q = new BackgroundQueue(opts({ concurrency: 2 }));
    const a = controllable();
    const b = controllable();
    q.enqueue('a', 'a', a.work);
    q.enqueue('b', 'b', b.work);
    await jest.advanceTimersByTimeAsync(150);
    expect(a.work).toHaveBeenCalledTimes(1);
    expect(b.work).toHaveBeenCalledTimes(1);
    a.finish('a'); b.finish('b');
  });
});
