/**
 * One-off repair: shrink the authenticity heatmap already stored in vault records.
 *
 * Older records hold the heatmap as a photo-sized PNG (about 1.8 MB) inside vault_records."contentAnalysis".
 * Every read of such a record pulls that along, which made pages take tens of seconds. New records already
 * store a ~40 KB JPEG; this converts the old ones the same way (512 px longest side, JPEG quality 72) and
 * adds heatmapMime. Nothing else in the record is touched, and only the heatmap fields change.
 *
 *   node scripts/shrink-stored-heatmaps.cjs            report only (no writes)
 *   node scripts/shrink-stored-heatmaps.cjs --apply    write the smaller heatmaps
 *
 * WARNING: the .env DATABASE_URL on this machine is the production database. Run the report first, and
 * run --apply only when you intend to change production rows.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');

const APPLY = process.argv.includes('--apply');
const MAX_SIDE = 512;
const MIN_BYTES_TO_SHRINK = 200_000; // base64 characters; smaller heatmaps are already fine

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.$queryRaw`
    SELECT id, length("contentAnalysis"->>'heatmapPngBase64') AS len
    FROM vault_records
    WHERE "contentAnalysis" ? 'heatmapPngBase64'
      AND length("contentAnalysis"->>'heatmapPngBase64') > ${MIN_BYTES_TO_SHRINK}
    ORDER BY len DESC
  `;
  const totalBefore = candidates.reduce((s, r) => s + Number(r.len), 0);
  console.log(`${candidates.length} record(s) with a heatmap over ${MIN_BYTES_TO_SHRINK} characters, ${(totalBefore / 1048576).toFixed(1)} MB in total.`);
  if (!APPLY) {
    console.log('Report only. Run with --apply to shrink them.');
    return;
  }

  let totalAfter = 0;
  for (const row of candidates) {
    const rec = await prisma.vaultRecord.findUnique({ where: { id: row.id }, select: { contentAnalysis: true } });
    const analysis = rec && rec.contentAnalysis;
    if (!analysis || typeof analysis !== 'object' || typeof analysis.heatmapPngBase64 !== 'string') continue;
    const small = await sharp(Buffer.from(analysis.heatmapPngBase64, 'base64'))
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    const next = { ...analysis, heatmapPngBase64: small.toString('base64'), heatmapMime: 'image/jpeg' };
    await prisma.vaultRecord.update({ where: { id: row.id }, data: { contentAnalysis: next } });
    totalAfter += next.heatmapPngBase64.length;
    console.log(`${row.id}: ${(Number(row.len) / 1024).toFixed(0)} KB -> ${(next.heatmapPngBase64.length / 1024).toFixed(0)} KB`);
  }
  console.log(`Done. ${(totalBefore / 1048576).toFixed(1)} MB -> ${(totalAfter / 1048576).toFixed(1)} MB.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
