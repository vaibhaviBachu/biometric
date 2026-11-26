/**
 * A bounded line for heavy forensic work (investigations, public scans).
 *
 * Before this, any number of investigations could start in the same instant: four people investigating at once meant four
 * searches fighting over one CPU and a 2 GB container, and the slowest part of every one of them was waiting for the others.
 * The gate lets a few run, keeps the rest in a short first-come line, and answers "busy, try again in N seconds" when even
 * the line is full or the wait is too long. It never refuses a job for being big, and it never touches what a job computes.
 *
 *  - at most `slots` jobs run at once;
 *  - at most `perUser` of them belong to one user (so one person cannot take every slot);
 *  - at most `queue` jobs wait; one more is refused at once;
 *  - a job waits at most `waitMs`, then is refused;
 *  - a waiting job whose caller went away (aborted) leaves the line.
 *
 * FORENSIC_ADMISSION=off lets everything straight through, as before.
 */
import { performance } from 'perf_hooks';
import { AbortedError } from './cancellation';

export class GateBusyError extends Error {
  readonly code = 'SERVER_BUSY';
  readonly status = 503;
  constructor(readonly retryAfterSeconds: number, why: string) {
    super(`PINIT is busy with other checks right now (${why}). Please try again in about ${retryAfterSeconds} seconds.`);
    this.name = 'GateBusyError';
  }
}

export interface GateLimits {
  slots: number;
  perUser: number;
  queue: number;
  waitMs: number;
}

interface Waiter {
  userId: string;
  label: string;
  since: number;
  grant: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface GateStats {
  name: string;
  running: number;
  waiting: number;
  peakWaiting: number;
  admitted: number;
  refused: number;
  abandoned: number;
  averageWaitMs: number;
  longestWaitMs: number;
}

export class HeavyGate {
  private running = 0;
  private readonly perUserRunning = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  private admitted = 0;
  private refused = 0;
  private abandoned = 0;
  private peakWaiting = 0;
  private waitTotalMs = 0;
  private longestWaitMs = 0;

  constructor(
    readonly name: string,
    private readonly limits: () => GateLimits,
    private readonly enabled: () => boolean = () => true,
  ) {}

  stats(): GateStats {
    return {
      name: this.name,
      running: this.running,
      waiting: this.waiting.length,
      peakWaiting: this.peakWaiting,
      admitted: this.admitted,
      refused: this.refused,
      abandoned: this.abandoned,
      averageWaitMs: this.admitted ? Math.round(this.waitTotalMs / this.admitted) : 0,
      longestWaitMs: Math.round(this.longestWaitMs),
    };
  }

  private canStart(userId: string, l: GateLimits): boolean {
    return this.running < l.slots && (this.perUserRunning.get(userId) ?? 0) < l.perUser;
  }

  private start(userId: string): () => void {
    this.running++;
    this.perUserRunning.set(userId, (this.perUserRunning.get(userId) ?? 0) + 1);
    this.admitted++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const n = (this.perUserRunning.get(userId) ?? 1) - 1;
      if (n <= 0) this.perUserRunning.delete(userId);
      else this.perUserRunning.set(userId, n);
      this.pump();
    };
  }

  /** Starts waiting jobs, first come first served, skipping any whose user is already at their own limit. */
  private pump(): void {
    const l = this.limits();
    for (let i = 0; i < this.waiting.length && this.running < l.slots; ) {
      const w = this.waiting[i]!;
      if (!this.canStart(w.userId, l)) { i++; continue; }
      this.waiting.splice(i, 1);
      clearTimeout(w.timer);
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.grant();
    }
  }

  /**
   * Would a job for this user start right now, without waiting? Read-only: it does not take a place. The background Trace runner asks
   * this before it starts a queued investigation, so a job that has to wait is simply left queued, instead of sitting in this line
   * until its wait limit expires and being refused.
   */
  hasCapacity(userId = 'anonymous'): boolean {
    if (!this.enabled()) return true;
    return this.waiting.length === 0 && this.canStart(userId, this.limits());
  }

  /** A rough "try again in" figure: the average run so far is unknown here, so it grows with the line. */
  private retryAfter(): number {
    return Math.min(120, 15 + this.waiting.length * 10);
  }

  async run<T>(
    opts: { userId?: string; label: string; signal?: AbortSignal; onQueued?: (position: number) => void },
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled()) return fn();
    const userId = opts.userId ?? 'anonymous';
    const l = this.limits();

    let release: () => void;
    const since = performance.now();
    // A waiting job is only ever one that could not start (its user is at their limit, or no slot was free), so a newcomer who can start
    // does not queue behind it.
    if (this.canStart(userId, l)) {
      release = this.start(userId);
    } else {
      if (this.waiting.length >= l.queue) {
        this.refused++;
        throw new GateBusyError(this.retryAfter(), 'the line is full');
      }
      opts.onQueued?.(this.waiting.length + 1);
      release = await new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          userId,
          label: opts.label,
          since,
          signal: opts.signal,
          grant: () => resolve(this.start(userId)),
          reject,
          timer: setTimeout(() => {
            const at = this.waiting.indexOf(waiter);
            if (at >= 0) this.waiting.splice(at, 1);
            if (waiter.onAbort) opts.signal?.removeEventListener('abort', waiter.onAbort);
            this.refused++;
            reject(new GateBusyError(this.retryAfter(), 'it waited too long for a free place'));
          }, l.waitMs),
        };
        if (opts.signal) {
          waiter.onAbort = () => {
            const at = this.waiting.indexOf(waiter);
            if (at >= 0) this.waiting.splice(at, 1);
            clearTimeout(waiter.timer);
            this.abandoned++;
            reject(new AbortedError('the caller went away while waiting'));
          };
          if (opts.signal.aborted) { waiter.onAbort(); return; }
          opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        this.waiting.push(waiter);
        this.peakWaiting = Math.max(this.peakWaiting, this.waiting.length);
      });
      const waited = performance.now() - since;
      this.waitTotalMs += waited;
      this.longestWaitMs = Math.max(this.longestWaitMs, waited);
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }
}
