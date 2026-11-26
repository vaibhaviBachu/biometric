# Phase 2.5 — Data Retention, Archival and Partitioning Strategy

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. No Retention or Archival Mechanism Exists Today — Reconfirmed, Not Assumed

A repo-wide search for any scheduled or ad-hoc row-deletion logic based on age
(`deleteMany`/`olderThan`/`retention` patterns in `src/services/scheduler/`) found **nothing** — re-confirming
Phase 2.1's original finding with a direct, fresh search rather than citing it. No table in this codebase has
any automatic expiry, archival, or deletion mechanism based on data age.

## 2. Append-Heavy / Audit-Style Tables — Classified

Using this phase's own measured row counts (`PHASE_2_5_DATABASE_SCALABILITY_AND_CAPACITY_ASSESSMENT.md` §2):

| Table | Measured rows | Classification | Rationale |
|---|---:|---|---|
| `audit_events` / `admin_audit_events` | Not in the top-20-by-size list (small today) | **Category 2 — legal/financial/audit retention** | Audit trails for admin actions and security-relevant events; a retention *floor*, not a ceiling, is the usual legal posture (keep for N years), never arbitrary early deletion |
| `security_events` | 1,350 live, 149 dead (never vacuumed) | **Category 2** | Same reasoning — security incident history |
| `forensic_provenance_events` | 2,193 | **Category 1 — must remain permanently** | This is the platform's core evidentiary record (DNA/forensic chain of custody) — the entire product's value proposition rests on this history being complete and tamper-evident, re-confirmed by `src/lib/prisma.ts`'s own `DnaRecord` hard-delete guard (DNA records cannot be deleted application-wide, by design) |
| `platform_events` | 2,855 | **Category 3 — archival candidate** | Operational/notification-style events, not evidentiary; a reasonable candidate for cold-storage archival past some age, pending a business decision on the exact age |
| `notifications` | 1,817 | **Category 4 — deletion-eligible under an approved policy** | User-facing, ephemeral by nature (already has read/unread semantics); no legal reason found in source to retain indefinitely |
| `share_access_logs` | 2,791 | **Category 2** | Supports Phase 1/2's own tenant-isolation and abuse-investigation evidence; access logs are frequently subject to a retention *requirement*, not just a deletion option |
| `video_frame_dna`, `local_dna_patches`, `structural_layers`, `semantic_layers`, `stego_layers`, `metadata_layers` and sibling layer tables | 580-1,088 each | **Category 1, tied to `DnaRecord`** | These are the forensic layer data the hard-delete guard protects by extension — deleting them without deleting the `DnaRecord` they support would break the evidentiary chain |
| `billing_history` | Not in top 20 (small) | **Category 2** | Financial records — standard retention expectations apply; also now `onDelete: Restrict` from its parent `Subscription` (Phase 2.2's DB-GAP-10), which already prevents silent loss |

**No retention period is invented anywhere in this table.** Every "Category 2/3/4" classification above
states what *kind* of decision is needed, never a specific number of days/years — that number is explicitly
a business/legal decision this phase has no standing to make.

## 3. Archival Strategy — Design, Not Implemented

For Category 3 candidates (`platform_events` and similarly-shaped operational-event tables), a standard,
low-risk archival pattern would be: once a business-approved age threshold is set, move matching rows to a
separate cold-storage table (or export to Supabase Storage as a compressed batch) and delete only after a
successful, verified copy — never delete-then-archive. **Not implemented this phase** — no approved age
threshold exists to implement against, and this phase does not invent one.

## 4. Partitioning Assessment — Not Currently Justified

Per the explicit instruction not to partition merely because a table *may* grow large: **no table in this
database currently justifies partitioning.** The largest tables by size (`spatial_auth_packages`,
`dna_records`) are large due to TOAST-stored blob content on a small number of rows (396 MB across barely
1,000 rows combined — see `PHASE_2_5_DATABASE_SCALABILITY_AND_CAPACITY_ASSESSMENT.md` §3), not due to row
count — partitioning solves a row-count/row-churn problem, not a per-row-size problem, and would not address
this database's actual size driver. The largest *row-count* tables today (`platform_events` at 2,855,
`share_access_logs` at 2,791) are two to three orders of magnitude below where PostgreSQL partitioning
typically starts paying for its own operational complexity (tens of millions of rows). **Recommendation:
revisit this question only once a table's row count reaches the low millions and query patterns show
partition-pruning would measurably help** — not before.

## 5. What a Future Partitioning Decision Would Need to Consider (Recorded for That Future Phase)

- Range/time-based partitioning would be the natural fit for append-only event tables (`platform_events`,
  `audit_events`, `security_events`) if they ever reach the scale that justifies it.
- Every unique constraint and foreign key referencing a would-be-partitioned table needs re-verification —
  PostgreSQL requires the partition key to be part of any unique constraint on a partitioned table, which
  several of these tables' existing `@@unique` constraints do not currently satisfy (not re-derived
  exhaustively this phase; flagged as a prerequisite check for whoever picks this up).
- Migration complexity is non-trivial: converting an existing non-partitioned table to partitioned requires
  either a full table rewrite or a shadow-table-and-swap approach, both of which need a maintenance window at
  real production scale.

## 6. Verdict

No data was archived, deleted, or partitioned this phase — none of these tables are large enough by row
count to justify it, and no approved retention policy exists to execute against even where it might
eventually matter. Every table has been explicitly classified by data-permanence category so that whenever a
retention policy *is* approved, the classification work does not need to be redone from scratch.
