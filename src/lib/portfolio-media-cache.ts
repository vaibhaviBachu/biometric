/**
 * Cache headers for the pictures of a portfolio.
 *
 * A picture that is hidden, unpublished, moved to a private folder or deleted must stop being shown at once. The server decides
 * that on every request, from the database, but a browser or CDN that is allowed to reuse a stored copy never asks. So:
 *
 *  - Published pictures: `public, no-cache`. A cache may keep the picture but has to ask us before each use. The ETag answers
 *    "not changed" without reading any file, and a hidden or deleted picture answers 404 on that very check.
 *  - The owner's preview (an unpublished portfolio, private-folder pictures): `private, no-store`. Never kept by a shared cache,
 *    never written to disk by the browser.
 *  - Every error answer (404, 503, rate limit): `no-store`, so a "not found" is not remembered after the picture is published.
 *
 * `stale-while-revalidate` and `stale-if-error` are deliberately never used: both mean "show the old copy anyway".
 */

/** Optional: seconds a published picture may be reused without asking. 0 (the default) means ask every time. */
export const PORTFOLIO_MEDIA_MAX_AGE_ENV = 'PORTFOLIO_MEDIA_MAX_AGE_S';

/** Even if configured higher, a hidden picture can stay visible for no longer than this. */
export const PORTFOLIO_MEDIA_MAX_AGE_CEILING_S = 120;

export const NO_STORE = 'no-store';
export const OWNER_PREVIEW_CACHE_CONTROL = 'private, no-store';

export function portfolioMediaMaxAgeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[PORTFOLIO_MEDIA_MAX_AGE_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), PORTFOLIO_MEDIA_MAX_AGE_CEILING_S);
}

export function portfolioMediaCacheControl(ownerPreview: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (ownerPreview) return OWNER_PREVIEW_CACHE_CONTROL;
  const age = portfolioMediaMaxAgeSeconds(env);
  return age > 0 ? `public, max-age=${age}, must-revalidate` : 'public, no-cache';
}
