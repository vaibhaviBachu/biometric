/**
 * Adds the CLIP image embedding the public scan needs to recognise a phone photo of a screen, for protected images that
 * were indexed before it existed. Only ONE key (`clip`) is added to each feature-index row; stored originals and every
 * other field are untouched. Images that cannot be read from the Vault (for example vaulted under a different key) are
 * skipped and counted.
 *
 * Dry run by default: counts what is missing and changes nothing.
 *
 *   node node_modules/ts-node-dev/lib/bin.js --transpile-only scripts/backfill-clip-embeddings.ts
 *   ... scripts/backfill-clip-embeddings.ts --apply [--limit 100] [--only <dnaRecordId>,<dnaRecordId>] [--expect 3]
 *
 * --only pins the run to exactly those DNA records (it refuses if any is not a gap); --expect N aborts unless that many
 * records would be processed. Start with --limit 5 --apply and check the result before running it on everything.
 *
 * WARNING: it uses whatever DATABASE_URL, vault storage and AI service the environment points at. The .env on a
 * developer machine is the production database: run the dry run first and --apply only when you mean to write.
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
  const only = flag('only')?.split(',').map((x) => x.trim()).filter(Boolean);
  const expect = flag('expect') ? Number(flag('expect')) : undefined;

  const gaps = await localDnaIndexService.findClipGaps({ limit });
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY RUN', missingClipEmbeddings: gaps.length, sample: gaps.slice(0, 5).map((g) => g.dnaRecordId.slice(0, 8)) }));
  if (expect !== undefined) {
    const planned = only ? only.length : gaps.length;
    if (planned !== expect) throw new Error(`Expected ${expect} records but ${planned} would be processed. Nothing was changed.`);
  }
  if (!apply) {
    console.log('Nothing was changed. Add --apply to build the missing embeddings.');
  } else {
    console.log(JSON.stringify(await localDnaIndexService.backfillClipEmbeddings({ dryRun: false, limit, only })));
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('CLIP backfill failed', err);
  process.exit(1);
});
