import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { isUnthrottledEnv } from '../../lib/rate-limit-env';
import { createSharedRateLimitStore, type FailurePolicy } from '../../lib/rate-limit-store';

/**
 * Rate limits for the share-link routes that need no sign-in. The global limiter skips every public share GET
 * on purpose (a busy viewer page must not be throttled with everyone else), which left token guessing, the
 * file download and the access-log writes unthrottled.
 *
 * The key is the caller's IP plus the link token, so people behind one office or phone network are not
 * throttled together across different links, and one link cannot be hammered from one address. Local
 * development and tests are not slowed down (same as the global limiter); every other environment — including
 * staging/preview deploys and a misconfigured or missing NODE_ENV — is limited by default (see
 * lib/rate-limit-env.ts — ASH-M03 fix).
 */
/**
 * Phase 4 — each limiter gets its own Redis key prefix (`share:<name>`) plus an
 * explicit failure policy. `createSharedRateLimitStore` returns `undefined`
 * when Redis is disabled (the default), so `store: undefined` below is
 * exactly today's behavior (express-rate-limit's own in-memory store) —
 * nothing changes for any deployment that does not set REDIS_ENABLED=true.
 */
function limiter(name: string, max: number, windowMs: number, message: string, failurePolicy: FailurePolicy) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isUnthrottledEnv,
    keyGenerator: (req: Request) => `${req.ip}:${String(req.params['token'] ?? '')}`,
    message: { success: false, error: message },
    store: createSharedRateLimitStore({ prefix: `rl:share:${name}:`, windowMs, failurePolicy }),
  });
}

/** Page loads, link info, review reads, message polling: generous, a viewer page makes many calls.
 *  fail-open — a busy viewer page must not go fully dark over a Redis blip. */
export const shareReadLimiter = limiter('read', 300, 60_000, 'Too many requests. Please slow down.', 'fail-open');

/** Writes that create database rows (access events, messages, comments, decisions). fail-open, same reasoning. */
export const shareWriteLimiter = limiter('write', 120, 60_000, 'Too many requests. Please slow down.', 'fail-open');

/** The file itself and the preview image: heavy, and rarely needed more than a few times per link. fail-open —
 *  cost/abuse control, not a security boundary. */
export const shareFileLimiter = limiter('file', 40, 10 * 60_000, 'Too many downloads. Please try again in a few minutes.', 'fail-open');

/**
 * Pictures on a public portfolio page: no sign-in, and a page loads a few dozen at once, so this is generous. The key is the
 * caller's address only. It stops one address from asking for pictures all day; the server's memory is protected separately.
 * The shared store is a no-op until REDIS_ENABLED=true, same as the share limiters above.
 */
export const portfolioMediaLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isUnthrottledEnv,
  keyGenerator: (req: Request) => `portfolio-media:${req.ip}`,
  message: { success: false, error: 'Too many requests. Please slow down.' },
  store: createSharedRateLimitStore({ prefix: 'rl:portfolio-media:', windowMs: 5 * 60_000, failurePolicy: 'fail-open' }),
});

/** Guessable secrets (one-time codes) and unmask requests: strict, and the one limiter in this file that
 *  fails CLOSED — under-enforcing brute-force protection on a guessable secret is worse than this one narrow
 *  endpoint returning 429 during a Redis outage; a per-link lockout also applies to codes independently. */
export const shareSecretLimiter = limiter('secret', 20, 15 * 60_000, 'Too many attempts. Please try again later.', 'fail-closed');
