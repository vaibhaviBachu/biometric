/**
 * Builds the missing search data (feature points) for protected images that have none: no index at all, or one built
 * without feature points. Only the search index is written; the stored originals are never modified.
 *
 * Dry run by default: lists what is missing and changes nothing.
 *
 *   node node_modules/ts-node-dev/lib/bin.js --transpile-only scripts/backfill-feature-index.ts
 *   ... scripts/backfill-feature-index.ts --apply --only <dnaRecordId>,<dnaRecordId> [--expect 3] [--owner <userId>]
 *
 * --only pins the run to exactly those DNA records (it refuses if any is not a gap); --expect N aborts unless that many
 * records would be processed. Both are strongly recommended with --apply.
 *
 * It uses whatever DATABASE_URL, vault storage and AI service the environment points at, so check those first.
 */
import { localDnaIndexService } from '../src/services/forensics/local-dna-index.service';
import { prisma } from '../src/lib/prisma';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

(async () => {
  const apply = flag('apply') !== undefined;
  const limit = flag('limit') ? Number(flag('limit')) : undefined;
  const ownerUserId = flag('owner');
  const only = flag('only')?.split(',').map((x) => x.trim()).filter(Boolean);
  const expect = flag('expect') ? Number(flag('expect')) : undefined;

  const { gaps, unsupported } = await localDnaIndexService.findIndexGaps({ limit, ownerUserId });
  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY RUN',
    missing: gaps.length,
    unsupportedHeic: unsupported,
    byReason: {
      NO_INDEX: gaps.filter((g) => g.reason === 'NO_INDEX').length,
      NO_FEATURE_POINTS: gaps.filter((g) => g.reason === 'NO_FEATURE_POINTS').length,
    },
    sizesMb: gaps.map((g) => Math.round(g.sizeBytes / 1048576)),
    gapIds: gaps.map((g) => g.dnaRecordId),
  }));
  if (only) console.log(JSON.stringify({ pinnedTo: only.map((id) => id.slice(0, 8)), count: only.length }));
  if (expect !== undefined) {
    const planned = only ? only.length : gaps.length;
    if (planned !== expect) throw new Error(`Expected ${expect} records but ${planned} would be processed. Nothing was changed.`);
  }
  if (!apply) {
    console.log('Nothing was changed. Add --apply to build the missing search data.');
  } else {
    const result = await localDnaIndexService.backfillMissing({ dryRun: false, limit, ownerUserId, only });
    console.log(JSON.stringify(result));
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('backfill failed', err);
  process.exit(1);
});
