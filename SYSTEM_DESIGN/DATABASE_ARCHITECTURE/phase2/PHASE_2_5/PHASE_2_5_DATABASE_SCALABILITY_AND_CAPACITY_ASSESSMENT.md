# Phase 2.5 — Database Scalability and Capacity Assessment

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 0. Methodology

Every figure in this report is either (a) a direct, read-only PostgreSQL catalog/statistics query against
production (`pg_stat_user_tables`, `pg_database_size`, `pg_indexes_size`, `SHOW max_connections`,
`pg_stat_activity` — never a full-table scan, never a write), or (b) explicitly labeled an assumption-based
scenario. Nothing below is invented.

## 1. Current Architecture (Revalidated)

Re-confirmed unchanged since Phase 2.4: Hub (Prisma, `public` schema, one shared client, `connection_limit=10`,
30s `statement_timeout` added in Phase 2.4) and Exchange (raw `pg.Pool`, `exchange` schema, `max: 10`,
connection-pinning fixed in Phase 2.4) both connect to the same physical Supabase Postgres instance via
independent pools. `asset-360.service.ts` remains the one justified, ownership-gated cross-schema read
exception. Redis and MinIO remain confirmed unused (re-confirmed by repo-wide search, unchanged from Phase 2.1).

```
┌─────────────────────────────────────────────────────────────────┐
│  Supabase Postgres 17.6 (aarch64), ap-southeast-1                 │
│  Total database size: 617 MB  |  max_connections: 60              │
│  ┌──────────────┐          ┌──────────────┐                       │
│  │ public schema │          │ exchange schema│                     │
│  │ 25,289 live   │          │ 1.4 MB total   │                     │
│  │ rows (public) │          │                │                     │
│  └──────┬───────┘          └───────┬────────┘                      │
└─────────┼──────────────────────────┼───────────────────────────────┘
          │ Prisma pool (limit 10)   │ pg.Pool (max 10, now pinned
          │                          │ per-transaction — Phase 2.4)
     ┌────┴─────┐               ┌────┴──────┐
     │  Hub      │               │ Exchange  │
     │ (Node)    │◄── HTTP ─────►│ (Node)    │
     └───────────┘  bridge-secret └───────────┘
          │
          │ one documented, ownership-gated exception:
          │ asset-360.service.ts reads exchange.* directly
          ▼
   Supabase Storage (vault-files bucket) — separate from the database
```

## 2. Measured Current Scale — This Is a Small, Early-Stage Database

| Metric | Value | How obtained |
|---|---|---|
| Total database size (all schemas) | **617 MB** | `pg_database_size(current_database())` |
| Total live rows, `public` schema | **25,289** | `SUM(n_live_tup)` across `pg_stat_user_tables` |
| Exchange schema total size | **1.4 MB** | `SUM(pg_total_relation_size)` for `exchange.*` tables |
| Postgres server `max_connections` | **60** | `SHOW max_connections` |
| Connections in use at measurement time | **22** (1 active, 14 idle, 1 untracked state), across the whole instance | `pg_stat_activity` |
| Postgres version | 17.6, aarch64 | `SELECT version()` |

**This is not an enterprise-scale dataset today.** Every capacity scenario below is explicitly built from this
measured baseline plus stated growth assumptions, never from an invented "expected" user count.

## 3. A Significant, Previously-Undocumented Storage Finding: TOAST-Dominated Tables (DB-GAP-33)

| Table | Live rows | Table heap | Indexes | **Total size** |
|---|---:|---:|---:|---:|
| `spatial_auth_packages` | 171 | 184 kB | 88 kB | **213 MB** |
| `dna_records` | 661 | 680 kB | 208 kB | **183 MB** |

Together these two tables — barely 1,000 rows combined — account for **396 MB of the database's 617 MB
total (≈64%)**. The gap between "table + index size" and "total size" is PostgreSQL's TOAST mechanism
storing large column values (`spatial_auth_packages.blockBlob BYTEA`, and large JSON/analysis columns on
`dna_records`) out-of-line. **This is expected behavior given the schema design, not a defect** — but it is
the single most important fact for every capacity projection in this report: **this database's growth is
driven overwhelmingly by per-row blob size on a small number of tables, not by row count.** A capacity model
that only projects row-count growth without accounting for this would be badly wrong.

## 4. A Second Finding: ~63 MB of Index Bloat on Near-Empty Tables (DB-GAP-32)

| Table | Live rows | Index size |
|---|---:|---:|
| `local_dna_patches` | **0** | **51 MB** |
| `monitoring_runs` | 14 | 6.3 MB |
| `crawl_results` | **0** | 2.9 MB |
| `crawler_jobs` | **0** | 2.8 MB |

Three of these four tables currently hold **zero live rows** yet carry multiple megabytes of index structure
— the classic signature of index bloat from past inserts/deletes whose space was never reclaimed (no
`last_vacuum` recorded for several of these in `pg_stat_user_tables`). **≈63 MB, roughly 10% of the entire
database's current size, is recoverable, wasted index space on tables holding almost no data.** Reclaiming it
requires a `REINDEX`/`VACUUM` — a production action, out of this phase's authority; recorded as a
recommendation, not performed.

## 5. Capacity Scenarios

All three scenarios build from the §2 baseline with **explicitly stated assumptions** — none are measured
production projections.

### Scenario 1 — Current Operating Scale (measured baseline, not a projection)
617 MB database, 25,289 rows, 22/60 connections in use. No action needed at this scale.

### Scenario 2 — Medium Growth (assumption: 50x current row count, blob-bearing tables grow proportionally)
*Assumption stated explicitly: this scenario assumes uniform 50x growth across all tables, which §3's finding
makes unlikely to be accurate in practice — blob-heavy tables will very plausibly grow faster than row-count
alone would suggest. Presented as a stress-test of the assumption, not a prediction.*
- Projected row count: ~1.26M (public schema).
- Projected storage: if blob-bearing tables (`spatial_auth_packages`, `dna_records`) scale with row count
  alone, ≈20 GB; if per-row blob size also grows (more realistic given richer forensic data per asset over
  time), this is a **floor estimate, not a ceiling**.
- Connections: unchanged unless instance count grows — the connection ceiling (§6) is driven by deployment
  topology, not data volume.

### Scenario 3 — High Growth / Enterprise Scale (assumption: 1000x current row count)
- Projected row count: ~25M (public schema) — plausible for a mature, multi-year, many-organization deployment.
- Projected storage: tens of GB to low hundreds of GB range depending on per-row blob size trends; **no
  reliable point estimate is possible from current evidence alone** — this is explicitly flagged as needing
  real production growth-rate data (month-over-month table-size deltas), which does not exist today (no
  historical snapshot series was found anywhere in this repository or made available to this phase).
- Connections: **this is where the measured `max_connections=60` ceiling becomes the binding constraint, not
  storage** — see §6.

## 6. Connection Capacity — The Nearest Real Threshold

This is the one scenario this phase found where a hard, measured ceiling is already within plausible reach
at only modest scale-out, not at a hypothetical "enterprise" data volume:

- Hub's Prisma pool: `connection_limit=10` per Hub instance.
- Exchange's `pg.Pool`: `max: 10` per Exchange instance.
- Measured server ceiling: **60** total connections, instance-wide (all databases, all services).
- **At just 3 Hub instances + 3 Exchange instances, 10×3 + 10×3 = 60 — the entire connection budget is
  consumed by application pools alone, with zero headroom for migrations, admin dashboards, or analytics
  connections.** This is a real, quantified threshold, not a guess.

Full detail: `PHASE_2_5_CONNECTION_POOL_AND_DATABASE_THROUGHPUT_REPORT.md`.

## 7. Scaling Thresholds That Would Trigger Architectural Change

| Trigger | Current headroom | Action needed when reached |
|---|---|---|
| Any horizontal scale-out beyond ~2-3 instances per service | **Imminent** — 60-connection ceiling, not a future concern | Move to a transaction-pooling-mode connection pooler (Supavisor is already in front of this instance per the connection string's own `pooler.supabase.com` host — confirm it is actually configured for transaction-pooling mode, not just routing, before scaling instance count) |
| `spatial_auth_packages`/`dna_records` blob growth rate | Unmeasured (no historical series exists) | Establish a monthly size-snapshot process (§`PHASE_2_5_DATABASE_BACKUP_RECOVERY_AND_OPERATIONAL_READINESS_REPORT.md`) before this can be projected reliably |
| Index bloat recurrence | 63 MB today, trivial at this scale | Becomes operationally relevant once total DB size reaches the low-GB range and routine `VACUUM`/`REINDEX` scheduling matters |

## 8. Evidence Limitations (Stated Explicitly)

- No historical size/row-count series exists anywhere (not in this repository, not made available to this
  phase) — every growth scenario above is a stated assumption, never a measured trend.
- No request-volume, active-user, or query-frequency metric exists anywhere in this codebase (re-confirmed
  from Phase 2.1) — workload frequency throughout this phase's reports is marked "unknown" wherever it cannot
  be derived from source alone.
- Connection-count measurement (§2) is a single point-in-time snapshot, not a sampled-over-time baseline —
  stated as such, not presented as a utilization trend.

## 9. Verdict

The current architecture comfortably supports today's measured scale (617 MB, 25K rows, 22/60 connections).
The nearest real scaling threshold is **connection capacity under horizontal instance scale-out**, not data
volume — a concrete, quantified, currently-unaddressed constraint. Storage growth is dominated by two
blob-heavy tables in a way that makes naive row-count-based projection unreliable; this is documented
honestly as a limitation rather than papered over with an invented growth curve.
