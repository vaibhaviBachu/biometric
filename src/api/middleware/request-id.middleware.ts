/**
 * PGAP-11 — request correlation middleware.
 *
 * Mounted first in the Express stack (before morgan, body parsers, rate
 * limiting and every router) so every log line — including morgan's own
 * access log and anything a route handler or error handler logs — is
 * already running inside the request's AsyncLocalStorage context by the
 * time it executes.
 */
import type { Request, Response, NextFunction } from 'express';
import { generateRequestId, isValidRequestId, runWithRequestContext } from '../../lib/request-context';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  // A caller sending the header twice gets an array; neither array form nor
  // anything failing the format check is trusted — it is replaced with a
  // freshly generated ID rather than rejecting the request, so a malformed
  // or oversized value from an uncooperative client never breaks the call.
  const candidate = typeof incoming === 'string' ? incoming : undefined;
  const requestId = isValidRequestId(candidate) ? candidate : generateRequestId();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  runWithRequestContext({ requestId }, () => next());
}
