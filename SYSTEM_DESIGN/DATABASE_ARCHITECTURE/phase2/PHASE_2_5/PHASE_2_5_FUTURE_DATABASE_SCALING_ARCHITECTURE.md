# Phase 2.5 — Future Database Scaling Architecture

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Principle: Staged, Evidence-Triggered Adoption — Not Premature Complexity

Every option below is evaluated against this program's own measured baseline (617 MB, 25,289 rows, 22/60
connections in use) and stated only as justified when a specific, named threshold is crossed — never as a
general "the platform will grow" argument.

## 2. Options Evaluated

### Vertical scaling (larger database instance)
**Problem it solves:** more CPU/RAM/IOPS for the same architecture. **Needed today?** No — nothing in this
phase's measurements (617 MB database, 22/60 connections, no slow-query evidence found) indicates the current
instance size is a constraint. **Trigger:** sustained high CPU/memory on the Supabase dashboard (not
observable from this codebase — a provider-side signal) or `statement_timeout` hits becoming frequent in
`request-timing.ts`'s logs. **Complexity:** low (a provider-managed resize). **Recommended first move** once
any real constraint is observed, before any of the architecturally heavier options below.

### Read replicas / read-write separation
**Problem it solves:** offloading read-heavy workloads (admin dashboards, reporting) from the primary.
**Needed today?** No measured read-heavy contention exists. **Trigger:** `request-timing.ts` logs showing
admin/reporting endpoints as a disproportionate share of total query time, combined with connection-pool
pressure from §`PHASE_2_5_CONNECTION_POOL_AND_DATABASE_THROUGHPUT_REPORT.md`. **Complexity:** medium —
requires explicit read/write routing in application code and **introduces replication lag as a new failure
mode**: any code path that writes then immediately reads its own write (common in this codebase's
check-then-act patterns, per Phase 2.4's own financial-concurrency findings) would need to either read from
the primary for that specific path or tolerate stale reads. **Not recommended until the connection-budget
threshold in the pooling report is actually being approached operationally**, since a pooler (§3) is a
lower-complexity way to buy headroom first.

### Connection pooling (PgBouncer/Supavisor transaction mode)
**Problem it solves:** the connection-budget ceiling identified in
`PHASE_2_5_CONNECTION_POOL_AND_DATABASE_THROUGHPUT_REPORT.md` (60 physical connections, reachable at 3+3
instances). **Needed today?** Not yet, but this is the **nearest actual threshold this entire Phase 2 program
has quantified** — closer than any storage or query-performance concern. **Complexity:** low, since a pooler
already sits in front of this instance for Hub's connection string; the open question is only its pooling
*mode*, not whether to adopt a pooler at all. **This is the single most likely next infrastructure decision
this platform will need**, and it requires no schema or application-architecture change — only a
configuration decision plus (per §5 of the pooling report) a compatibility check for any session-level
Postgres feature either service's code depends on.

### Query caching
**Problem it solves:** repeated identical reads. **Needed today?** No evidence of a hot, repeatedly-identical
query pattern was found anywhere in this phase's or prior phases' query inventories. **Not recommended** —
would add a cache-invalidation correctness burden with no identified workload to justify it.

### Materialized views
**Problem it solves:** expensive aggregation queries recomputed on every request. **Needed today?** No
expensive aggregation was found in this phase's query review beyond admin/reporting endpoints already bounded
by `take` limits. **Not recommended** at current scale; revisit if a specific reporting query is found to be
both slow (per `request-timing.ts`'s own logs, once reviewed) and acceptable to serve slightly stale.

### Partitioning
Covered fully in `PHASE_2_5_DATA_RETENTION_ARCHIVAL_AND_PARTITIONING_STRATEGY.md` §4 — not currently
justified by any table's measured row count.

### Archival databases
**Problem it solves:** moving cold, rarely-accessed historical data off the primary's storage/backup
footprint. **Needed today?** No — see the retention report's classification; no table has an approved
retention policy yet to archive against. **Trigger:** once a Category 3 table (e.g. `platform_events`) both
has an approved retention policy *and* has grown enough that its presence measurably affects backup duration
or primary storage cost.

### Separate databases for Hub and Exchange
**Explicitly evaluated and NOT recommended**, consistent with the instruction against recommending database
separation simply because the platform is expected to grow. The current schema-level separation (`public` vs
`exchange`, one justified cross-schema read exception) already provides the isolation that would matter; a
physically separate database would add operational complexity (two backup/restore processes, two
connection-budget ceilings to manage, loss of the one cross-schema read's current simplicity) without solving
a problem this phase found evidence for. **Revisit only if Exchange's own data volume or write load someday
becomes large enough to need independent scaling from Hub** — at Exchange's current measured 1.4 MB total
size, this is not close.

### Dedicated analytics/reporting database
**Problem it solves:** isolating reporting/admin query load from interactive traffic entirely, more
thoroughly than a read replica. **Needed today?** No. **Trigger:** same signal as read replicas, but chosen
over a read replica specifically if reporting needs diverge enough from the primary's schema shape to want
denormalization — not evidenced today. **Complexity:** high (a real ETL/sync process). **Last resort among
the options here, not a near-term recommendation.**

## 3. Staged Architecture (Recommended Sequence)

```
Today (617 MB, 22/60 connections)
   │
   ▼
Stage 1 — Confirm/configure Supavisor transaction-pooling mode
          (lowest complexity, addresses the nearest real threshold:
           connection budget under instance scale-out)
   │  trigger: approaching 2+ instances per service, or the
   │  60-connection ceiling being approached in pg_stat_activity
   ▼
Stage 2 — Vertical scale the primary instance
          (if CPU/memory/IOPS becomes the bottleneck, not connections)
   │  trigger: sustained resource pressure on the Supabase dashboard
   ▼
Stage 3 — Read replica for admin/reporting traffic specifically
          (only once request-timing.ts's own logs show reporting
           load as a real, disproportionate contributor)
   │  trigger: measured reporting-query share of total DB time
   ▼
Stage 4 — Partitioning / archival for whichever table first reaches
          the row-count scale where it matters (none today)
```

No stage is recommended before its trigger is actually observed. This program's own measured evidence places
today's architecture at "Stage 0" on this ladder — comfortably within its current design's capacity.

## 4. Verdict

The current architecture needs no scaling change today. The one option worth active attention soon — not
because of measured need, but because it is the single cheapest, lowest-risk move available and the nearest
quantified threshold — is confirming and, if necessary, correctly configuring the connection pooler already
sitting in front of this database. Every other option is explicitly staged behind evidence this program does
not yet have.
