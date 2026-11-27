/**
 * PINIT — Health Check Service
 *
 * Database connectivity + memory only. This used to also check Vault storage
 * directory/encryption and Supabase/S3 reachability — all removed along with
 * the Vault feature itself. Keeping those checks meant /health reported
 * "unhealthy" in production purely because SUPABASE_URL wasn't set for a
 * feature this app doesn't have, which is worse than no check at all.
 */

import os from 'os';
import { prisma } from './prisma';
import { config } from '../config';
import { isRedisHealthy } from './redis-client';

export interface ComponentHealth {
  status:  'healthy' | 'degraded' | 'unhealthy';
  message: string;
  latencyMs?: number;
}

export interface HealthReport {
  status:    'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime:    number;
  version:   string;
  components: {
    database: ComponentHealth;
    memory:   ComponentHealth;
    redis:    ComponentHealth;
  };
}

export async function getHealthReport(): Promise<HealthReport> {
  const checks = await Promise.allSettled([
    checkDatabase(),
    checkMemory(),
    checkRedis(),
  ]);

  const [database, memory, redis] = checks.map(r =>
    r.status === 'fulfilled' ? r.value : { status: 'unhealthy' as const, message: String((r as PromiseRejectedResult).reason) }
  );

  // redis is reported but deliberately excluded from the overall verdict —
  // every Redis-backed feature (shared rate-limit store) has a defined, safe
  // fallback for "Redis unavailable" (src/lib/rate-limit-store.ts), so a
  // Redis outage must not take an otherwise-healthy instance out of rotation.
  const core = [database, memory];
  const allHealthy = core.every(c => c.status === 'healthy');
  const anyUnhealthy = core.some(c => c.status === 'unhealthy');

  return {
    status:    allHealthy ? 'healthy' : anyUnhealthy ? 'unhealthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime:    Math.round(process.uptime()),
    version:   config.dna.engineVersion,
    components: { database, memory, redis },
  };
}

async function checkRedis(): Promise<ComponentHealth> {
  const result = await isRedisHealthy();
  return result.healthy
    ? { status: 'healthy', message: result.message, latencyMs: result.latencyMs }
    : { status: 'degraded', message: result.message };
}

async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'healthy', message: 'Database responding', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', message: `Database unreachable: ${String(err).slice(0, 80)}` };
  }
}

// Absolute-MB thresholds only make sense relative to how much memory this
// process is actually allocated — a fixed 512MB "degraded" floor is fine on a
// multi-GB host but would permanently degrade a small ECS task sized to,
// say, 512MB total. Override via env once the real target memory is known.
const MEMORY_CRITICAL_FREE_MB = parseInt(process.env['HEALTH_MEMORY_CRITICAL_FREE_MB'] ?? '', 10) || 96;
const MEMORY_DEGRADED_FREE_MB = parseInt(process.env['HEALTH_MEMORY_DEGRADED_FREE_MB'] ?? '', 10) || 512;
const MEMORY_DEGRADED_USED_PCT = parseInt(process.env['HEALTH_MEMORY_DEGRADED_USED_PCT'] ?? '', 10) || 90;

function checkMemory(): ComponentHealth {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedPct  = Math.round((1 - freeMem / totalMem) * 100);
  const freeMb   = Math.round(freeMem / 1024 / 1024);

  // Windows reports a high used-% while the working set still has hundreds of
  // MB free. Treating that as unhealthy made GET /health 503, and the UI
  // showed "Backend starting" even though ping and the API itself were 200.
  if (freeMb < MEMORY_CRITICAL_FREE_MB) {
    return { status: 'unhealthy', message: `Memory critical: ${usedPct}% used, ${freeMb}MB free` };
  }
  if (usedPct > MEMORY_DEGRADED_USED_PCT || freeMb < MEMORY_DEGRADED_FREE_MB) {
    return { status: 'degraded',  message: `Memory high: ${usedPct}% used, ${freeMb}MB free` };
  }
  return { status: 'healthy', message: `Memory OK: ${usedPct}% used, ${freeMb}MB free` };
}
