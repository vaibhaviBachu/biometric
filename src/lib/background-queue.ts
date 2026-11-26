/**
 * A line for heavy work nobody is waiting for.
 *
 * Every protected photo starts several background jobs (the patch index, the block and pixel enrolment). They ran at once, and
 * at the same moment as the upload the owner was still waiting on, on a server with very little CPU. The index alone costs
 * 40 s to 150 s of CPU for one photo, and the same index was being built twice for the same photo. A phone then waited for a
 * Vault copy that was slowed by work it did not need yet, and gave up.
 *
 * This queue changes WHEN that work runs, never what it computes:
 *  - jobs run a short moment after they are queued, so the response that queued them goes out first;
 *  - only a few run at a time (one by default);
 *  - a job with the same key as one that is already waiting or running is not repeated: it shares that job's result;
 *  - a job that runs for too long gives its place back (HEAVY_BACKGROUND_JOB_TIMEOUT_MS), so one stuck job cannot hold the
 *    whole line for ever;
 *  - when the line is full the new job is REFUSED (its promise rejects with BackgroundQueueFullError). It is never run
 *    straight away on top of the job that is already running: on a 1-CPU server that is exactly what froze the API.
 *
 * WHAT A WAITING JOB MAY HOLD. Memory is bounded by the rule that a queued job's function captures only small identifiers
 * (a vault id, a record id), never a photo. It loads the photo itself when its turn comes (see
 * src/services/vault/heavy-background-jobs.ts). A function that captured a 17 MB buffer would keep it alive for as long as it
 * waits; this class cannot check that, so callers must follow the rule.
 *
 * A refused, timed-out or shut-down job is not lost for good: it is found again by the recovery sweep
 * (src/services/vault/heavy-background-recovery.ts), which looks at the data the jobs write.
 *
 * HEAVY_BACKGROUND_CONCURRENCY, HEAVY_BACKGROUND_DELAY_MS, HEAVY_BACKGROUND_MAX_WAITING and HEAVY_BACKGROUND_JOB_TIMEOUT_MS tune
 * it. Concurrency 0 turns the queue off (jobs run immediately, as before the queue existed), apart from the same-key sharing.
 */

import { logger } from './logger';
import { runWithoutSignal } from './cancellation';

export class BackgroundQueueFullError extends Error {
  readonly code = 'BACKGROUND_QUEUE_FULL';
  constructor(label: string) {
    super(`The background line is full; "${label}" was not started.`);
    this.name = 'BackgroundQueueFullError';
  }
}

export class BackgroundJobTimeoutError extends Error {
  readonly code = 'BACKGROUND_JOB_TIMEOUT';
  constructor(label: string, ms: number) {
    super(`The background job "${label}" ran for more than ${Math.round(ms / 1000)} s and gave up its place.`);
    this.name = 'BackgroundJobTimeoutError';
  }
}

export class BackgroundQueueStoppedError extends Error {
  readonly code = 'BACKGROUND_QUEUE_STOPPED';
  constructor(label: string) {
    super(`The background line is stopping; "${label}" was not started.`);
    this.name = 'BackgroundQueueStoppedError';
  }
}

interface Waiting {
  label: string;
  key: string;
  run: () => Promise<void>;
  /** Rejects the caller's promise (used when the line stops or the job times out). */
  fail: (err: Error) => void;
}

export interface BackgroundQueueOptions {
  concurrency: number;
  startDelayMs: number;
  maxWaiting: number;
  /** A running job that has not finished after this long gives its place back. 0 or missing = no limit. */
  jobTimeoutMs?: number;
}

export interface BackgroundQueueStats {
  running: number;
  waiting: number;
  /** Jobs refused because the line was full, since the process started. */
  refusedFull: number;
  /** Jobs that gave up their place after running too long, since the process started. */
  timedOut: number;
  /** Timed-out jobs that are, as far as we know, still running somewhere in the background. */
  abandonedStillRunning: number;
}

export class BackgroundQueue {
  private running = 0;
  private stopped = false;
  private refusedFull = 0;
  private timedOut = 0;
  private abandonedStillRunning = 0;
  private readonly waiting: Waiting[] = [];
  private readonly shared = new Map<string, Promise<unknown>>();

  constructor(private readonly options: () => BackgroundQueueOptions) {}

  /** How many jobs are running and waiting right now. */
  get size(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  stats(): BackgroundQueueStats {
    return {
      running: this.running,
      waiting: this.waiting.length,
      refusedFull: this.refusedFull,
      timedOut: this.timedOut,
      abandonedStillRunning: this.abandonedStillRunning,
    };
  }

  /**
   * Queues `work` and resolves with its result. A second call with the same key, while the first is waiting or running,
   * gets the first call's result instead of running again. Rejects with BackgroundQueueFullError when the line is full.
   */
  enqueue<T>(key: string, label: string, rawWork: () => Promise<T>): Promise<T> {
    // A job function that throws before it returns a promise must fail like any other failed job. Left alone, the throw
    // happens inside a timer: it would be an uncaught exception (which shuts the server down), and the slot it took would
    // never be given back.
    // A queued job belongs to no request: it runs without the cancel signal of whichever request queued it, so a Trace stage
    // that times out (or a browser that leaves) cannot cancel background indexing that happened to be queued during it.
    const work = (): Promise<T> => {
      try { return Promise.resolve(runWithoutSignal(rawWork)); } catch (err) { return Promise.reject(err); }
    };
    const already = this.shared.get(key);
    if (already) {
      logger.info('[BackgroundQueue] Same job already queued; sharing its result', { label, key: key.slice(0, 40) });
      return already as Promise<T>;
    }
    if (this.stopped) return Promise.reject(new BackgroundQueueStoppedError(label));

    const opts = this.options();
    const result = new Promise<T>((resolve, reject) => {
      if (opts.concurrency <= 0) {
        work().then(resolve, reject);
        return;
      }
      if (this.waiting.length >= opts.maxWaiting) {
        this.refusedFull++;
        logger.error('[BackgroundQueue] Line is full; this job was refused (the recovery sweep will find it again)', {
          label, key: key.slice(0, 40), waiting: this.waiting.length, refusedFull: this.refusedFull,
        });
        reject(new BackgroundQueueFullError(label));
        return;
      }
      this.waiting.push({ label, key, run: () => work().then(resolve, reject), fail: reject });
      this.pump();
    }).finally(() => {
      this.shared.delete(key);
    });

    this.shared.set(key, result);
    return result;
  }

  /**
   * Stops starting jobs. Waiting jobs are refused (their callers see BackgroundQueueStoppedError); a running job is left to
   * finish or be cut off by the process ending. Returns what was still waiting or running, for the shutdown log.
   */
  shutdown(): { waiting: number; running: number } {
    this.stopped = true;
    const left = { waiting: this.waiting.length, running: this.running };
    for (const job of this.waiting.splice(0)) job.fail(new BackgroundQueueStoppedError(job.label));
    return left;
  }

  /** Test hook: lets a stopped line run again. */
  resetForTests(): void {
    this.stopped = false;
    this.refusedFull = 0;
    this.timedOut = 0;
    this.abandonedStillRunning = 0;
  }

  private pump(): void {
    if (this.stopped) return;
    const opts = this.options();
    while (this.running < Math.max(1, opts.concurrency) && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running++;
      const timer = setTimeout(() => this.start(job, opts.jobTimeoutMs ?? 0), opts.startDelayMs);
      timer.unref?.();
    }
  }

  private start(job: Waiting, timeoutMs: number): void {
    const started = Date.now();
    let settled = false;
    let watchdog: NodeJS.Timeout | null = null;

    /** Gives the place back exactly once, whether the job ended or the watchdog gave up on it. */
    const releasePlace = (): boolean => {
      if (settled) return false;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      this.running--;
      this.pump();
      return true;
    };

    if (timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (!releasePlace()) return;
        this.timedOut++;
        this.abandonedStillRunning++;
        logger.error('[BackgroundQueue] A job ran too long and gave up its place; it may still be running', {
          label: job.label, key: job.key.slice(0, 40), ms: Date.now() - started, timeoutMs, timedOut: this.timedOut,
        });
        job.fail(new BackgroundJobTimeoutError(job.label, timeoutMs));
      }, timeoutMs);
      watchdog.unref?.();
    }

    void job.run()
      .catch(() => undefined) // the caller of enqueue() sees the failure through its promise
      .finally(() => {
        if (!releasePlace()) {
          // The watchdog already gave this job's place away; it has now ended after all.
          this.abandonedStillRunning = Math.max(0, this.abandonedStillRunning - 1);
          logger.warn('[BackgroundQueue] A job that had been given up on has now finished', { label: job.label, ms: Date.now() - started });
          return;
        }
        logger.debug('[BackgroundQueue] Job finished', { label: job.label, ms: Date.now() - started, waiting: this.waiting.length });
      });
  }
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * How many jobs may wait in line. A waiting job holds only a few identifiers (see the top of this file), so the line can be
 * long. A protect starts two heavy jobs, so 200 covers about a hundred uploads that have not been worked off yet, which on a
 * 1-CPU server is already hours of work. Past that a job is refused rather than run on top of the others.
 */
export const HEAVY_BACKGROUND_DEFAULT_MAX_WAITING = 200;

/**
 * How long one job may run before it gives up its place. The longest legitimate job seen in production logs took 5 minutes
 * (the patch index of a 3 MB photo on a busy 1-CPU server), so 30 minutes only ever catches a job that is truly stuck.
 */
export const HEAVY_BACKGROUND_DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/** The queue shared by all heavy background work started after a protect. */
export const heavyBackground = new BackgroundQueue(() => ({
  concurrency: intFromEnv('HEAVY_BACKGROUND_CONCURRENCY', 1),
  startDelayMs: intFromEnv('HEAVY_BACKGROUND_DELAY_MS', 1500),
  maxWaiting: intFromEnv('HEAVY_BACKGROUND_MAX_WAITING', HEAVY_BACKGROUND_DEFAULT_MAX_WAITING),
  jobTimeoutMs: intFromEnv('HEAVY_BACKGROUND_JOB_TIMEOUT_MS', HEAVY_BACKGROUND_DEFAULT_JOB_TIMEOUT_MS),
}));
