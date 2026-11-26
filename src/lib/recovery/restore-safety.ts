/**
 * PINIT-DNA — Phase 9/10: typed wrapper around the canonical production-
 * target guard for recovery/restore tooling.
 *
 * Phase 10 (DR9-ENV-01) moved the actual classification rule into
 * `db-target-guard.cjs` — a plain-CommonJS module every plain `.cjs`
 * operational script and the npm-script-level CLI gate
 * (`scripts/guard-db-target.cjs`) can `require()` directly, which a
 * TypeScript-only module could not be. This file now delegates to that
 * single source of truth instead of duplicating it, so the rule can never
 * drift between the two. Its own exported API is unchanged from Phase 9 —
 * every existing caller/test in this codebase keeps working without
 * modification.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('./db-target-guard.cjs') as {
  classifyTarget: (connectionStringOrUrl: string) => TargetClassificationResult;
  assertSafeTarget: (
    connectionStringOrUrl: string,
    opts?: { explicitlyConfirmedNonProduction?: boolean },
  ) => TargetClassificationResult;
  ProductionTargetRejectedError: new (message: string) => Error;
};

export type RestoreTargetClassification = 'local-safe' | 'unknown' | 'production-like';

export interface TargetClassificationResult {
  classification: RestoreTargetClassification;
  host: string;
  reason: string;
}

export const classifyRestoreTarget = guard.classifyTarget;

export const ProductionTargetRejectedError = guard.ProductionTargetRejectedError as new (
  message: string,
) => Error & { name: 'ProductionTargetRejectedError' };

/**
 * Throws unless the target is classified 'local-safe', or 'unknown' AND the
 * caller passed an explicit confirmation. 'production-like' can never be
 * overridden by this function — that is by design, not an omission.
 */
export function assertSafeRestoreTarget(
  connectionStringOrUrl: string,
  opts: { explicitlyConfirmedNonProduction?: boolean } = {},
): TargetClassificationResult {
  return guard.assertSafeTarget(connectionStringOrUrl, opts);
}
