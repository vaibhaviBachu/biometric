# Phase 2.5 — Database Backup, Recovery and Operational Readiness Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Backup Readiness — Reconfirmed, Unchanged From Phase 2.1

- **No automated backup mechanism exists in this codebase** — re-confirmed by a fresh search; no scheduled
  backup script, cron job, or CI step exists anywhere.
- `scripts/db-snapshot.cjs` remains, by its own header comment, an explicit developer safety net before
  schema work, not a disaster-recovery backup — it does not capture encrypted vault file bytes, and its own
  comment directs readers to "enable PITR in Supabase" for real backups.
- **Whether Supabase PITR is actually enabled on this project is a production-dashboard/billing-tier setting,
  not queryable from an ordinary SQL connection** — this phase attempted no workaround and records it,
  honestly, as still unverified rather than assumed either way.

## 2. Proposed (Not Verified) RPO / RTO

Labeled explicitly as **proposed targets for discussion, not measured or contractually committed values**:

| Target | Proposed value | Basis |
|---|---|---|
| RPO (Recovery Point Objective) | ≤ 24 hours, tightening to ≤ 5 minutes if Supabase PITR is confirmed enabled | PITR, where available, typically supports point-in-time recovery to within minutes; daily logical backups alone would only support a 24-hour RPO |
| RTO (Recovery Time Objective) | A few hours for a database of today's measured size (617 MB — `PHASE_2_5_DATABASE_SCALABILITY_AND_CAPACITY_ASSESSMENT.md`), growing with storage size, particularly with the TOAST-heavy tables (DB-GAP-33) | A restore's duration scales with total bytes restored, not row count — this database's unusual size profile (two tables holding 64% of total bytes in blob data) makes a PITR restore time estimate from row count alone misleading |

## 3. Backup Access Control, Encryption, Integrity Verification

Not independently verifiable from source — these are provider-managed (Supabase) settings with no
in-repository evidence either way, consistent with Phase 2.1's original conclusion. Not re-derived
differently this phase; no new evidence changes this status.

## 4. Restore Dependencies Beyond the Database Itself

Re-confirmed: Supabase Storage (the `vault-files` bucket) holds encrypted file bytes entirely separately from
the Postgres database. **A database-only restore does not restore vault files** — any disaster-recovery plan
must cover both independently, and no evidence exists in this codebase that the two are backed up on a
coordinated schedule. This is unchanged from Phase 2.1, re-stated here because it directly affects any RTO
estimate: a database-only restore leaving every `VaultRecord.encryptedFilePath` pointing at bytes that may or
may not still exist is not a complete recovery.

## 5. Observability — More Exists Than Phase 2.1's Original Framing Suggested; Corrected This Phase

Phase 2.1 stated "no monitoring/metrics instrumentation for query latency... exists anywhere in the
codebase." **This phase re-read the actual source and found that statement needs correction**:
`src/lib/request-timing.ts` provides real, working per-request query-timing instrumentation — for any
request slower than a configurable threshold (default 800ms), it logs the total query time, per-query
breakdown, and which specific queries were slowest. This is wired into `src/lib/prisma.ts`'s own `$use`
middleware (confirmed by direct re-read) and has been present and in use throughout this program's work,
simply never surfaced as a "metrics" line item in Phase 2.1's inventory because it is a **log line**, not a
persisted metric or dashboard panel.

| Capability | Status |
|---|---|
| Per-request query latency breakdown | **Present** (`request-timing.ts`), log-based, not persisted or dashboarded |
| Slow-query logging | **Present**, same mechanism, configurable threshold |
| Connection pool utilization (point-in-time) | **Measurable via direct `pg_stat_activity` query** (demonstrated this phase), not instrumented as an ongoing metric |
| Active/idle/idle-in-transaction session breakdown | Same — measurable on demand, not continuously monitored |
| Lock waits, deadlocks | **Not instrumented anywhere** |
| Transaction duration | Not instrumented beyond what `request-timing.ts` captures incidentally for requests that wrap a `$transaction` |
| Database CPU/memory/storage utilization | Provider-managed (Supabase dashboard), not in-repository |
| Index/table growth over time | **Not tracked anywhere** — this phase's own size figures are a one-time snapshot, not a historical series |
| Replication lag | Not applicable (no replica exists) |
| Migration status | Queryable via `_prisma_migrations` (demonstrated throughout Phase 2.2-2.5), not proactively alerted on |
| Backup/restore health | Not instrumented (see §1) |

## 6. Proposed Alert Thresholds (Recommendations, Not Measured Baselines)

Explicitly labeled as starting-point recommendations, not tuned against real traffic:

- Connection pool utilization > 80% of configured `connection_limit`/`max` sustained for 5+ minutes.
- Any query exceeding the new 30s `statement_timeout` (Phase 2.4) — should page, since it means a query was
  forcibly killed.
- `pg_stat_activity` showing any `idle in transaction` session older than 60 seconds (a potential leaked
  transaction, directly relevant given Phase 2.4's connection-pinning history).
- Index bloat (DB-GAP-32's pattern) recurring on any table exceeding 10 MB — low-cost to check periodically
  via the same `pg_stat_user_tables` query this phase used.

## 7. Observability Implementation Roadmap (Priority Order, Not Implemented This Phase)

1. **Low effort, high value:** periodically snapshot `pg_stat_user_tables`/`pg_database_size` output (the
   exact queries this phase used) into a small time-series table or external metrics store, closing the "no
   historical growth series exists" gap identified in every capacity-related report this phase wrote.
2. **Medium effort:** surface `request-timing.ts`'s existing log lines to a structured log aggregator (if one
   exists in the deployment environment — not verified by this phase) rather than leaving them as text logs
   only.
3. **Requires provider/infrastructure decision:** connection pool and lock-wait monitoring via Supabase's own
   dashboard metrics, or a lightweight periodic `pg_stat_activity` poll — either is a production
   configuration decision outside local code.

## 8. Verdict

Backup readiness remains an unresolved, production-only question — restated, not newly resolved, because no
new evidence exists to resolve it with. Observability is **materially better than Phase 2.1's original
inventory stated** — this phase corrects that record. A clear, low-effort first step (historical size
snapshotting) is identified and prioritized, not implemented, since it requires either a new scheduled job or
an external metrics destination this phase was not scoped to stand up.
