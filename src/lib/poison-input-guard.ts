/**
 * Stops one problem file from using the server up again and again.
 *
 * When a picture crashes a worker, runs it out of memory or keeps it busy until the time limit, trying it again on the next request
 * (and the next) costs a worker start, the whole time limit and often a lot of memory, each time. This remembers such inputs, by a
 * fingerprint of their bytes, and refuses them for a while:
 *
 *   - after `maxFailures` failures that may be the input's own doing (crash, out of memory, timeout) the input is blocked for `ttlMs`;
 *   - when the block ends ONE request is let through (half open): if it succeeds the input is forgotten, if it fails the block starts again;
 *   - a caller that gave up, a worker that could not start, or a protocol problem never counts against the input;
 *   - the table is bounded, and the oldest entries go first.
 *
 * The fingerprint is a SHA-256 of the bytes (a sample for very large buffers: head, middle and tail plus the length), kept in memory
 * only. Nothing about the file's content or owner is stored.
 */
import { createHash } from 'crypto';

interface Entry {
  failures: number;
  /** When the current block ends (0 while not blocked). */
  blockedUntil: number;
  /** A trial request has been let through and has not answered yet. */
  trialRunning: boolean;
  lastFailureAt: number;
}

const SAMPLE_OVER_BYTES = 16 * 1024 * 1024;
const SAMPLE_BYTES = 1024 * 1024;

export function inputFingerprint(buffer: Buffer): string {
  const h = createHash('sha256');
  h.update(String(buffer.length));
  if (buffer.length <= SAMPLE_OVER_BYTES) {
    h.update(buffer);
  } else {
    const mid = Math.floor(buffer.length / 2) - Math.floor(SAMPLE_BYTES / 2);
    h.update(buffer.subarray(0, SAMPLE_BYTES));
    h.update(buffer.subarray(mid, mid + SAMPLE_BYTES));
    h.update(buffer.subarray(buffer.length - SAMPLE_BYTES));
  }
  return h.digest('hex');
}

export interface PoisonGuardOptions {
  maxFailures: () => number;
  ttlMs: () => number;
  now?: () => number;
  maxEntries?: number;
}

export class PoisonInputGuard {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: PoisonGuardOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Whether this input may be tried now. Returns true when it is not blocked, or when its block has ended and this is the one trial.
   * A caller that gets true MUST report back with `succeeded` or `failed` (or `abandoned`).
   */
  allow(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.blockedUntil === 0) return true;
    if (this.now() < e.blockedUntil) return false;
    if (e.trialRunning) return false;
    e.trialRunning = true;
    return true;
  }

  /** Whether the input is blocked right now, without taking the trial. */
  isBlocked(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && e.blockedUntil !== 0 && (this.now() < e.blockedUntil || e.trialRunning);
  }

  /** The work on this input completed: forget it. */
  succeeded(key: string): void {
    this.entries.delete(key);
  }

  /** The caller gave up or the failure was not the input's doing: nothing is learnt, a trial may be taken again. */
  abandoned(key: string): void {
    const e = this.entries.get(key);
    if (e) e.trialRunning = false;
  }

  /** A failure that may be the input's own doing. */
  failed(key: string): void {
    const now = this.now();
    const e = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, trialRunning: false, lastFailureAt: now };
    e.failures += 1;
    e.lastFailureAt = now;
    if (e.trialRunning || e.failures >= this.options.maxFailures()) {
      e.blockedUntil = now + this.options.ttlMs();
      e.trialRunning = false;
    }
    this.entries.delete(key);
    this.entries.set(key, e); // most recent last
    const max = this.options.maxEntries ?? 500;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
