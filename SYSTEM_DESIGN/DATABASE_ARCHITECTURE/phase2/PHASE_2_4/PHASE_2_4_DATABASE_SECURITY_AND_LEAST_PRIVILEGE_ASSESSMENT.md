# Phase 2.4 — Database Security and Least-Privilege Assessment

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 0. Methodology and Safety

Production's actual role/grant structure was inspected via **read-only** `SELECT` queries against
`pg_roles`, `pg_class`, `pg_tables`, and `information_schema.role_table_grants` — no write, no role change,
no permission change, no credential rotation. No secret *value* (password) was read, printed, or needed for
any conclusion below; only role names, boolean attribute flags, and grant counts. This mirrors the precedent
Phase 2.1 set in its own §6 credential-sharing check.

## 1. Production Role Inventory (Confirmed, Not Inferred From Local Config)

| Role | `rolsuper` | `rolcreaterole` | `rolcreatedb` | `rolcanlogin` | `rolbypassrls` |
|---|---|---|---|---|---|
| `postgres` | false | true | true | true | **true** |
| `dev_app` | false | false | false | true | false |
| `authenticated` | false | false | false | false | false |
| `anon` | false | false | false | false | false |
| `service_role` | false | false | false | false | true |
| `supabase_admin` | true | true | true | true | (superuser — implicitly bypasses) |
| (several more `supabase_*` managed roles, standard Supabase infrastructure, not application-relevant) | | | | | |

## 2. DB-GAP-30 — Hub's Production Connection Uses the Full Administrative Role (New Finding)

**Confirmed, not assumed:** Hub's production `DATABASE_URL` connects via the Supabase pooler as
`postgres.<project-ref>` — resolving to the `postgres` role itself (the pooler's per-project routing
convention), not a dedicated, scoped application role. This is the same role that owns the `users` table
(`SELECT tableowner FROM pg_tables WHERE tablename='users'` → `postgres`) and every other table in `public`.

**Grant-count evidence:** `information_schema.role_table_grants` shows **889 grants to `postgres`** across
the `public` schema and **zero grants to `dev_app`, `authenticated`, or `anon`** on any `public` table. A
role named `dev_app` exists (with `rolcanlogin: true`, otherwise unprivileged flags) but is **not wired to
any table grant at all** — it looks like the beginning of a least-privilege separation that was never
finished or never adopted.

**Severity: High.** Hub's entire application surface runs under the same account that can create/drop
roles, create/drop databases, and (per §3 below) bypasses row-level security entirely. A SQL-injection
defect anywhere in the ~60 raw-SQL call sites Phase 2.1 catalogued, or a compromised credential, would grant
an attacker the same administrative power as the database's own operator — not merely access to Hub's own
data.

**Not fixed this phase:** per explicit instruction, this phase does not create, rotate, or change any
production credential or permission. A least-privilege role design is proposed in §4 for separate,
explicitly-authorized implementation.

## 3. DB-GAP-31 — RLS Is Enabled But Structurally Bypassed for All Current Hub Traffic (New Finding, Upgrades AUTH-M10/PGAP-23/DB-GAP-08 From "Unverified" to "Verified")

Phase 2.1 could only say Hub's RLS lockdown was "prepared and rehearsed locally... live-production RLS state
UNVERIFIED." This phase verified it directly:

| Table | `relrowsecurity` (RLS enabled) | `relforcerowsecurity` (forced even for owner) |
|---|---|---|
| `users` | **true** | false |
| `share_links` | **true** | false |
| `vault_records` | **true** | false |

RLS genuinely **is** enabled on these tables in production today. But:

1. The connecting role, `postgres`, has `rolbypassrls = true` — an absolute role attribute. A role with this
   flag ignores every RLS policy on every table, unconditionally, regardless of what the policies say.
2. Independently, `postgres` is also the **table owner**, and `relforcerowsecurity` is `false` — by Postgres's
   own default behavior, a table's owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is explicitly set,
   which it is not here. This is a second, independent reason RLS provides no protection for this
   connection, on top of the first.

**Conclusion, now verified rather than assumed:** RLS provides **zero actual protection for any of Hub's own
production application traffic today**, for two compounding, independent reasons. This confirms, for Hub,
exactly what Exchange's own RLS file already said about itself ("Exchange Node uses `DATABASE_URL`, often
bypasses RLS") — Hub's situation is not "often," it is **always**, by two separate structural guarantees.

**Severity: High — but this is not a new exposure, it is confirmation of an already-known architectural
fact.** Phase 2.1 already correctly concluded that application-level filtering, not RLS, is Hub's real
tenant-isolation mechanism; this phase's contribution is removing the word "unverified" from that
conclusion for Hub's production environment specifically.

## 4. Proposed Least-Privilege Role Architecture (Design Only — Not Implemented)

Per explicit instruction, this is a design for separate, explicitly-authorized future implementation — no
production role, grant, or credential was created or changed this phase.

| Proposed role | Purpose | Suggested privileges |
|---|---|---|
| `hub_app` | Hub's own runtime connection | `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `public` schema tables only; no `CREATEROLE`/`CREATEDB`; `NOBYPASSRLS` |
| `exchange_app` | Exchange's own runtime connection | Same shape, scoped to the `exchange` schema only, plus the specific cross-schema read grants `asset-360.service.ts` genuinely needs (see §5) |
| `readonly_reporting` | Future analytics/reporting tooling | `SELECT`-only across both schemas, `NOBYPASSRLS` |
| `migration_admin` | `prisma migrate deploy` / schema changes only | DDL privileges, used only for migration runs, never by the running application |

The already-existing but unused `dev_app` role is a plausible starting point for `hub_app` once it is
actually granted the privileges above — it already has the right *shape* (`rolcanlogin: true`,
`rolbypassrls: false`, no elevated flags), it simply has no grants wired to it yet.

**This phase does not recommend `FORCE ROW LEVEL SECURITY`** until the above role migration happens first —
forcing RLS before the application connects as a non-bypassing role would simply make `postgres`'s own
administrative/migration work subject to RLS too, which is not the intent.

## 5. Cross-Service Database Boundary — `asset-360.service.ts`

Re-confirmed by direct re-read this phase: the one direct Hub→`exchange.*` raw-SQL exception
(`src/services/assets/asset-360.service.ts`) is correctly ownership-gated — it resolves and verifies
`Asset.ownerUserId` against the authenticated user via a tenant-scoped Prisma `findFirst` **before** issuing
any of its `exchange.listings`/`orders_sealed`/`seller_earnings`/`refunds`/`reviews`/`wishlist`/`cart_items`
raw queries, and every one of those is itself scoped by the already-verified `asset_id`. **This remains a
justified, correctly-implemented reporting exception, not a boundary violation** — re-confirmed, not merely
re-cited from Phase 2.1.

## 6. Credential Sharing — DB-GAP-02, Status Upgraded From "Architectural Assumption" to "Confirmed Current State," Then Fixed

Phase 2.1 framed DB-GAP-02 as "not a confirmed incident, an architectural assumption that is not
code-enforced." This phase found, by checking this project's own `.env` (read-only, no value printed beyond
the non-secret username portion): **`EXCHANGE_DATABASE_URL` is not set in this environment's configuration
at all.** Before this phase's fix, Exchange — if deployed with today's actual configuration — would have
silently connected using Hub's exact `DATABASE_URL` credential (same `postgres.<project-ref>` identity).
This upgrades the finding from a hypothetical to the literal current configuration state. **Fixed this
phase**: `exchange/server/lib/db-config.js` now fails closed in production when `EXCHANGE_DATABASE_URL` is
absent, rather than falling back — re-verified by the project's own `db-config.test.js` (13/13 passing,
including two tests rewritten to assert the new, correct behavior).

## 7. TLS, Encryption at Rest, Network Exposure

Unchanged from Phase 2.1: provider-managed (Supabase), not independently re-verifiable from source, not
re-investigated this phase since nothing in this codebase controls or evidences either.

## 8. Verdict

Two new, concretely-verified (not inferred) production findings this phase: no least-privilege role
separation exists (DB-GAP-30), and RLS is confirmed structurally inert for all of Hub's current traffic
(DB-GAP-31). One carried-forward finding (DB-GAP-02) was upgraded from assumption to confirmed current state
and then fixed. No production role, grant, or credential was touched.
