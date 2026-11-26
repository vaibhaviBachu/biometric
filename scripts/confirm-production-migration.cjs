#!/usr/bin/env node
/**
 * PINIT-DNA — Phase 10: explicit-confirmation gate for `db:migrate:prod`.
 *
 * `prisma migrate deploy` against production is this repository's one
 * *intentional* production-targeting command — the opposite problem from
 * DR9-ENV-01's main risk (an accidental connection), but the same incident
 * class can occur the other way: muscle memory typing `npm run
 * db:migrate:prod` when `db:migrate` (local dev) was meant, or vice versa.
 * This gate does not classify or block the target — that would defeat the
 * command's own purpose — it only requires a positive, explicit, separate
 * confirmation that a human actually means to run it right now.
 *
 * Usage: PINIT_CONFIRM_PRODUCTION_MIGRATION=true npm run db:migrate:prod
 */
const confirmed = (process.env.PINIT_CONFIRM_PRODUCTION_MIGRATION || '').toLowerCase() === 'true';

if (!confirmed) {
  console.error('[confirm-production-migration] REFUSED: this runs `prisma migrate deploy` against whatever DATABASE_URL is currently set.');
  console.error('[confirm-production-migration] Set PINIT_CONFIRM_PRODUCTION_MIGRATION=true explicitly if you intend this right now.');
  process.exit(1);
}

console.log('[confirm-production-migration] Confirmed — proceeding to prisma migrate deploy.');
