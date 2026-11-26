/**
 * Memory queue for heavy image work.
 *
 * Decoding a photo into raw pixels costs memory in proportion to its pixel
 * count, not its file size: a 12 MB phone photo is about 50 megapixels and
 * needs several hundred MB for each step that touches every pixel. When a few
 * of those run together the server runs out of memory and restarts.
 *
 * The gate keeps the combined estimate of the jobs running at once under a
 * budget. A job that does not fit waits in line (first come, first served)
 * instead of crashing the server. No job is ever refused for being big: a job
 * larger than the whole budget simply runs on its own, when nothing else is
 * running. It only changes WHEN a job runs. It never changes what it computes.
 *
 * Two safeguards against stalls:
 *  - A job already inside a lease (a gated step that calls another gated step)
 *    does not wait a second time, so a step can never wait on itself.
 *  - The lease belongs to the job's own run. Work it starts and leaves running
 *    in the background after the job ends does not inherit the lease.
 *
 * MEMORY_GATE=off turns it off. IMAGE_MEMORY_BUDGET_MB sets the budget, and
 * IMAGE_BYTES_PER_PIXEL the per-pixel estimate.
 */
import { AsyncLocalStorage } from 'async_hooks';
import os from 'os';
import sharp from 'sharp';
import { logger } from './logger';
import { readContainerLimitBytes } from './runtime-watch';

const MB = 1024 * 1024;

/** Memory one pixel costs across the protect steps (decode, copies, working arrays). Measured, then rounded up. */
const DEFAULT_BYTES_PER_PIXEL = 16;
const MIN_ESTIMATE_BYTES = 32 * MB;

interface Lease { released: boolean }

interface Waiter {
  need: number;
  label: string;
  since: number;
  grant: (release: () => void) => void;
}

export class MemoryGate {
  private inUse = 0;
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly scope = new AsyncLocalStorage<Lease>();

  constructor(
    private readonly budgetBytes: () => number,
    private readonly enabled: () => boolean = () => true,
  ) {}

  /** Runs `fn` once the estimate fits in the budget. Resolves with whatever `fn` returns. */
  async run<T>(estimateBytes: number, label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled()) return fn();
    const held = this.scope.getStore();
    if (held && !held.released) return fn();

    const need = Math.max(0, Math.round(estimateBytes));
    const release = await this.acquire(need, label);
    const lease: Lease = { released: false };
    try {
      return await this.scope.run(lease, fn);
    } finally {
      lease.released = true;
      release();
    }
  }

  stats(): { budgetMb: number; inUseMb: number; active: number; queued: number } {
    return {
      budgetMb: Math.round(this.budgetBytes() / MB),
      inUseMb: Math.round(this.inUse / MB),
      active: this.active,
      queued: this.queue.length,
    };
  }

  private fits(need: number): boolean {
    return this.active === 0 || this.inUse + need <= this.budgetBytes();
  }

  private take(need: number): () => void {
    this.inUse += need;
    this.active += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inUse -= need;
      this.active -= 1;
      this.pump();
    };
  }

  private acquire(need: number, label: string): Promise<() => void> {
    if (this.queue.length === 0 && this.fits(need)) return Promise.resolve(this.take(need));
    return new Promise((resolve) => {
      const waiter: Waiter = { need, label, since: Date.now(), grant: resolve };
      this.queue.push(waiter);
      logger.info('[MemoryGate] waiting for memory', { label, needMb: Math.round(need / MB), ...this.stats() });
    });
  }

  /** Starts waiting jobs in order, as long as the first one fits. */
  private pump(): void {
    while (this.queue.length > 0 && this.fits(this.queue[0]!.need)) {
      const next = this.queue.shift()!;
      const waitedMs = Date.now() - next.since;
      if (waitedMs >= 500) {
        logger.info('[MemoryGate] started after waiting', { label: next.label, waitedMs, ...this.stats() });
      }
      next.grant(this.take(next.need));
    }
  }
}

// ── Process-wide gate ────────────────────────────────────────────────────────

/** Budget for jobs running together: about half the container, less room for the server itself. */
export function defaultBudgetBytes(): number {
  const explicit = Number(process.env['IMAGE_MEMORY_BUDGET_MB']);
  if (Number.isFinite(explicit) && explicit > 0) return explicit * MB;
  const limit = readContainerLimitBytes();
  if (limit !== null) return Math.max(256 * MB, limit * 0.55 - 400 * MB);
  return Math.max(512 * MB, os.totalmem() * 0.5);
}

export const memoryGate = new MemoryGate(
  defaultBudgetBytes,
  () => (process.env['MEMORY_GATE'] ?? '').toLowerCase() !== 'off',
);

/** Pure: the estimate for an image of a given size. */
export function estimateFromDimensions(width: number, height: number, fileBytes: number): number {
  const perPixel = Number(process.env['IMAGE_BYTES_PER_PIXEL']) || DEFAULT_BYTES_PER_PIXEL;
  return Math.max(MIN_ESTIMATE_BYTES, width * height * perPixel + fileBytes * 2);
}

/**
 * Memory estimate for processing this buffer. Reads only the image header, so
 * it is cheap even for a huge photo. Returns null for anything that is not a
 * readable image: the memory cost here comes from decoding pixels, so other
 * file types (video, documents, archives) are left exactly as they were and
 * never wait in this queue.
 */
export async function estimateImageJobBytes(buffer: Buffer): Promise<number | null> {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (meta.width && meta.height) return estimateFromDimensions(meta.width, meta.height, buffer.length);
  } catch {
    /* not a readable image */
  }
  return null;
}

/** Runs `fn` under the process-wide gate, sized from the image buffer. */
export async function withMemoryGate<T>(buffer: Buffer, label: string, fn: () => Promise<T>): Promise<T> {
  if ((process.env['MEMORY_GATE'] ?? '').toLowerCase() === 'off') return fn();
  const estimate = await estimateImageJobBytes(buffer);
  if (estimate === null) return fn();
  return memoryGate.run(estimate, label, fn);
}
