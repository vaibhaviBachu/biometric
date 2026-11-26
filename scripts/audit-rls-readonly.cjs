/**
 * READ-ONLY audit and BEFORE-STATE SNAPSHOT of Row Level Security, policies and grants on the PINIT Supabase project.
 *
 *  - Runs inside one transaction that is switched to READ ONLY before any query: Postgres rejects any write.
 *  - Reads catalog metadata only (see scripts/lib/rls-audit-queries.cjs) and two COUNTS on hoid_identities if it exists.
 *    It never selects a row from a data table, so no face image, token or personal field is read.
 *  - Never prints connection settings. The snapshot goes to the file given as argv[2].
 *
 *   node scripts/audit-rls-readonly.cjs <snapshot.json>
 *   node scripts/rls-generate-rollback.cjs <snapshot.json> [--table schema.table]   # builds the per-table rollback from it
 *
 * WARNING: it uses whatever DATABASE_URL the environment holds (the developer .env is the production database).
 */
require('dotenv').config();
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { QUERIES } = require('./lib/rls-audit-queries.cjs');

(async () => {
  const prisma = new PrismaClient();
  const out = { takenAt: new Date().toISOString() };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      for (const [name, sql] of Object.entries(QUERIES)) {
        if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing to run a non-SELECT statement: ${name}`);
        try {
          out[name] = await tx.$queryRawUnsafe(sql);
        } catch (err) {
          out[name] = { error: String(err.message || err).split('\n')[0].slice(0, 200) };
        }
      }
      // Counts only. The table name comes from the catalog query above, never from input.
      out.hoidIdentities = [];
      for (const loc of Array.isArray(out.hoidLocations) ? out.hoidLocations : []) {
        const ident = `"${String(loc.schema).replace(/"/g, '""')}"."${String(loc.name).replace(/"/g, '""')}"`;
        const rows = await tx.$queryRawUnsafe(`select count(*) as rows, count(face_image) as with_face_image, count(webauthn_credential_id) as with_credential_id from ${ident}`);
        out.hoidIdentities.push({ location: `${loc.schema}.${loc.name}`, ...rows[0] });
      }
    }, { timeout: 60000, maxWait: 30000 });
  } finally {
    await prisma.$disconnect();
  }
  const json = JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
  const file = process.argv[2];
  if (file) fs.writeFileSync(file, json);
  console.log(file ? `wrote ${file}` : json);
})().catch((e) => { console.error('audit failed:', String(e.message || e).split('\n')[0]); process.exit(1); });
