/**
 * PINIT-DNA — Shared Redis client (Phase 4)
 *
 * Returns null whenever config.redis.enabled is false (the default), so every
 * consumer (rate limiter, cache) must have a defined behavior for "no Redis"
 * that does not throw — this module never silently requires Redis to exist.
 *
 * `enableOfflineQueue: false` + a short `commandTimeout` are deliberate: a
 * rate-limit or cache check must fail fast (so the caller's own fail-open/
 * fail-closed policy can run) rather than queue commands indefinitely against
 * a Redis instance that is down, which would make every request hang.
 */
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

let client: Redis | null = null;
let loggedUnavailable = false;

export function getRedisClient(): Redis | null {
  if (!config.redis.enabled) return null;

  if (!client) {
    client = new Redis(config.redis.url, {
      connectTimeout: config.redis.connectTimeoutMs,
      commandTimeout: config.redis.commandTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });

    client.on('error', (err) => {
      if (!loggedUnavailable) {
        loggedUnavailable = true;
        logger.warn('[Redis] connection error — dependent features will use their fail-open/fail-closed fallback', {
          error: err.message,
        });
      }
    });

    client.on('connect', () => {
      loggedUnavailable = false;
      logger.info('[Redis] connected', { url: redactRedisUrl(config.redis.url) });
    });

    client.connect().catch(() => {
      /* 'error' listener above already logs; initial connect failures must not throw here */
    });
  }

  return client;
}

export async function isRedisHealthy(): Promise<{ healthy: boolean; latencyMs?: number; message: string }> {
  if (!config.redis.enabled) {
    return { healthy: true, message: 'Redis disabled (REDIS_ENABLED=false) — not a dependency today' };
  }
  const c = getRedisClient();
  if (!c) return { healthy: true, message: 'Redis disabled' };

  const start = Date.now();
  try {
    await c.ping();
    return { healthy: true, latencyMs: Date.now() - start, message: 'Redis responding' };
  } catch (err) {
    return { healthy: false, message: `Redis unreachable: ${String(err).slice(0, 80)}` };
  }
}

/** For tests only — drops the singleton so a fresh client/mock can be installed. */
export function resetRedisClientForTests(): void {
  client = null;
  loggedUnavailable = false;
}

function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = u.password ? '***' : '';
    return u.toString();
  } catch {
    return 'redis://***';
  }
}
