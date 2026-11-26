/** Lets an action run at most once per key per interval (for example one log row per link and caller per 10 minutes). */
export class OncePerInterval {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs: number, private readonly now: () => number = Date.now) {}

  shouldRun(key: string): boolean {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.intervalMs) return false;
    this.last.set(key, t);
    if (this.last.size > 5000) {
      for (const [k, at] of this.last) if (t - at >= this.intervalMs) this.last.delete(k);
    }
    return true;
  }
}

/**
 * Counts failed attempts per key (for example a share token) and locks the key out for a while after too many.
 *
 * In memory, per server process: enough to stop online guessing against one link on a single instance, and it
 * resets on restart. A multi-instance deployment needs a shared store (database or Redis) instead.
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds the key stays locked, or 0 when it may try. */
  lockedForMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const t = this.now();
    if (entry.lockedUntil > t) return entry.lockedUntil - t;
    if (t - entry.windowStart > this.windowMs) this.entries.delete(key);
    return 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    const entry = this.entries.get(key);
    if (!entry || t - entry.windowStart > this.windowMs) {
      this.entries.set(key, { failures: 1, windowStart: t, lockedUntil: 0 });
    } else {
      entry.failures += 1;
      if (entry.failures >= this.maxFailures) entry.lockedUntil = t + this.lockMs;
    }
    if (this.entries.size > 10_000) this.prune();
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= t && t - entry.windowStart > this.windowMs) this.entries.delete(key);
    }
  }
}
