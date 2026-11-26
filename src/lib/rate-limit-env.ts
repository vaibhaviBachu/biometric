/**
 * ASH-M03 fix — shared by every rate limiter that used to require an exact, case-sensitive
 * "production" match to be ENABLED. Under that scheme any other value (unset NODE_ENV, a typo,
 * "Production", a staging/preview deploy) silently disabled rate limiting entirely, with no
 * warning. Now only the known non-production dev/test values are exempt; anything else —
 * including a missing or misconfigured NODE_ENV — is rate-limited by default (fail safe, not
 * fail open).
 */
export function isUnthrottledEnv(): boolean {
  const env = (process.env['NODE_ENV'] || '').toLowerCase();
  return env === '' || env === 'development' || env === 'test';
}
