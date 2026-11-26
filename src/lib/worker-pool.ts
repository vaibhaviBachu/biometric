/**
 * A small pool of persistent worker threads for heavy forensic arithmetic.
 *
 * The patch search and the hidden-mark search are long stretches of plain computation. Run on the main thread they make every
 * other request wait, and a timeout cannot stop them (it only stops waiting). In a worker thread they cannot block the server,
 * use a second CPU when the machine has one, and are stopped for real: on a timeout or when the person goes away the worker is
 * terminated, which ends the work at once.
 *
 *  - Workers start the first time they are needed and stop after a while with nothing to do (their memory is given back).
 *  - A job holds one worker for its whole run (`use`), so it can load data into the worker once and then run against it.
 *  - At most `size` jobs run at once; the rest wait their turn. Waiting jobs that are aborted leave the line.
 *  - A worker that dies or is stopped is dropped and a fresh one is made for the next job. The caller is told WHY (the error
 *    classes below), because what it may do next depends on it: only a worker that could not start, or that spoke an unusable
 *    protocol, says nothing about the input, so only then may the work be tried on the main thread (lib/worker-failure.ts). A crash,
 *    an out-of-memory stop or a timeout may be the input's own doing, and must not be repeated on the server's only thread.
 *
 * FORENSIC_WORKERS=off turns all of this off (callers do the work on the main thread, as before).
 */
import path from 'path';
import { Worker, type TransferListItem } from 'worker_threads';
import { AbortedError } from './cancellation';
import { logger } from './logger';
import { availableCpus } from './cpu-limit';

export class WorkerTimeoutError extends Error {
  constructor(ms: number) {
    super(`The worker did not finish within ${ms} ms and was stopped.`);
    this.name = 'WorkerTimeoutError';
  }
}

export class WorkerCrashedError extends Error {
  constructor(detail: string) {
    super(`The worker stopped unexpectedly: ${detail}`);
    this.name = 'WorkerCrashedError';
  }
}

/** The worker ran out of memory (its heap limit, FORENSIC_WORKER_HEAP_MB). Most likely the input is too big for it. */
export class WorkerOutOfMemoryError extends WorkerCrashedError {
  constructor(detail: string) {
    super(detail);
    this.name = 'WorkerOutOfMemoryError';
  }
}

/** The worker never became ready (its file could not be loaded, it died while starting), or the pool is pausing after repeated start failures. Says nothing about the input. */
export class WorkerStartupError extends Error {
  constructor(detail: string) {
    super(`The worker could not start: ${detail}`);
    this.name = 'WorkerStartupError';
  }
}

/** The worker sent something the pool cannot read, or reported that it does not know the operation. Says nothing about the input. */
export class WorkerProtocolError extends Error {
  constructor(detail: string) {
    super(`The worker sent an unusable message: ${detail}`);
    this.name = 'WorkerProtocolError';
  }
}

/** One worker, as a job sees it. */
export interface WorkerHandle {
  /** Names of things this worker already holds (the caller decides what they mean). */
  readonly loaded: Set<string>;
  call<T>(op: string, payload: unknown, transfer?: TransferListItem[]): Promise<T>;
}

interface Slot {
  worker: Worker;
  handle: WorkerHandle;
  busy: boolean;
  dead: boolean;
  /** True once the worker has said it is ready (or answered anything): before that, a death is a start failure. */
  ready: boolean;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  grant: (slot: Slot) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface PoolOptions {
  /** How many workers at most. */
  size: () => number;
  /** How long an idle worker is kept before it is stopped (memory is given back). */
  idleMs?: number;
  /** How a worker is made. Overridden in tests. */
  spawn?: () => Worker;
  /** A job is stopped after this long however it is going. */
  maxJobMs?: number;
  /** After this many workers in a row die before becoming ready, no new worker is made for `startupPauseMs` (default 3 and 60 s). */
  startupFailureLimit?: number;
  startupPauseMs?: number;
}

export interface PoolStats {
  workers: number;
  busy: number;
  waiting: number;
  jobs: number;
  stoppedOnTimeoutOrAbort: number;
  crashes: number;
  spawned: number;
}

/** The worker file: compiled JS in a build, TypeScript (through ts-node) when running from source or under tests. */
export function defaultSpawn(): Worker {
  const fromSource = __filename.endsWith('.ts');
  const entry = path.resolve(__dirname, '..', 'workers', fromSource ? 'forensic-worker.ts' : 'forensic-worker.js');
  const workerData = { stubDb: true, testOps: process.env['FORENSIC_WORKER_TEST_OPS'] === '1' };
  // Bound the worker's JavaScript heap so a runaway job cannot take the whole container (FORENSIC_WORKER_HEAP_MB, 0 = no bound).
  // Native image memory is not covered.
  const heapMb = Number(process.env['FORENSIC_WORKER_HEAP_MB'] ?? 384);
  const resourceLimits = heapMb > 0 ? { maxOldGenerationSizeMb: heapMb } : undefined;
  // The worker gets a copy of the environment as this code sees it (Node's own default is the same in the server). Passed
  // explicitly so a worker can never read a different signing key from the code that checks its results: under Jest, a test file's
  // process.env is a sandbox copy that a worker would otherwise not see.
  const env = { ...process.env };
  if (!fromSource) return new Worker(entry, { workerData, resourceLimits, env });
  const boot = `require('ts-node').register({ transpileOnly: true }); require(${JSON.stringify(entry)});`;
  return new Worker(boot, { eval: true, workerData, resourceLimits, env });
}

/**
 * As many workers as the service can spare: one fewer than its CPUs, at least one, at most two. "Its CPUs" is the container's limit,
 * not the host's count (lib/cpu-limit.ts): on a 1 CPU service this is 1, not 2.
 */
export function automaticWorkerCount(cpus = availableCpus()): number {
  return Math.max(1, Math.min(2, cpus - 1));
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly waiting: Waiter[] = [];
  private nextId = 1;
  private jobs = 0;
  private stopped = 0;
  private crashes = 0;
  private spawned = 0;
  private startupFailures = 0;
  private startupPausedUntil = 0;

  constructor(private readonly options: PoolOptions) {}

  stats(): PoolStats {
    return {
      workers: this.slots.filter((s) => !s.dead).length,
      busy: this.slots.filter((s) => s.busy && !s.dead).length,
      waiting: this.waiting.length,
      jobs: this.jobs,
      stoppedOnTimeoutOrAbort: this.stopped,
      crashes: this.crashes,
      spawned: this.spawned,
    };
  }

  /** Stops every worker now (shutdown, tests). */
  async close(): Promise<void> {
    for (const w of this.waiting.splice(0)) w.reject(new AbortedError('the worker pool was closed'));
    await Promise.all(this.slots.splice(0).map((s) => this.kill(s)));
  }

  /**
   * Runs `job` holding one worker. If `signal` aborts or `timeoutMs` passes, the worker is terminated and the job rejects.
   * If the worker dies mid-job the job rejects with WorkerCrashedError.
   */
  async use<T>(job: (handle: WorkerHandle) => Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const slot = await this.acquire(opts.signal);
    this.jobs++;
    const limit = Math.min(opts.timeoutMs ?? Infinity, this.options.maxJobMs ?? 10 * 60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      if (Number.isFinite(limit)) {
        // The caller is told why (reject first), then the worker is stopped.
        timer = setTimeout(() => { this.stopped++; reject(new WorkerTimeoutError(limit)); void this.kill(slot); }, limit);
        timer.unref?.();
      }
      if (opts.signal) {
        onAbort = () => {
          this.stopped++;
          const reason = opts.signal!.reason;
          reject(reason instanceof AbortedError ? reason : new AbortedError(typeof reason === 'string' ? reason : 'aborted'));
          void this.kill(slot);
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    stop.catch(() => undefined);
    try {
      return await Promise.race([job(slot.handle), stop]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      this.release(slot);
    }
  }

  // â”€â”€ workers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private acquire(signal?: AbortSignal): Promise<Slot> {
    this.slots.splice(0, this.slots.length, ...this.slots.filter((s) => !s.dead));
    const idle = this.slots.find((s) => !s.busy);
    if (idle) return Promise.resolve(this.take(idle));
    // Workers keep failing to start: stop trying for a while instead of spawning one per request. The caller may use the main thread.
    if (this.startupPausedUntil > Date.now()) {
      return Promise.reject(new WorkerStartupError('workers failed to start several times in a row; trying again shortly'));
    }
    if (this.slots.length < Math.max(1, this.options.size())) return Promise.resolve(this.take(this.make()));
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { grant: (s) => resolve(this.take(s)), reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const at = this.waiting.indexOf(waiter);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(signal.reason instanceof AbortedError ? signal.reason : new AbortedError('aborted while waiting for a worker'));
        };
        if (signal.aborted) { waiter.onAbort(); return; }
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
    });
  }

  private take(slot: Slot): Slot {
    slot.busy = true;
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    return slot;
  }

  private release(slot: Slot): void {
    slot.busy = false;
    if (slot.dead) {
      // Its place is free again for whoever is waiting.
      const next = this.waiting.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.grant(this.make());
      }
      return;
    }
    const next = this.waiting.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
      next.grant(slot);
      return;
    }
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    slot.idleTimer = setTimeout(() => { void this.kill(slot); }, idleMs);
    slot.idleTimer.unref?.();
  }

  private make(): Slot {
    const worker = (this.options.spawn ?? defaultSpawn)();
    this.spawned++;
    const slot: Slot = {
      worker,
      busy: false,
      dead: false,
      ready: false,
      pending: new Map(),
      idleTimer: null,
      handle: undefined as unknown as WorkerHandle,
    };
    const loaded = new Set<string>();
    slot.handle = {
      loaded,
      call: <T>(op: string, payload: unknown, transfer?: TransferListItem[]) => new Promise<T>((resolve, reject) => {
        if (slot.dead) { reject(new WorkerCrashedError('it was already stopped')); return; }
        const id = this.nextId++;
        slot.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ id, op, payload }, transfer ?? []);
      }),
    };
    worker.on('message', (msg: { id?: number; type?: string; ok?: boolean; value?: unknown; error?: { name?: string; message?: string } } | null) => {
      if (!msg || typeof msg !== 'object') { this.protocolBroken(slot, 'not an object'); return; }
      if (msg.type === 'ready') { slot.ready = true; this.startupFailures = 0; return; }
      if (typeof msg.id !== 'number' || typeof msg.ok !== 'boolean') { this.protocolBroken(slot, 'missing id or ok'); return; }
      slot.ready = true;
      this.startupFailures = 0;
      const p = slot.pending.get(msg.id);
      if (!p) return;
      slot.pending.delete(msg.id);
      if (msg.ok) { p.resolve(msg.value); return; }
      const name = msg.error?.name ?? 'Error';
      const message = msg.error?.message ?? 'worker error';
      // A worker that does not know the operation is a version or packaging problem, not a problem with the input.
      if (name === 'WorkerUnsupportedError' || name === 'WorkerProtocolError') p.reject(new WorkerProtocolError(message));
      else p.reject(Object.assign(new Error(message), { name }));
    });
    const died = (detail: string, code?: string) => {
      if (slot.dead) return;
      slot.dead = true;
      this.crashes++;
      loaded.clear();
      const startup = !slot.ready;
      if (startup) {
        this.startupFailures++;
        if (this.startupFailures >= (this.options.startupFailureLimit ?? 3)) {
          this.startupPausedUntil = Date.now() + (this.options.startupPauseMs ?? 60_000);
          this.startupFailures = 0;
        }
      }
      const failure = startup ? new WorkerStartupError(detail)
        : code === 'ERR_WORKER_OUT_OF_MEMORY' ? new WorkerOutOfMemoryError(detail)
          : new WorkerCrashedError(detail);
      for (const p of slot.pending.values()) p.reject(failure);
      slot.pending.clear();
      logger.warn('[WorkerPool] A worker stopped unexpectedly', { detail, kind: failure.name });
    };
    worker.on('error', (err) => died(String(err).slice(0, 200), (err as { code?: string } | null)?.code));
    worker.on('exit', (code) => { if (!slot.dead) died(`it exited with code ${code}`); });
    worker.unref();
    this.slots.push(slot);
    return slot;
  }

  /** The worker spoke something unreadable: it cannot be trusted any more, so it is dropped and the waiting job is told. */
  private protocolBroken(slot: Slot, detail: string): void {
    if (slot.dead) return;
    slot.dead = true;
    slot.handle.loaded.clear();
    const failure = new WorkerProtocolError(detail);
    for (const p of slot.pending.values()) p.reject(failure);
    slot.pending.clear();
    logger.warn('[WorkerPool] A worker sent an unusable message', { detail });
    void slot.worker.terminate().catch(() => undefined);
  }

  /** Stops a worker on purpose (not a crash). */
  private async kill(slot: Slot): Promise<void> {
    if (slot.dead) return;
    slot.dead = true;
    slot.handle.loaded.clear();
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    for (const p of slot.pending.values()) p.reject(new AbortedError('the worker was stopped'));
    slot.pending.clear();
    try { await slot.worker.terminate(); } catch { /* already gone */ }
  }
}
