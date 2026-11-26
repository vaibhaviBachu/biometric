/**
 * PINIT-DNA — Redis-backed distributed lock (Phase 4)
 *
 * Found this phase: every `node-cron` job in vault-scheduler.service.ts runs
 * unconditionally on every process that calls `.start()` (src/server.ts's
 * onServerReady(), called by every Hub instance with no guard) — on a single
 * instance this is correct; on N instances it means N instances each running
 * the daily integrity check, the certificate-expiry sweep and the share-link
 * expiry sweep independently. The DB writes involved are idempotent (setting
 * a status to EXPIRED/REVOKED N times has the same end state as once), but
 * the *notifications* fired alongside them
 * (emitCertificateExpired/emitLinkExpired/emitVaultIntegrityIssue) are not —
 * a user would receive N duplicate "your certificate expired" notifications
 * from an N-instance deployment. The monitoring crawler (runDueChecks(),
 * every 2 minutes when enabled) is a sharper case: duplicate concurrent runs
 * mean duplicate calls against external, quota-limited APIs (YouTube,
 * GitHub) for the same due check.
 *
 * `tryAcquireLock` lets exactly one instance "win" a given job's run for a
 * given lock window, using Redis's atomic `SET key value NX PX ttlMs`. When
 * Redis is disabled (today's default everywhere), this always returns true —
 * i.e. exactly today's behavior (every instance runs every job) — so wiring
 * this into the scheduler is a safe, backward-compatible no-op until
 * REDIS_ENABLED=true is explicitly set.
 */
import { randomUUID } from 'crypto';
import { getRedisClient } from './redis-client';
import { logger } from './logger';

export async function tryAcquireLock(key: string, ttlMs: number): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return true; // no Redis configured — every instance proceeds, unchanged from today

  const token = randomUUID();
  try {
    const result = await client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    // Fail open: a lock-service outage must not silently stop every scheduled
    // job from running anywhere. The cost of over-running (duplicate, mostly
    // idempotent work) is lower than the cost of under-running (a daily
    // integrity check that silently never executes on any instance).
    logger.warn('[lock] Redis error acquiring lock — proceeding without it (fail-open)', { key, error: String(err) });
    return true;
  }
}
