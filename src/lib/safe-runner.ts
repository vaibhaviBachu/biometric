/**
 * PINIT-DNA — Safe Runner (Phase 4)
 *
 * Promise.race-based timeout wrapper for DNA layer execution.
 * Prevents any layer from hanging indefinitely on corrupt/malicious files.
 * Maximum timeout: 30 seconds per operation.
 */

import { createDeadline, runWithSignal } from './cancellation';

export class TimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`Operation "${operationName}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Run a promise with a hard timeout.
 * Throws TimeoutError if the promise does not resolve within timeoutMs.
 *
 * @param fn          - Async function to run
 * @param timeoutMs   - Maximum allowed ms (default: 30000)
 * @param label       - Operation name for error messages
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs = 30_000,
  label = 'operation'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs
    );
  });

  try {
    const result = await Promise.race([fn(), timeout]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}

/** Like withTimeout but returns null instead of throwing — for optional fast-path steps */
export async function withTimeoutSoft<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T | null> {
  try {
    return await withTimeout(fn, timeoutMs, label);
  } catch {
    return null;
  }
}

/**
 * Like withTimeoutSoft, but the work is also told to STOP when the time is up, not just left running in the background.
 *
 * `fn` runs under its own cancel signal (a child of the current one, see lib/cancellation.ts). On timeout the signal is aborted,
 * so loops that check it (the patch matcher, the checkpoints in the retrieval steps, AI requests) stop at their next check.
 * Returns null on timeout or failure, like withTimeoutSoft.
 */
export async function withDeadlineSoft<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T | null> {
  const deadline = createDeadline(timeoutMs, label);
  let finished = false;
  try {
    const result = await withTimeoutSoft(() => runWithSignal(deadline.signal, fn), timeoutMs, label);
    finished = result !== null;
    return result;
  } finally {
    if (finished) deadline.cancel();
    else deadline.abort(`${label} timed out or failed after at most ${timeoutMs}ms`);
  }
}

/**
 * Phase 4.5 — never discard completed evidence.
 * If work finishes after the soft deadline but within graceMs, keep the result.
 */
export async function withTimeoutSoftRetain<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  graceMs = 12_000,
  _label = 'operation',
): Promise<T | null> {
  let settled: T | undefined;
  let failed: unknown;
  const work = fn().then(
    (v) => {
      settled = v;
      return v;
    },
    (e) => {
      failed = e;
      throw e;
    },
  );

  const raced = await Promise.race([
    work.then((v) => ({ kind: 'ok' as const, v })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);

  if (raced.kind === 'ok') return raced.v;

  await Promise.race([
    work.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs);
    }),
  ]);

  if (failed) return null;
  return settled !== undefined ? settled : null;
}

/**
 * Validate basic file safety before processing.
 * Rejects clearly invalid or dangerous inputs.
 */
export function validateFileInput(buffer: Buffer, filename: string, maxBytes: number): void {
  // Empty file
  if (buffer.length === 0) {
    throw new Error('Uploaded file is empty');
  }

  // Over max size
  if (buffer.length > maxBytes) {
    throw new Error(`File size ${buffer.length} exceeds maximum ${maxBytes} bytes`);
  }

  // Null bytes at very start = binary bomb heuristic
  const firstByte = buffer[0];
  if (firstByte === undefined || (buffer.length < 4 && firstByte === 0x00)) {
    throw new Error('File appears to be corrupt or empty');
  }

  // Filename sanity
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Invalid filename: ${filename}`);
  }
}

/**
 * ZIP bomb detection — check if compressed:uncompressed ratio is dangerously high.
 * Called before unzipping any archive.
 */
export function checkZipBomb(compressedSize: number, uncompressedSize: number): void {
  const MAX_RATIO  = 100;   // 100x compression = suspicious
  const MAX_EXPANDED = 500 * 1024 * 1024; // 500MB uncompressed maximum

  if (uncompressedSize > MAX_EXPANDED) {
    throw new Error(`ZIP expansion too large: ${Math.round(uncompressedSize / 1024 / 1024)}MB uncompressed`);
  }

  if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_RATIO) {
    throw new Error(`ZIP bomb detected: compression ratio ${Math.round(uncompressedSize / compressedSize)}:1`);
  }
}
