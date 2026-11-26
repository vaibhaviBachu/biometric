# Phase 2.4 — Final Findings Register

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

New finding IDs continue the `DB-GAP-` namespace from Phase 2.3's last (`DB-GAP-26`), checked against the
complete master register (Phase 1's 342 IDs, Phase 2.1's `01`–`09`, Phase 2.2's `10`–`21`, Phase 2.3's
`22`–`26`). This phase's new IDs: `DB-GAP-27` through `DB-GAP-31`, confirmed non-colliding.

---

## Part A — Resolved This Phase

| ID | Description | Severity | Affected service/table | Source path | Financial impact | Security impact | Concurrency impact | Fix | Test evidence | Independent review | Production dependency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **DB-GAP-27** | Exchange's `withImmediateTransaction` did not pin one connection for BEGIN/writes/COMMIT (root cause of `APIREL-H09`/`PGAP-02`), enabling a double-payout race in the withdrawal flow | **Critical** | Exchange, `exchange.orders_sealed`/`asset_commerce_locks` (incidentally protected) and `exchange.payouts`/`seller_earnings` (not protected — the real defect) | `exchange/server/drivers/postgres.js`, `lib/db.js`, `routes/payouts.js` | Confirmed: a real, reproduced double-payout of $425 against $425 of real earnings, before the fix | Financial-correctness defect, not a data-exposure one | Confirmed by direct PID-tracing and concurrent-load testing | `withTransactionClient()` + a row-count guard in `payouts.js` | 4/4 + 16/16 + 89/89 Hub regression; 194/198 Exchange suite (4 pre-existing, confirmed unrelated); concurrency tests re-run independently twice | **Resolved Locally, Independently Verified. Pending Production Verification** — not applied to production |
| **DB-GAP-28** | No `statement_timeout` anywhere (re-confirmation of `APIREL-L06`/`L10`) | Medium | Hub, all queries | `src/lib/prisma.ts` | — | A runaway query could hold a connection (and a pool slot) indefinitely | — | `options=-c statement_timeout=30000`, empirically proven to work (a naive `?statement_timeout=` param was tried first and proven NOT to work) | Re-verified twice independently (`pg_sleep` test) | **Resolved Locally, Independently Verified. Pending Production Verification** |
| **DB-GAP-29** | Dead `NODE_ENV === 'production' ? '10' : '10'` ternary (re-confirmation of `APIPERF-I02`) | Low | Hub | `src/lib/prisma.ts` | — | — | — | Collapsed to one documented constant; no invented production number | `tsc --noEmit` clean | **Resolved Locally** (code hygiene, not a behavior change) |
| **DB-GAP-02** | Exchange's production credential resolution silently fell back to Hub's `DATABASE_URL` if `EXCHANGE_DATABASE_URL` was unset — confirmed this phase to be the actual current configuration state, not merely a hypothetical | High | Exchange | `exchange/server/lib/db-config.js` | Potential, not confirmed to have occurred | Cross-service credential sharing | — | Fails closed in production instead | `db-config.test.js` 13/13 (2 tests rewritten) | **Resolved Locally, Independently Verified. Pending Production Verification** |

## Part B — New, Open, Production-Only Findings

| ID | Description | Severity | Evidence | Status | Production dependency | Target phase |
|---|---|---|---|---|---|---|
| **DB-GAP-30** | Hub's production connection uses the full administrative `postgres` role — zero least-privilege role separation exists; 889 grants on `postgres`, zero on any other application-shaped role (`dev_app`, `authenticated`, `anon`) | **High** | Direct, read-only `pg_roles`/`information_schema.role_table_grants` queries against production | Open — design proposed, not implemented | Requires creating/granting production roles, explicitly out of this phase's authority | Phase 2.4 design handed to whichever phase gets explicit authorization to change production grants — likely a dedicated follow-up, not automatically Phase 2.5 |
| **DB-GAP-31** | RLS is enabled (`relrowsecurity=true`) on key tables but structurally inert for all of Hub's current production traffic — the connecting role has `rolbypassrls=true` AND is the table owner AND `relforcerowsecurity=false` (three independent reasons) | **High** (confirms, does not create, an existing architectural fact) | Direct, read-only `pg_roles`/`pg_class` queries against production | Open — upgrades `AUTH-M10`/`PGAP-23`/`DB-GAP-08` from "unverified" to "verified inert" | Activation requires DB-GAP-30's role migration first, then staged non-production testing, then explicit approval | Same as DB-GAP-30 |

## Part C — Re-Confirmed Open, Unchanged, Correctly Not Actioned

| ID | Status this phase |
|---|---|
| `AUTH-M10`/`PGAP-23`/`DB-GAP-08` (Exchange's own RLS bypass) | Re-confirmed by direct re-read of `exchange.rls.sql`; unchanged |
| Hub/Exchange pool workload separation (`APIPERF-I02`'s broader concern) | Re-confirmed unresolved; no production load data exists to size a fix safely |
| `asset-360.service.ts` cross-schema exception | Re-confirmed **justified and correctly scoped** — not a defect, re-verified directly rather than re-cited |
| `DB-GAP-01` (database-identity mismatch) | Untouched, exactly as instructed |
| `DB-GAP-14` through `DB-GAP-21` (schema-drift/migration-tracking/modelling findings) | Untouched, exactly as instructed |

## Part D — Explicit Non-Findings (Checked, Nothing Wrong Found)

- Hub's Prisma `$transaction` usage (16 files) — connection pinning is a Prisma-runtime guarantee, not
  something application code can defeat the way Exchange's hand-rolled wrapper could; no defect found or
  plausible here.
- No automatic retry exists anywhere that could duplicate a non-idempotent financial write (checked by
  direct source search of both services).
- No external HTTP call was found inside any database transaction boundary on either service.
- No session-variable/`SET LOCAL` tenant-context pattern exists anywhere, so the specific "pooled-connection
  tenant-context leakage" risk the master prompt names does not apply to this architecture's current design.

## Part E — Severity Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | DB-GAP-27 |
| High | 3 | DB-GAP-02, DB-GAP-30, DB-GAP-31 |
| Medium | 1 | DB-GAP-28 |
| Low | 1 | DB-GAP-29 |
| Resolved this phase | 4 | DB-GAP-02, 27, 28, 29 |
| Open, production-only | 2 | DB-GAP-30, 31 |

## Part F — Phase 2.4 Verdict

**PASS WITH LIMITATIONS**, subject to the test evidence in
`PHASE_2_4_IMPLEMENTATION_AND_CONCURRENCY_TEST_REPORT.md` and the independent re-verification in
`PHASE_2_4_INDEPENDENT_SECURITY_AND_ARCHITECTURE_REVIEW.md`. The highest-priority item (financial transaction
safety) is resolved and independently re-verified twice. The two new production-only findings (DB-GAP-30/31)
are correctly left open pending explicit authorization this phase did not have and did not attempt to act on
unilaterally.
