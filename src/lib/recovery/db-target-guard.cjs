/**
 * PINIT-DNA — Phase 10: DR9-ENV-01 canonical database/storage target guard.
 *
 * Plain CommonJS, zero TypeScript syntax, zero dependencies beyond Node's
 * built-in `url` module — deliberately, so it can be `require()`'d directly
 * by:
 *   - every plain `.cjs` operational script under `scripts/`,
 *   - `scripts/guard-db-target.cjs` (the npm-script-level CLI gate), and
 *   - `src/lib/recovery/restore-safety.ts` (the typed wrapper app code and
 *     Jest-compiled tests use), via a plain `require()` of this file.
 *
 * This is the ONE place the classification rule lives. Phase 9 already
 * built an equivalent TypeScript-only version (`restore-safety.ts`); Phase
 * 10 found that several real, unguarded destructive paths — `prisma migrate
 * dev`, `prisma db push`, `prisma studio` — are plain Prisma CLI invocations
 * that never go through any TypeScript module at all, so a TS-only guard
 * could never reach them. This file is what actually closes that gap;
 * `restore-safety.ts` now delegates to it instead of duplicating the rule.
 *
 * Root cause this exists for (DR9-ENV-01): this repository's own local
 * `.env` can legitimately contain the real production Supabase connection
 * string (a developer's own choice, to see real data locally during
 * day-to-day work) — Prisma's CLI reads `DATABASE_URL`/`DIRECT_URL` from
 * `.env` directly, with no awareness of this application's own config
 * module, so no amount of guarding inside `src/config/index.ts` alone can
 * protect a bare `npx prisma migrate dev` typed at a terminal. This module,
 * and the npm-script wrapping around it, is the actual, reachable mitigation
 * for that specific, already-realized risk (the 2026-08-24 incident).
 */

const { URL } = require('url');

/** @typedef {'local-safe'|'unknown'|'production-like'} TargetClassification */

// Matched as a suffix against the lowercased hostname. A match is ALWAYS
// refused — there is no override for this category, because these patterns
// indicate a managed cloud provider regardless of which specific
// project/instance is behind it.
const PRODUCTION_HOST_SUFFIXES = Object.freeze([
  '.supabase.co',
  '.supabase.com',
  'pooler.supabase.com',
  '.rds.amazonaws.com',
  '.onrender.com',
  '.render.com',
]);

const LOCAL_SAFE_HOST_PATTERNS = Object.freeze([
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^\[?::1\]?$/,
  /^host\.docker\.internal$/i,
  /^0\.0\.0\.0$/,
]);

/**
 * Extracts a lowercased hostname from a connection string / URL, tolerant of
 * malformed input, URL-encoded userinfo, and bare hostnames (no scheme).
 * Never throws.
 */
function extractHost(connectionStringOrUrl) {
  const trimmed = String(connectionStringOrUrl || '').trim();
  if (!trimmed) return '';

  // Try as-is first (covers postgres://, postgresql://, https://, etc.).
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    /* fall through */
  }

  // Normalize a scheme-less `postgres://`-shaped string some callers pass
  // without a recognized protocol (defensive — `new URL` above already
  // handles postgres:// and postgresql:// directly in every Node version
  // this project targets; this branch exists for stray inputs like a bare
  // `user:pass@host:port/db` with no scheme at all).
  try {
    return new URL(`postgresql://${trimmed.replace(/^[a-z0-9+.-]+:\/\//i, '')}`).hostname.toLowerCase();
  } catch {
    /* fall through */
  }

  // Last resort: the whole trimmed string, lowercased — still gets
  // classified (almost certainly as 'unknown') rather than silently passed
  // through unclassified.
  return trimmed.toLowerCase();
}

/**
 * @param {string} connectionStringOrUrl
 * @returns {{classification: TargetClassification, host: string, reason: string}}
 */
function classifyTarget(connectionStringOrUrl) {
  const host = extractHost(connectionStringOrUrl);

  if (!host) {
    return { classification: 'unknown', host, reason: 'Could not determine a host from the given target.' };
  }

  const matchedProdSuffix = PRODUCTION_HOST_SUFFIXES.find((suffix) => host.endsWith(suffix));
  if (matchedProdSuffix) {
    return {
      classification: 'production-like',
      host,
      reason: `Host "${host}" matches the known managed-cloud-provider suffix "${matchedProdSuffix}" — always refused regardless of confirmation flags.`,
    };
  }

  if (LOCAL_SAFE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { classification: 'local-safe', host, reason: `Host "${host}" matches a recognized local-machine pattern.` };
  }

  return {
    classification: 'unknown',
    host,
    reason: `Host "${host}" is neither a recognized local-safe pattern nor a recognized managed-cloud suffix. Treat as unverified until explicitly confirmed.`,
  };
}

class ProductionTargetRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductionTargetRejectedError';
  }
}

/**
 * Throws unless the target is 'local-safe', or 'unknown' AND the caller
 * passed explicit confirmation. 'production-like' can never be overridden —
 * that is by design, not an omission.
 *
 * @param {string} connectionStringOrUrl
 * @param {{ explicitlyConfirmedNonProduction?: boolean }} [opts]
 */
function assertSafeTarget(connectionStringOrUrl, opts) {
  const options = opts || {};
  const result = classifyTarget(connectionStringOrUrl);

  if (result.classification === 'production-like') {
    throw new ProductionTargetRejectedError(`Refusing target: ${result.reason}`);
  }
  if (result.classification === 'unknown' && !options.explicitlyConfirmedNonProduction) {
    throw new ProductionTargetRejectedError(
      `Refusing target: ${result.reason} Re-run with an explicit non-production confirmation if this is genuinely a disposable/isolated target.`,
    );
  }
  return result;
}

module.exports = {
  classifyTarget,
  assertSafeTarget,
  ProductionTargetRejectedError,
  PRODUCTION_HOST_SUFFIXES,
  LOCAL_SAFE_HOST_PATTERNS,
};
