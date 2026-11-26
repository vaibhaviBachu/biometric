/**
 * PINIT-DNA — Shared (Redis-backed) rate-limit store (Phase 4)
 *
 * Phase 3 found every `express-rate-limit` instance in this codebase uses the
 * library's default in-memory store, so each process instance counts hits
 * independently — a client spread across N instances effectively gets N times
 * the configured limit. This module provides an opt-in, Redis-backed shared
 * store so multiple Hub instances enforce one real limit.
 *
 * `createSharedRateLimitStore()` returns `undefined` whenever Redis is
 * disabled or unreachable at construction time — every call site must (and
 * does) fall back to `express-rate-limit`'s own default store in that case,
 * so today's single-instance/dev behavior is completely unchanged unless
 * REDIS_ENABLED=true is explicitly set.
 *
 * When Redis IS enabled but a command fails at request time (outage, timeout),
 * the failure is not silently absorbed into a per-instance memory counter —
 * that would reintroduce the exact bug this module exists to fix, just
 * invisibly. Instead each store is constructed with an explicit, named
 * failurePolicy:
 *   - 'fail-open'   — treat the request as the first hit of a fresh window
 *                     (i.e. allow it). Used for limiters whose job is cost/
 *                     abuse control, where an availability regression over a
 *                     secondary dependency is worse than temporarily reduced
 *                     enforcement.
 *   - 'fail-closed' — treat the request as far over the limit (i.e. deny it).
 *                     Used only for narrow, high-sensitivity endpoints (e.g.
 *                     a share link's secret-unlock attempt) where the blast
 *                     radius of denying is small and the cost of under-
 *                     enforcing brute-force protection is high.
 */
import { RedisStore } from 'rate-limit-redis';
import type { Store, Options as RateLimitOptions, IncrementResponse } from 'express-rate-limit';
import { getRedisClient } from './redis-client';
import { logger } from './logger';

export type FailurePolicy = 'fail-open' | 'fail-closed';

export interface SharedStoreConfig {
  /** Redis key prefix — must be unique per logical limiter to avoid collisions. */
  prefix: string;
  windowMs: number;
  failurePolicy: FailurePolicy;
}

/**
 * ioredis has a generic `.call(command, ...args)` escape hatch for raw
 * commands; ioredis-mock (used only in this codebase's own tests) does not,
 * and instead exposes each command as its own named method (`.evalsha`,
 * `.script`, ...). This dispatches to whichever is actually present so the
 * same RedisStore wiring works unmodified against real ioredis in production
 * and against ioredis-mock in tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendRawCommand(client: any, args: string[]): Promise<any> {
  if (typeof client.call === 'function') {
    return client.call(...args);
  }
  const [cmd, ...rest] = args;
  const method = client[String(cmd).toLowerCase()];
  if (typeof method !== 'function') {
    return Promise.reject(new Error(`sendRawCommand: no method available for "${cmd}"`));
  }
  return method.apply(client, rest);
}

export class SharedRedisRateLimitStore implements Store {
  windowMs: number;
  /** Matches express-rate-limit's own Store.prefix contract (double-count detection). */
  prefix: string;
  private readonly inner: RedisStore;
  private readonly policy: FailurePolicy;

  constructor(config: SharedStoreConfig, client: NonNullable<ReturnType<typeof getRedisClient>>) {
    this.windowMs = config.windowMs;
    this.policy = config.failurePolicy;
    this.prefix = config.prefix;
    this.inner = new RedisStore({
      sendCommand: (...args: string[]) => sendRawCommand(client, args),
      prefix: config.prefix,
    });

    // RedisStore's constructor unconditionally kicks off loading both its
    // increment and get Lua scripts the moment it is constructed — before
    // increment() is ever called, and even if it never is (e.g. a store that
    // is only ever constructed and discarded). Against an unreachable Redis,
    // those promises reject; a rejection with no attached handler is reported
    // by Node as an unhandled rejection. Attaching a second, no-op `.catch`
    // here does not suppress the real failure path — increment() separately
    // awaits (and correctly handles, via this class's own try/catch) the same
    // `incrementScriptSha` promise; a promise can have multiple independent
    // handlers. This just keeps construction itself from ever producing
    // process-level unhandled-rejection noise.
    this.inner.incrementScriptSha.catch(() => {});
    this.inner.getScriptSha.catch(() => {});
  }

  init(options: RateLimitOptions): void {
    this.inner.init(options);
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      return await this.inner.increment(key);
    } catch (err) {
      return this.onFailure(err);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.inner.decrement(key);
    } catch {
      /* best-effort only — a failed decrement just means a later window is
         very slightly over-counted, not a security-relevant outcome. */
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.inner.resetKey(key);
    } catch {
      /* best-effort only */
    }
  }

  private onFailure(err: unknown): IncrementResponse {
    logger.warn('[rate-limit] Redis store error — applying failure policy', {
      prefix: this.prefix,
      policy: this.policy,
      error: String(err),
    });
    const resetTime = new Date(Date.now() + this.windowMs);
    if (this.policy === 'fail-closed') {
      return { totalHits: Number.MAX_SAFE_INTEGER, resetTime };
    }
    return { totalHits: 1, resetTime };
  }
}

/**
 * Returns a shared Redis-backed store, or undefined if Redis is disabled —
 * callers must pass `undefined` straight through to `rateLimit({ store })`,
 * which falls back to the library's own default in-memory store.
 */
export function createSharedRateLimitStore(config: SharedStoreConfig): Store | undefined {
  const client = getRedisClient();
  if (!client) return undefined;
  return new SharedRedisRateLimitStore(config, client);
}
