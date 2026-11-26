/**
 * How many CPUs this process may really use.
 *
 * Inside a container, `os.cpus()` lists the CPUs of the whole host (16 on Render), not the share the service is given (1 on the
 * 1 CPU / 2 GB plan). Anything sized from it, such as how many worker threads to start or whether to use them at all, is then
 * sized for a machine the service does not have. The container's own limit is in the cgroup files; this reads it, and falls back
 * to the host's count when there is no limit (a laptop, or a container with no CPU limit).
 *
 * A fractional limit rounds down (1.5 CPUs is 1: the half CPU is not worth a thread), and the answer is never below 1.
 */
import fs from 'fs';
import os from 'os';

/** cgroup v2 `cpu.max` is "<quota> <period>" or "max <period>"; v1 has `cpu.cfs_quota_us` (-1 = none) and `cpu.cfs_period_us`. */
export function parseCpuLimit(
  v2: string | null | undefined,
  v1Quota?: string | null,
  v1Period?: string | null,
): number | null {
  const ratio = (quota: number, period: number): number | null => {
    if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
    return Math.max(1, Math.floor(quota / period + 1e-9));
  };
  if (v2) {
    const [q, p] = v2.trim().split(/\s+/);
    if (q && q !== 'max') return ratio(Number(q), Number(p ?? 100_000));
    if (q === 'max') return null;
  }
  if (v1Quota && v1Period) return ratio(Number(v1Quota.trim()), Number(v1Period.trim()));
  return null;
}

function read(path: string): string | null {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

function hostCpus(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

let cached: number | null = null;

/** The CPUs this process may use: the container's limit when there is one, else the host's count. Read once. */
export function availableCpus(): number {
  if (cached !== null) return cached;
  const limit = parseCpuLimit(
    read('/sys/fs/cgroup/cpu.max'),
    read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
    read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
  );
  const host = Math.max(1, hostCpus());
  cached = limit === null ? host : Math.max(1, Math.min(host, limit));
  return cached;
}
