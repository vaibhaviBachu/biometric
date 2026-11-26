import type { Request, Response, NextFunction } from 'express';
import { resolveCors } from '../../lib/allowed-origins';
import { logger } from '../../lib/logger';

/**
 * Refuses a COOKIE-based request that comes from a page on an origin we do not trust.
 *
 * Cookies are sent by the browser on its own, so a request carrying only the cookie proves nothing about which
 * page made it. If the request names the secret itself in the body (`refreshToken`), the caller already holds
 * it and the origin does not matter (this is how the browser extension refreshes), so it passes.
 * Requests without an Origin header (not a cross-origin browser request) also pass.
 */
export function requireTrustedOriginForCookieAuth(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as { refreshToken?: unknown } | undefined;
  if (typeof body?.refreshToken === 'string' && body.refreshToken.trim()) {
    next();
    return;
  }
  const origin = req.header('Origin');
  if (!origin) {
    // Browsers send Origin on every cross-site POST, so a request that says it is cross-site but has none is not
    // an ordinary browser call. Requests with no Origin and no cross-site marker (mobile apps, scripts, curl,
    // same-site navigation) are not blocked: they are not the cross-site cookie attack, and blocking every
    // request without an Origin header would break those legitimate clients.
    if ((req.header('Sec-Fetch-Site') || '').toLowerCase() === 'cross-site') {
      logger.warn('Cookie request marked cross-site without an Origin refused', { path: req.path });
      res.status(403).json({ success: false, error: 'Origin not allowed' });
      return;
    }
    next();
    return;
  }
  const verdict = resolveCors(origin, req.get('host'));
  if (verdict.allowed && verdict.credentials) {
    next();
    return;
  }
  logger.warn('Cookie request from an untrusted origin refused', { origin, path: req.path });
  res.status(403).json({ success: false, error: 'Origin not allowed' });
}
