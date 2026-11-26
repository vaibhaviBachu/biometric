/**
 * Live numbers about how the server is coping, for the people running it (Phase 0 of the performance work).
 *
 * `runtime-watch.ts` writes a log line when memory is high or the event loop was stuck for a second. This adds what the
 * incident of 6 Nov 2026 was missing: how long requests would have waited (event-loop delay percentiles over a window),
 * how many heavy jobs run and wait, and counts of the outcomes that matter (cancelled work, jobs refused as busy, scans
 * and investigations that could not finish). Observing only: it never limits or changes a request.
 *
 * `GET /api/v1/ops/metrics` (admin only) returns `getOpsSnapshot()`. Every 60 s, while heavy jobs are running or the loop is
 * slow, one `[Ops]` line is logged so the same facts are in the Render log next to the incident.
 */
import os from 'os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { logger } from './logger';
import { availableCpus } from './cpu-limit';
import { readContainerLimitBytes } from './runtime-watch';
import type { GateStats } from './heavy-gate';

type Counter =
  | 'aborted_work'
  | 'gate_refused'
  | 'scan_inconclusive'
  | 'investigation_inconclusive'
  | 'evidence_skipped_incomplete'
  | 'storage_retried'
  | 'storage_unreachable'
  | 'worker_jobs'
  | 'worker_fallbacks'
  | 'worker_failures'
  | 'worker_inputs_refused';

const counters: Record<Counter, number> = {
  aborted_work: 0,
  gate_refused: 0,
  scan_inconclusive: 0,
  investigation_inconclusive: 0,
  evidence_skipped_incomplete: 0,
  storage_retried: 0,
  storage_unreachable: 0,
  worker_jobs: 0,
  worker_fallbacks: 0,
  worker_failures: 0,
  worker_inputs_refused: 0,
};

export function countOps(name: Counter, by = 1): void {
  counters[name] += by;
}

const gateProviders: Array<() => GateStats> = [];
export function registerGate(provider: () => GateStats): void {
  gateProviders.push(provider);
}

/** Other named numbers to show next to the gates (for example the worker pool). */
const extraProviders = new Map<string, () => unknown>();
export function registerExtra(name: string, provider: () => unknown): void {
  extraProviders.set(name, provider);
}

const MB = 1024 * 1024;
const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;

let histogram: IntervalHistogram | null = null;
let windowStartedAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts measuring the event loop. Safe to call more than once. The timers do not keep the process alive. */
export function startOpsMetrics(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  windowStartedAt = Date.now();
  timer = setInterval(() => {
    const snap = readAndResetWindow();
    const busy = snap.gates.some((g) => g.running > 0 || g.waiting > 0);
    if (busy || snap.eventLoop.p99Ms >= 100) logger.info('[Ops]', snap as unknown as Record<string, unknown>);
  }, 60_000);
  timer.unref?.();
}

export function stopOpsMetrics(): void {
  histogram?.disable();
  histogram = null;
  if (timer) clearInterval(timer);
  timer = null;
}

export interface OpsSnapshot {
  at: string;
  windowSeconds: number;
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number };
  memory: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number; containerLimitMb: number | null };
  cpus: number;
  load1m: number;
  gates: GateStats[];
  extras: Record<string, unknown>;
  counters: Record<Counter, number>;
}

function readAndResetWindow(): OpsSnapshot {
  const now = Date.now();
  const m = process.memoryUsage();
  const limit = readContainerLimitBytes();
  const loop = histogram
    ? { p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) }
    : { p50Ms: 0, p99Ms: 0, maxMs: 0 };
  const snapshot: OpsSnapshot = {
    at: new Date(now).toISOString(),
    windowSeconds: Math.round((now - windowStartedAt) / 1000),
    eventLoop: loop,
    memory: {
      rssMb: Math.round(m.rss / MB),
      heapUsedMb: Math.round(m.heapUsed / MB),
      externalMb: Math.round(m.external / MB),
      arrayBuffersMb: Math.round(m.arrayBuffers / MB),
      containerLimitMb: limit ? Math.round(limit / MB) : null,
    },
    cpus: availableCpus(),
    load1m: Math.round(os.loadavg()[0]! * 100) / 100,
    gates: gateProviders.map((g) => g()),
    extras: Object.fromEntries([...extraProviders].map(([name, fn]) => [name, fn()])),
    counters: { ...counters },
  };
  histogram?.reset();
  windowStartedAt = now;
  return snapshot;
}

/** The numbers since the last read, then a fresh window starts. */
export function getOpsSnapshot(): OpsSnapshot {
  return readAndResetWindow();
}
