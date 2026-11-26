# Supabase lockdown (RLS, privileges, new-table guard)

**Status: prepared and rehearsed locally. NOT applied to production.** Read `docs/SUPABASE-RLS-PHASE2-PLAN.md` first.

| step | file | what it does | writes? |
|---|---|---|---|
| 0 | `scripts/audit-rls-readonly.cjs <before.json>` | before-state snapshot (feeds the rollback) | no (READ ONLY transaction) |
| 1 | `00-preflight.sql` | checks the role, prints what is open | no |
| 2 | `05-exposure-audit-readonly.sql` | counts and newest timestamps on exposed tables (was the exposure used?) | no |
| 3 | `01-contain-sensitive.sql` | RLS on + API privileges removed on the sensitive tables | yes (metadata only) |
| 4 | `02-enable-rls-and-revoke.sql` | the same for every table in `public`, `exchange`, `landing` | yes (metadata only) |
| 5 | `03-new-table-defaults.sql` | tables created later start with no API access | yes (default privileges only) |
| 6 | `04-verify.sql` | raises an error and lists offenders if anything is still open | no |
| opt | `optional/dev-app-readonly.sql` | read-only share of two non-sensitive tables for the shared `dev_app` login | yes |

Nothing here deletes or rewrites a row. Every statement is idempotent. Run as `postgres` in the Supabase SQL editor.

## Rollback (per table, never blanket)
`node scripts/rls-generate-rollback.cjs <before.json> --table public.credentials` prints the exact before-state for that table only
(add `--defaults` for new-table privileges, `--pg16` for servers older than PostgreSQL 17). `--reference` prints everything fully commented out.
There is no restore-everything mode: restoring re-opens the table to the public key. Prefer a narrow policy or grant for the one feature that breaks.

## Keeping it fixed
`scripts/ensure-rls.cjs` runs last in `npm run db:ensure-all` on every deploy: enables RLS on any table lacking it and removes API-role privileges.
It only warns on failure (like the other ensure scripts); `RLS_ENFORCE=1` makes leftovers fail the step. A table that must stay API-readable is added
to `RLS_PUBLIC_READ_TABLES` AND gets its own reviewed policy; `RLS_DEV_APP_READ_TABLES` lists tables whose dev_app read access is managed by the optional file.

## Rehearse locally (no Supabase involved)
```
npm install --no-save @electric-sql/pglite
node supabase/rls-lockdown/tests/run-local.cjs <before.json>
```
Rebuilds the production before-state in an in-memory Postgres and checks the whole procedure as `anon`, `authenticated`, `dev_app`, `service_role` and the owner.
