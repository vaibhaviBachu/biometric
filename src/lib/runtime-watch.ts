/**
 * Runtime watch: records how much memory the server is using and whether the
 * event loop is being blocked, so that a restart or a slow page can be traced
 * to a cause instead of guessed at. It only observes: it never limits, queues
 * or changes any request, and the timers do not keep the process alive.
 *
 * What it logs (production only, or when RUNTIME_WATCH=on; RUNTIME_WATCH=off
 * turns it off):
 *   - once at start: the container memory limit, Node's heap limit and CPUs
 *   - "MEMORY_HIGH" when the process or container is at or above 75% of the limit
 *   - "MEMORY_JUMP" when resident memory moved by 150 MB or more since the last line
 *   - "EVENT_LOOP_BLOCKED" when the loop was stuck for a second or more
 *   - a heartbeat every 5 minutes
 *   - one last line on SIGTERM
 * A kill for running out of memory sends no signal, so the last MEMORY_* or
 * heartbeat line before a restart is the evidence.
 */
import fs from 'fs';
import v8 from 'v8';
import { availableCpus } from './cpu-limit';
import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from './logger';

const MB = 1024 * 1024;
const SAMPLE_EVERY_MS = 2_000;
const HEARTBEAT_EVERY_MS = 5 * 60_000;
const HIGH_FRACTION = 0.75;
const HIGH_REPEAT_MS = 10_000;
const JUMP_MB = 150;
const BLOCKED_MS = 1_000;

export interface RuntimeSample {
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  containerUsedMb: number | null;
  containerLimitMb: number | null;
  /** Longest stretch the event loop was blocked since the previous sample. */
  loopBlockedMs: number;
}

export interface WatchState {
  lastLoggedRssMb: number;
  lastLoggedAt: number;
  lastHighAt: number;
}

export type WatchReason = 'MEMORY_HIGH' | 'MEMORY_JUMP' | 'EVENT_LOOP_BLOCKED' | 'HEARTBEAT';

/** A cgroup limit file holds a number, "max", or a huge number that means "no limit". */
export function parseCgroupLimit(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || text === 'max') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 2 ** 50) return null;
  return value;
}

function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export function readContainerLimitBytes(): number | null {
  return parseCgroupLimit(readFirst(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']));
}

function readContainerUsedBytes(): number | null {
  const raw = readFirst(['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']);
  const value = raw ? Number(raw.trim()) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Share of the limit in use, using container memory when known and the process otherwise. */
export function usedFraction(sample: RuntimeSample): number | null {
  if (!sample.containerLimitMb) return null;
  const used = sample.containerUsedMb ?? sample.rssMb;
  return used / sample.containerLimitMb;
}

/** Pure decision: should this sample be written to the log, and why. */
export function evaluateSample(
  sample: RuntimeSample,
  state: WatchState,
  now: number,
): { reason: WatchReason; next: WatchState } | null {
  const fraction = usedFraction(sample);
  const keep = (reason: WatchReason, extra: Partial<WatchState> = {}) => ({
    reason,
    next: { ...state, lastLoggedRssMb: sample.rssMb, lastLoggedAt: now, ...extra },
  });

  if (fraction !== null && fraction >= HIGH_FRACTION && now - state.lastHighAt >= HIGH_REPEAT_MS) {
    return keep('MEMORY_HIGH', { lastHighAt: now });
  }
  if (sample.loopBlockedMs >= BLOCKED_MS) return keep('EVENT_LOOP_BLOCKED');
  if (Math.abs(sample.rssMb - state.lastLoggedRssMb) >= JUMP_MB) return keep('MEMORY_JUMP');
  if (now - state.lastLoggedAt >= HEARTBEAT_EVERY_MS) return keep('HEARTBEAT');
  return null;
}

function round(bytes: number): number {
  return Math.round(bytes / MB);
}

function takeSample(loopBlockedMs: number): RuntimeSample {
  const mem = process.memoryUsage();
  const limit = readContainerLimitBytes();
  const used = readContainerUsedBytes();
  return {
    rssMb: round(mem.rss),
    heapUsedMb: round(mem.heapUsed),
    externalMb: round(mem.external),
    arrayBuffersMb: round(mem.arrayBuffers),
    containerUsedMb: used === null ? null : round(used),
    containerLimitMb: limit === null ? null : round(limit),
    loopBlockedMs,
  };
}

function enabled(): boolean {
  const flag = (process.env['RUNTIME_WATCH'] ?? '').toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return (process.env['NODE_ENV'] ?? '').toLowerCase() === 'production';
}

let started = false;

export function startRuntimeWatch(): void {
  if (started || !enabled()) return;
  started = true;

  const limit = readContainerLimitBytes();
  logger.info('[Runtime] limits', {
    containerLimitMb: limit === null ? null : round(limit),
    heapLimitMb: round(v8.getHeapStatistics().heap_size_limit),
    cpus: availableCpus(),
    webConcurrency: process.env['WEB_CONCURRENCY'] ?? null,
    node: process.version,
  });

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  const first = takeSample(0);
  let state: WatchState = { lastLoggedRssMb: first.rssMb, lastLoggedAt: Date.now(), lastHighAt: 0 };

  const timer = setInterval(() => {
    const blockedMs = Math.round(loop.max / 1e6);
    loop.reset();
    const sample = takeSample(blockedMs);
    const verdict = evaluateSample(sample, state, Date.now());
    if (!verdict) return;
    state = verdict.next;
    const level = verdict.reason === 'HEARTBEAT' || verdict.reason === 'MEMORY_JUMP' ? 'info' : 'warn';
    logger[level](`[Runtime] ${verdict.reason}`, { ...sample });
  }, SAMPLE_EVERY_MS);
  timer.unref();

  process.once('SIGTERM', () => {
    logger.info('[Runtime] SIGTERM', { ...takeSample(Math.round(loop.max / 1e6)) });
  });
}
