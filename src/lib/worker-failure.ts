/**
 * What a failed worker job means, and what may be done about it.
 *
 * The old rule was "if a worker fails, do the same work on the main thread". That is only safe when the failure says nothing about the
 * input. A picture that crashed a worker, ran it out of memory or kept it busy until the time limit will do the same to the server's
 * one thread, and take every other request with it. So:
 *
 *   startup   the worker could not start               -> the work may be tried on the main thread (the input is not to blame)
 *   protocol  the worker spoke an unusable protocol    -> the work may be tried on the main thread (the input is not to blame)
 *   crash / oom / timeout                              -> NOT retried on the main thread; the result is "could not finish"
 *   job-error the worker reported an error of its own  -> NOT retried on the main thread (a decode error on a hostile file is not
 *                                                         made safer by decoding it on the server's thread); "could not finish"
 *   aborted   the caller gave up                       -> nothing more is done at all
 *
 * "Could not finish" is an inconclusive answer, never a "no match": callers must not tell anyone a file is clean because a check
 * could not be completed.
 */
import { AbortedError, isAbortedError } from './cancellation';
import { WorkerCrashedError, WorkerOutOfMemoryError, WorkerProtocolError, WorkerStartupError, WorkerTimeoutError } from './worker-pool';

export type WorkerFailureKind = 'startup' | 'protocol' | 'crash' | 'oom' | 'timeout' | 'aborted' | 'job-error' | 'unknown';

export function classifyWorkerFailure(err: unknown): WorkerFailureKind {
  if (err instanceof AbortedError || isAbortedError(err)) return 'aborted';
  if (err instanceof WorkerStartupError) return 'startup';
  if (err instanceof WorkerProtocolError) return 'protocol';
  if (err instanceof WorkerOutOfMemoryError) return 'oom';
  if (err instanceof WorkerCrashedError) return 'crash';
  if (err instanceof WorkerTimeoutError) return 'timeout';
  if (err instanceof Error) return 'job-error';
  return 'unknown';
}

/** Only a failure that says nothing about the input may be answered by doing the work on the main thread. */
export function mayFallBackToMainThread(kind: WorkerFailureKind): boolean {
  return kind === 'startup' || kind === 'protocol';
}

/** Failures that may be the input's own doing: they count against the input (see poison-input-guard.ts). */
export function countsAgainstInput(kind: WorkerFailureKind): boolean {
  return kind === 'crash' || kind === 'oom' || kind === 'timeout';
}

/**
 * The work could not be completed in a worker, and may not be repeated on the main thread. The result is "inconclusive": callers that
 * can say so (a scan, an investigation) do; none of them may turn it into "not found".
 */
export class WorkerWorkFailedError extends Error {
  readonly inconclusive = true as const;
  constructor(readonly kind: WorkerFailureKind, detail: string, readonly refusedInput = false) {
    super(refusedInput
      ? 'This file made the checking process fail before, so it was not tried again. The check could not be completed.'
      : `The check could not be completed (${detail}).`);
    this.name = 'WorkerWorkFailedError';
  }
}

/** Duck-typed so callers need not import this module to ask. */
export function isInconclusiveWorkerFailure(err: unknown): err is WorkerWorkFailedError {
  return err instanceof WorkerWorkFailedError || (typeof err === 'object' && err !== null && (err as { inconclusive?: unknown }).inconclusive === true
    && (err as { name?: unknown }).name === 'WorkerWorkFailedError');
}
