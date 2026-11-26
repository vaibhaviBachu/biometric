/**
 * PGAP-11 — request correlation context.
 *
 * No correlation-ID mechanism existed anywhere in this codebase before this
 * (checked: no X-Request-ID/X-Correlation-ID header, no req.requestId, no
 * trace-id convention — see the PGAP-11 report for the search that
 * confirmed this). AsyncLocalStorage lets every log call anywhere in a
 * request's async call chain — a service function three layers deep, an
 * error handler, an outbound fetch to Exchange — read the current request's
 * ID without it being threaded through every function signature by hand,
 * which would have meant touching an impractically large number of
 * pre-existing call sites for a codebase this size.
 *
 * A client-supplied ID is carried through for correlation only. It is never
 * checked against anything, never used to look anything up, and proves
 * nothing about who the caller is — accepting it is not an authentication
 * decision.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Accepted shape for both a generated UUID and a reasonable caller-supplied value. Rejects anything that could land unescaped in a log line or a header and cause injection (newlines, control characters) or an unbounded value. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}

/** The current request's ID, or undefined outside any request/job context (e.g. at module load time). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
