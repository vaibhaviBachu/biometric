/**
 * Switches for the performance and reliability work (Phase 1 of docs/PERFORMANCE-RELIABILITY-AUDIT-2026-11-07.md).
 *
 * Every switch is an environment variable. Setting it to "off" (or "false", "0", "no") returns that part to the behaviour it
 * had before this work, without a code change. They are read on every call, so a test can flip one.
 *
 *   FORENSIC_YIELD        The local DNA patch search gives the event loop back every few milliseconds instead of holding
 *                         the single Node thread for tens of seconds.
 *   FORENSIC_SEARCH_SHARE The same search (same picture, same stored index) asked for twice shares one computation.
 *   FORENSIC_ADMISSION    Investigations and scans wait in a bounded line instead of all starting at once.
 *   FORENSIC_DEADLINES    A timed-out investigation stage is told to stop, instead of being left running in the background.
 *   INCONCLUSIVE_OUTCOMES A scan or investigation that did not finish says so, instead of saying "not found".
 *   STORAGE_RETRY         A temporary storage failure is retried, and is told apart from a file that is really missing.
 *   AI_BREAKER            One failed AI call no longer marks the AI service offline for everyone.
 *   PREVIEW_THUMBNAILS    Public portfolio pictures are served from the stored 960 px preview, not by decrypting and resizing the
 *                         whole original on every request.
 *   PREVIEW_ETAG          A repeat request for a preview or portfolio picture is answered "304 not changed" before any file is read.
 *   FORENSIC_WORKERS      The patch search and the hidden-mark search run in worker threads (and are stopped for real on a timeout).
 *   FORENSIC_POISON_GUARD A picture that has crashed, exhausted or timed out a worker repeatedly is refused for a while instead of
 *                         being tried again (and again) on every request.
 *
 * Tuning (numbers): FORENSIC_SLICE_MS (default 15), FORENSIC_HEAVY_SLOTS (default 2), FORENSIC_HEAVY_PER_USER (default 1),
 * FORENSIC_HEAVY_QUEUE (default 8), FORENSIC_HEAVY_WAIT_MS (default 90000), FORENSIC_SCAN_WAIT_MS (default 10000, the scan page
 * gives up at 45 s), FORENSIC_SEARCH_CACHE_MS (default 120000), PUBLIC_MEDIA_SLOTS (default 4), PUBLIC_MEDIA_QUEUE (default 60),
 * PUBLIC_MEDIA_WAIT_MS (default 8000), FORENSIC_WORKER_COUNT (default 0 = automatic),
 * FORENSIC_POISON_MAX_FAILURES (default 2), FORENSIC_POISON_TTL_MS (default 600000).
 */

export type ForensicFlag =
  | 'FORENSIC_YIELD'
  | 'FORENSIC_SEARCH_SHARE'
  | 'FORENSIC_ADMISSION'
  | 'FORENSIC_DEADLINES'
  | 'INCONCLUSIVE_OUTCOMES'
  | 'STORAGE_RETRY'
  | 'AI_BREAKER'
  | 'PREVIEW_THUMBNAILS'
  | 'PREVIEW_ETAG'
  | 'FORENSIC_WORKERS'
  | 'FORENSIC_POISON_GUARD';

const OFF = new Set(['off', 'false', '0', 'no']);

/** On unless the variable says otherwise. */
export function forensicFlag(name: ForensicFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  return !OFF.has(v);
}

function numberEnv(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const n = Number(env[name]);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

export interface ForensicTuning {
  sliceMs: number;
  heavySlots: number;
  heavyPerUser: number;
  heavyQueue: number;
  heavyWaitMs: number;
  scanWaitMs: number;
  searchCacheMs: number;
  mediaSlots: number;
  mediaQueue: number;
  mediaWaitMs: number;
  workers: number;
  poisonMaxFailures: number;
  poisonTtlMs: number;
}

export function forensicTuning(env: NodeJS.ProcessEnv = process.env): ForensicTuning {
  return {
    sliceMs: numberEnv('FORENSIC_SLICE_MS', 15, 1, 200, env),
    heavySlots: Math.floor(numberEnv('FORENSIC_HEAVY_SLOTS', 2, 1, 16, env)),
    heavyPerUser: Math.floor(numberEnv('FORENSIC_HEAVY_PER_USER', 1, 1, 8, env)),
    heavyQueue: Math.floor(numberEnv('FORENSIC_HEAVY_QUEUE', 8, 0, 100, env)),
    heavyWaitMs: numberEnv('FORENSIC_HEAVY_WAIT_MS', 90_000, 1_000, 600_000, env),
    scanWaitMs: numberEnv('FORENSIC_SCAN_WAIT_MS', 10_000, 500, 60_000, env),
    searchCacheMs: numberEnv('FORENSIC_SEARCH_CACHE_MS', 120_000, 0, 3_600_000, env),
    mediaSlots: Math.floor(numberEnv('PUBLIC_MEDIA_SLOTS', 4, 1, 32, env)),
    mediaQueue: Math.floor(numberEnv('PUBLIC_MEDIA_QUEUE', 60, 0, 500, env)),
    mediaWaitMs: numberEnv('PUBLIC_MEDIA_WAIT_MS', 8_000, 500, 60_000, env),
    // Worker threads for heavy forensic work. 0 = as many as the machine can spare (one fewer than its CPUs, at least one, at most two).
    workers: Math.floor(numberEnv('FORENSIC_WORKER_COUNT', 0, 0, 8, env)),
    poisonMaxFailures: Math.floor(numberEnv('FORENSIC_POISON_MAX_FAILURES', 2, 1, 20, env)),
    poisonTtlMs: numberEnv('FORENSIC_POISON_TTL_MS', 10 * 60_000, 1_000, 24 * 3_600_000, env),
  };
}
