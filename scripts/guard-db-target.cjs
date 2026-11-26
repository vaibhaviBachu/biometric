#!/usr/bin/env node
/**
 * PINIT-DNA — Phase 10: DR9-ENV-01 npm-script-level production-target gate.
 *
 * Run as the FIRST command in an `&&`-chain before any genuinely destructive
 * Prisma CLI invocation this repository defines — `prisma migrate dev`,
 * `prisma db push`, `prisma studio` — none of which go through any of this
 * application's own TypeScript code, so no in-app guard could ever reach
 * them. This script loads `.env` the same way Prisma's own CLI does
 * (dotenv, no override of already-set vars) and refuses to let the chain
 * continue if `DATABASE_URL`/`DIRECT_URL` classifies as production-like, or
 * as unknown without an explicit override.
 *
 * Deliberately does NOT guard `db:ensure-*` / `db:audit` / `db:snapshot` —
 * those are explicitly designed, by their own pre-existing docstrings, to be
 * safe to run against production (idempotent additive patches / read-only
 * audits); guarding them would break the real Render boot path, which
 * intentionally re-runs the `ensure-*` chain against production on every
 * deploy.
 *
 * Usage (inside package.json):
 *   "db:migrate": "node scripts/guard-db-target.cjs migrate dev && prisma migrate dev"
 *
 * Exit code 0: safe to proceed. Exit code 1: refused.
 *
 * Override for a genuinely non-local-but-not-production target (e.g. a
 * shared cloud dev/staging database that isn't on the recognized local-safe
 * host list): set PINIT_CONFIRM_NONLOCAL_DB=true. There is NO override for a
 * target that classifies production-like — that case always exits 1.
 */
require('dotenv').config();
const { assertSafeTarget, ProductionTargetRejectedError, classifyTarget } = require('../src/lib/recovery/db-target-guard.cjs');

function main() {
  const label = process.argv.slice(2).join(' ') || '(unnamed command)';
  const confirmNonLocal = (process.env.PINIT_CONFIRM_NONLOCAL_DB || '').toLowerCase() === 'true';

  const targets = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['DIRECT_URL', process.env.DIRECT_URL],
  ].filter(([, value]) => Boolean(value));

  if (targets.length === 0) {
    console.error(`[guard-db-target] REFUSED (${label}): neither DATABASE_URL nor DIRECT_URL is set. Failing safe rather than letting Prisma fall back to an ambiguous default.`);
    process.exit(1);
  }

  let anyUnknown = false;
  for (const [name, value] of targets) {
    const result = classifyTarget(value);
    console.log(`[guard-db-target] ${name} -> ${result.classification} (host: ${result.host || '(unresolved)'})`);
    if (result.classification === 'unknown') anyUnknown = true;
  }

  try {
    for (const [, value] of targets) {
      assertSafeTarget(value, { explicitlyConfirmedNonProduction: confirmNonLocal });
    }
  } catch (err) {
    if (err instanceof ProductionTargetRejectedError) {
      console.error(`[guard-db-target] REFUSED (${label}): ${err.message}`);
      if (!anyUnknown) {
        console.error('[guard-db-target] This target matches a known production/managed-cloud host pattern. There is no override for this — point DATABASE_URL/DIRECT_URL at a local or explicitly non-production target instead.');
      } else {
        console.error('[guard-db-target] Set PINIT_CONFIRM_NONLOCAL_DB=true to proceed if this is genuinely a non-production target this script does not recognize.');
      }
      process.exit(1);
    }
    throw err;
  }

  console.log(`[guard-db-target] OK (${label}): target classifies as safe to proceed.`);
}

main();
