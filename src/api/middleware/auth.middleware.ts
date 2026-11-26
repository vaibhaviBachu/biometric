import { Request, Response, NextFunction } from 'express';
import { authService } from '../../services/auth/auth.service';
import { stripClientOwnerIdentity } from '../../lib/tenant-scope';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Access token from the Authorization header only. A token in the URL ends up in browser history, proxy and
 * CDN logs and Referer headers, so ordinary routes no longer accept `?token=`.
 */
function extractToken(req: Request): string | null {
  return bearerToken(req);
}

/**
 * Live streams (EventSource) cannot send headers, so for those routes only the token may also come from the
 * query string. The request logger redacts it (lib/log-redaction.ts).
 */
function extractTokenForStream(req: Request): string | null {
  const fromHeader = bearerToken(req);
  if (fromHeader) return fromHeader;
  const q = req.query['token'];
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

function authenticate(req: Request, res: Response, next: NextFunction, token: string | null): void {
  if (!token) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  try {
    const payload = authService.verifyAccess(token);
    (req as any).user = payload;
    stripClientOwnerIdentity(req);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  authenticate(req, res, next, extractToken(req));
}

/** SSE / EventSource — accepts the Bearer header, or ?token= because EventSource cannot set headers. */
/**
 * A live stream that authenticates with the Authorization header only. The token is never accepted in the URL, where it ends up in
 * server logs, proxies and browser history. (requireAuthSse, below, still accepts ?token= for the older Business message stream.)
 */
export function requireAuthStream(req: Request, res: Response, next: NextFunction) {
  authenticate(req, res, next, bearerToken(req));
}

export function requireAuthSse(req: Request, res: Response, next: NextFunction) {
  authenticate(req, res, next, extractTokenForStream(req));
}
