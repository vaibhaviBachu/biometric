/**
 * Cooperative cancellation for long forensic work.
 *
 * A timeout built on Promise.race (src/lib/safe-runner.ts) only stops WAITING for the work: the work itself keeps running,
 * holding the CPU and memory long after the caller has moved on. Here a deadline carries an AbortSignal, and long loops
 * check it where they already give the event loop back (see `createYielder`). The signal travels with the async call chain
 * (AsyncLocalStorage), so the deep helpers that run the loops do not each need a new parameter.
 *
 * Nothing here interrupts code in the middle of a statement: a loop stops at its next check, which is at most one time slice
 * (a few milliseconds) away.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';

export class AbortedError extends Error {
  readonly aborted = true;
  constructor(reason = 'aborted') {
    super(`Operation aborted: ${reason}`);
    this.name = 'AbortedError';
  }
}

export function isAbortedError(err: unknown): err is AbortedError {
  return Boolean(err) && typeof err === 'object' && (err as { aborted?: unknown }).aborted === true;
}

const scope = new AsyncLocalStorage<AbortSignal>();

/** The signal of the deadline or request this code is running under, if any. */
export function currentSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/** Runs `fn` so that every async step it starts can see `signal` through `currentSignal()`. */
export function runWithSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return scope.run(signal, fn);
}

/** Runs `fn` (and everything it starts) with no cancel signal: for work that belongs to no request, such as queued jobs. */
export function runWithoutSignal<T>(fn: () => T): T {
  return scope.exit(fn);
}

export interface Deadline {
  signal: AbortSignal;
  /** Stops the timer and detaches from the parent. Call it when the work finished in time. */
  cancel(): void;
  /** Aborts now (the caller has stopped waiting). Also stops the timer. */
  abort(reason?: string): void;
}

/**
 * A signal that aborts after `ms`, or when `parent` (default: the signal already in scope) aborts, whichever comes first.
 * The timer does not keep the process alive.
 */
export function createDeadline(ms: number, label: string, parent: AbortSignal | undefined = currentSignal()): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AbortedError(`${label} exceeded ${ms}ms`)), ms);
  timer.unref?.();
  const onParent = () => controller.abort(parent?.reason ?? new AbortedError(`${label}: parent aborted`));
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener('abort', onParent, { once: true });
  }
  const cancel = () => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  };
  return {
    signal: controller.signal,
    cancel,
    abort: (reason = `${label} was abandoned`) => {
      cancel();
      if (!controller.signal.aborted) controller.abort(new AbortedError(reason));
    },
  };
}

/** A signal that aborts when the HTTP client goes away before the response was finished. */
export function abortOnDisconnect(res: { once?(event: 'close', cb: () => void): unknown; writableEnded: boolean }): AbortSignal {
  const controller = new AbortController();
  res.once?.('close', () => {
    if (!res.writableEnded) controller.abort(new AbortedError('the client disconnected'));
  });
  return controller.signal;
}

export function throwIfAborted(signal: AbortSignal | undefined = currentSignal()): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof AbortedError ? reason : new AbortedError(typeof reason === 'string' ? reason : 'aborted');
  }
}

/** Gives the event loop one turn (timers, network callbacks and other requests run), without waiting any longer than that. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A function to call inside a long loop. It costs almost nothing until `sliceMs` of work has passed since the last time the
 * loop gave way; then it yields once, and throws if the work was cancelled meanwhile.
 */
export function createYielder(sliceMs: number, signal: AbortSignal | undefined = currentSignal()): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    throwIfAborted(signal);
    if (performance.now() - sliceStart < sliceMs) return;
    await yieldToLoop();
    sliceStart = performance.now();
    throwIfAborted(signal);
  };
}
