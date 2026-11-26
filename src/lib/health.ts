/**
 * PINIT-DNA — Health Check Service (Phase 6)
 *
 * Provides detailed health status for:
 *   - Database connectivity
 *   - Vault storage directory
 *   - Encryption configuration
 *   - System memory
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { prisma } from './prisma';
import { config } from '../config';
import { isCloudStorageConfigured, activeStorageBackend, checkStorageReachability } from './vault-storage-backend';
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
    database:   ComponentHealth;
    vault:      ComponentHealth;
    storage:    ComponentHealth;
    encryption: ComponentHealth;
    supabase:   ComponentHealth;
    memory:     ComponentHealth;
    redis:      ComponentHealth;
  };
}

export async function getHealthReport(): Promise<HealthReport> {
  const checks = await Promise.allSettled([
    checkDatabase(),
    checkVaultDirectory(),
    checkStorageDirectory(),
    checkEncryptionConfig(),
    checkSupabaseStorage(),
    checkMemory(),
    checkRedis(),
  ]);

  const [database, vault, storage, encryption, supabase, memory, redis] = checks.map(r =>
    r.status === 'fulfilled' ? r.value : { status: 'unhealthy' as const, message: String((r as PromiseRejectedResult).reason) }
  );

  // redis is reported but deliberately excluded from the overall verdict.
  // Redis (Phase 4) is optional today: every Redis-backed feature (shared
  // rate-limit store, caching) has a defined, safe fallback for "Redis
  // unavailable" (see src/lib/rate-limit-store.ts's failure-policy design) —
  // a Redis outage must not remove an otherwise-healthy Hub instance from
  // load-balancer rotation over a non-critical dependency.
  const core = [database, vault, storage, encryption, supabase, memory];
  const allHealthy = core.every(c => c.status === 'healthy');
  const anyUnhealthy = core.some(c => c.status === 'unhealthy');

  return {
    status:    allHealthy ? 'healthy' : anyUnhealthy ? 'unhealthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime:    Math.round(process.uptime()),
    version:   config.dna.engineVersion,
    components: { database, vault, storage, encryption, supabase, memory, redis },
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

function checkVaultDirectory(): ComponentHealth {
  const vaultDir = config.vault.storageDir;
  if (!fs.existsSync(vaultDir)) {
    return { status: 'unhealthy', message: `Vault directory missing: ${vaultDir}` };
  }
  try {
    const testFile = path.join(vaultDir, `.health_${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { status: 'healthy', message: `Vault directory writable: ${vaultDir}` };
  } catch {
    return { status: 'degraded', message: `Vault directory not writable: ${vaultDir}` };
  }
}

function checkStorageDirectory(): ComponentHealth {
  const tempDir = config.upload.tempDir;
  if (!fs.existsSync(tempDir)) {
    try { fs.mkdirSync(tempDir, { recursive: true }); }
    catch { return { status: 'unhealthy', message: `Upload temp directory cannot be created: ${tempDir}` }; }
  }
  return { status: 'healthy', message: `Upload temp directory ready: ${tempDir}` };
}

function checkEncryptionConfig(): ComponentHealth {
  const secret = config.vault.masterSecret;
  if (!secret || secret.includes('dev_vault') || secret.length < 24) {
    return { status: 'degraded', message: 'Vault master secret appears to be default/weak — set VAULT_MASTER_SECRET env var' };
  }
  return { status: 'healthy', message: 'Encryption configuration valid' };
}

// Phase 9 — REL7-03 fix. Bounds the live reachability probe below so a slow
// or hanging storage provider degrades this one component instead of
// stalling the whole health report.
const STORAGE_REACHABILITY_TIMEOUT_MS = parseInt(process.env['HEALTH_STORAGE_REACHABILITY_TIMEOUT_MS'] ?? '', 10) || 3_000;

// Key stays 'supabase' below for backward compatibility with any dashboard
// reading this specific field, even though it now reports whichever object
// storage backend (Supabase or S3) is actually active — see config.storage.backend.
//
// Phase 9 — REL7-03: this used to return after checking only that the
// required env vars were present, so a real Storage outage with correct
// credentials still configured was invisible here — /health reported
// "healthy" throughout. Now also performs one bounded, real round-trip
// against the bucket once configuration is confirmed present, and reports
// configured-but-unreachable distinctly from not-configured and from
// genuinely healthy.
async function checkSupabaseStorage(): Promise<ComponentHealth> {
  const backend = activeStorageBackend();
  const label = backend === 's3' ? 'S3' : 'Supabase';
  const requiredVarsMessage = backend === 's3'
    ? 'S3_BUCKET (and AWS credentials) are required in production for share links and vault retrieval'
    : 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required in production for share links and vault retrieval';

  if (process.env['NODE_ENV'] !== 'production') {
    return isCloudStorageConfigured()
      ? { status: 'healthy', message: `${label} Storage configured (dev)` }
      : { status: 'healthy', message: 'No cloud storage set — using local vault disk (dev)' };
  }
  if (!isCloudStorageConfigured()) {
    return { status: 'unhealthy', message: requiredVarsMessage };
  }

  const start = Date.now();
  try {
    await Promise.race([
      checkStorageReachability(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`no answer after ${STORAGE_REACHABILITY_TIMEOUT_MS}ms`)), STORAGE_REACHABILITY_TIMEOUT_MS);
      }),
    ]);
    return { status: 'healthy', message: `${label} Storage reachable`, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'unhealthy',
      message: `${label} Storage configured but unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
    };
  }
}

// Absolute-MB thresholds only make sense relative to how much memory this
// process is actually allocated — a fixed 512MB "degraded" floor is fine on a
// multi-GB host but would permanently degrade a small ECS task sized to,
// say, 512MB total. Override via env once the real ECS task memory is known;
// defaults below match this app's original Render-tuned values (no behavior
// change until the overrides are set).
const MEMORY_CRITICAL_FREE_MB = parseInt(process.env['HEALTH_MEMORY_CRITICAL_FREE_MB'] ?? '', 10) || 96;
const MEMORY_DEGRADED_FREE_MB = parseInt(process.env['HEALTH_MEMORY_DEGRADED_FREE_MB'] ?? '', 10) || 512;
const MEMORY_DEGRADED_USED_PCT = parseInt(process.env['HEALTH_MEMORY_DEGRADED_USED_PCT'] ?? '', 10) || 90;

function checkMemory(): ComponentHealth {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedPct  = Math.round((1 - freeMem / totalMem) * 100);
  const freeMb   = Math.round(freeMem / 1024 / 1024);

  // Windows reports a high used-% while the working set still has hundreds of
  // MB free. Treating that as unhealthy made GET /health 503, and the Hub UI
  // showed "Backend starting" even though ping and dashboard APIs were 200.
  if (freeMb < MEMORY_CRITICAL_FREE_MB) {
    return { status: 'unhealthy', message: `Memory critical: ${usedPct}% used, ${freeMb}MB free` };
  }
  if (usedPct > MEMORY_DEGRADED_USED_PCT || freeMb < MEMORY_DEGRADED_FREE_MB) {
    return { status: 'degraded',  message: `Memory high: ${usedPct}% used, ${freeMb}MB free` };
  }
  return { status: 'healthy', message: `Memory OK: ${usedPct}% used, ${freeMb}MB free` };
}
