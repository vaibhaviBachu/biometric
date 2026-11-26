/**
 * Portfolio view log: one row for each real visit to a published portfolio link.
 *
 * ADDITIVE AND IDEMPOTENT. Safe on every boot. Creates one table and one index; drops, renames and rewrites nothing.
 * No foreign key on purpose: the history must not vanish because something else changed. It is removed only when the
 * owner deletes the portfolio (see portfolio-views.service.ts), never by a clean-up job.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const log = (...a) => console.log('[ensure-portfolio-view-logs]', ...a);

const DDL = [
  `CREATE TABLE IF NOT EXISTS "portfolio_view_logs" (
     "id"          TEXT PRIMARY KEY,
     "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "portfolioId" TEXT NOT NULL,
     "slug"        TEXT NOT NULL,
     "ipAddress"   TEXT,
     "userAgent"   TEXT,
     "deviceType"  TEXT,
     "os"          TEXT,
     "browser"     TEXT,
     "country"     TEXT,
     "region"      TEXT,
     "city"        TEXT,
     "referrer"    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS "portfolio_view_logs_portfolioId_createdAt_idx" ON "portfolio_view_logs" ("portfolioId", "createdAt")`,
];

(async () => {
  try {
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql);
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM "portfolio_view_logs"`);
    log(`ok — portfolio view log ready (${n} row${n === 1 ? '' : 's'})`);
  } catch (err) {
    log('WARNING — could not ensure the portfolio view log:', String(err.message || err).split('\n')[0]);
  } finally {
    await prisma.$disconnect();
  }
})();
