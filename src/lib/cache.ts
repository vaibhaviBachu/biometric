/**
 * PINIT-DNA — Redis cache-aside helper (Phase 4)
 *
 * A small, generic cache-aside wrapper, not a framework. Every call site is
 * expected to choose its own key, TTL and (where the data is tenant-scoped)
 * include the tenant/owner id in the key itself — this module does not
 * invent tenant scoping on a caller's behalf.
 *
 * Fails open to "no cache": if Redis is disabled (default) or a Redis
 * command fails at request time, `getOrSetCache` just calls `loader()`
 * directly — a cache is strictly an optimization here, never a path that can
 * make a request fail or behave differently from the uncached path. This is
 * deliberately simpler than the rate-limiter's fail-open/fail-closed policy
 * (src/lib/rate-limit-store.ts): caching is never the security-relevant
 * decision itself, so there is no "fail closed" mode for a cache — the
 * loader (which performs the real authorization/data check) always runs on
 * any cache miss or Redis failure.
 */
import { getRedisClient } from './redis-client';
import { logger } from './logger';

export async function getOrSetCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const client = getRedisClient();
  if (!client) return loader();

  try {
    const cached = await client.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    logger.warn('[cache] read failed — falling through to loader', { key, error: String(err) });
  }

  const value = await loader();

  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[cache] write failed — value served uncached this time', { key, error: String(err) });
  }

  return value;
}

export async function invalidateCache(key: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.del(key);
  } catch (err) {
    logger.warn('[cache] invalidation failed', { key, error: String(err) });
  }
}
