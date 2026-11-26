/**
 * One-time backfill: give every existing notification a class, so the bell and unread badge can finally see the ones that matter.
 *
 * WHY: `notifications.notificationClass` was only ever written for Business events. Every other row has NULL, and the bell
 * (and its badge) only counts NOTIFICATION and ALERT rows. New rows now get a class when they are written
 * (src/services/platform-events/notification-class-table.json); this script classifies the ones written before that.
 *
 * WHAT IT DOES (and nothing else):
 *   - For rows with notificationClass IS NULL and createdAt <= the cutoff, sets notificationClass from the type table.
 *     A type that is not in the table becomes ACTIVITY (history only, never badged).
 *   - With --mark-read (the approved logic), marks those same rows read, so a person's bell does not open with hundreds of
 *     "unread" rows they never had the chance to see. Rows are never marked read in any other way.
 *   - It never inserts, never deletes, never changes a title, body, link or date, and never touches a row that already has a class.
 *
 * SAFE TO RE-RUN: it only touches rows whose class is still NULL, so a second run changes 0 rows.
 *
 * USAGE
 *   Dry run (default; changes nothing, prints and saves a report):
 *     DATABASE_URL=postgresql://pinit:pinit@localhost:5435/pinit_hub node scripts/backfill-notification-class.cjs
 *   Apply (after reading the dry run):
 *     DATABASE_URL=... node scripts/backfill-notification-class.cjs --apply --mark-read
 *   Roll back (restores class to NULL and read to what it was):
 *     DATABASE_URL=... node scripts/backfill-notification-class.cjs --rollback --backup-table=notifications_class_backup_YYYYMMDDHHMM
 *
 * SAFETY
 *   - Apply and rollback print the database host and wait for BACKFILL_CONFIRM_DB_HOST=<that host> to be set.
 *   - A hosted database (Supabase, Render, AWS) additionally needs --allow-production. This script is meant to be tested on a
 *     throwaway Docker Postgres first (docker-compose.dev.yml, port 5435). It is NOT run against production by the build.
 *   - Before changing anything, apply copies the id, class, read and archived values of every row it will touch into a new
 *     backup table (notifications_class_backup_<timestamp>) in the same transaction.
 *
 * BACKUP AND ROLLBACK, in plain SQL if you prefer (replace the table name):
 *   Backup (also done by --apply):  CREATE TABLE notifications_class_backup_X AS
 *                                     SELECT id, "notificationClass", "read", "archived", NOW() AS backed_up_at FROM notifications WHERE "notificationClass" IS NULL;
 *   Roll back:  UPDATE notifications n SET "notificationClass" = b."notificationClass", "read" = b."read"
 *               FROM notifications_class_backup_X b WHERE n.id = b.id;
 *   For a full safety copy before running on any real database, take a normal database backup (pg_dump -t notifications).
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k) => { const a = args.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : null; };

const APPLY = has('--apply');
const ROLLBACK = has('--rollback');
const MARK_READ = has('--mark-read');
const ALLOW_PROD = has('--allow-production');
const CUTOFF = val('--before') || new Date().toISOString();
const BACKUP_TABLE = val('--backup-table');

const table = require(path.join(__dirname, '..', 'src', 'services', 'platform-events', 'notification-class-table.json'));
const classOfType = {};
for (const cls of ['ACTIVITY', 'NOTIFICATION', 'ALERT']) for (const t of table[cls]) classOfType[t] = cls;
const classFor = (type) => classOfType[type] || 'ACTIVITY';

function hostOf(url) {
  try { return new URL(url).host; } catch { return '(unreadable)'; }
}

function looksHosted(host) {
  return /supabase|pooler|render\.com|amazonaws|neon\.tech|azure|googleusercontent/i.test(host);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Point it at the database to read or change.');
  const host = hostOf(url);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const num = (v) => Number(v);
  try {
    console.log(`Database: ${host}`);
    console.log(`Mode: ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN (nothing is changed)'}  ·  cutoff: ${CUTOFF}  ·  mark historical rows read: ${MARK_READ ? 'yes' : 'no'}`);

    if (APPLY || ROLLBACK) {
      if (process.env.BACKFILL_CONFIRM_DB_HOST !== host) {
        throw new Error(`Refusing to change ${host}. Set BACKFILL_CONFIRM_DB_HOST=${host} to confirm this is the database you mean.`);
      }
      if (looksHosted(host) && !ALLOW_PROD) {
        throw new Error(`${host} looks like a hosted database. Test on the Docker Postgres first; pass --allow-production only when you mean it.`);
      }
    }

    if (ROLLBACK) {
      if (!BACKUP_TABLE || !/^notifications_class_backup_[0-9]+$/.test(BACKUP_TABLE)) throw new Error('Give --backup-table=notifications_class_backup_<digits>.');
      const n = await prisma.$executeRawUnsafe(
        `UPDATE notifications n SET "notificationClass" = b."notificationClass", "read" = b."read" FROM ${BACKUP_TABLE} b WHERE n.id = b.id`);
      console.log(`Rolled back ${n} rows from ${BACKUP_TABLE}. The backup table is kept.`);
      return;
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT type, COUNT(*)::int AS rows, SUM(CASE WHEN "read" THEN 0 ELSE 1 END)::int AS unread, MIN("createdAt") AS first, MAX("createdAt") AS last
         FROM notifications WHERE "notificationClass" IS NULL AND "createdAt" <= $1::timestamptz GROUP BY type ORDER BY 2 DESC`, CUTOFF);
    const total = rows.reduce((a, r) => a + num(r.rows), 0);
    const unread = rows.reduce((a, r) => a + num(r.unread), 0);
    const plan = rows.map((r) => ({ type: r.type, class: classFor(r.type), mapped: Boolean(classOfType[r.type]), rows: num(r.rows), unread: num(r.unread), first: r.first, last: r.last }));
    const byClass = {};
    for (const p of plan) byClass[p.class] = (byClass[p.class] || 0) + p.rows;
    const alreadyClassed = num((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM notifications WHERE "notificationClass" IS NOT NULL`))[0].c);

    console.log(`\nRows to classify: ${total}  (unread among them: ${unread})   Already classified, left alone: ${alreadyClassed}`);
    console.log('Rows by resulting class:', byClass);
    if (MARK_READ) console.log(`Rows that would be marked read: ${unread}`);
    console.table(plan.map((p) => ({ type: p.type, class: p.class, 'in table': p.mapped ? 'yes' : 'no (ACTIVITY)', rows: p.rows, unread: p.unread })));

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const reportFile = path.join(process.cwd(), `notification-backfill-report-${stamp}.json`);
    const sample = await prisma.$queryRawUnsafe(
      `SELECT id, type, "createdAt", "read" FROM notifications WHERE "notificationClass" IS NULL AND "createdAt" <= $1::timestamptz ORDER BY "createdAt" DESC LIMIT 25`, CUTOFF);
    fs.writeFileSync(reportFile, JSON.stringify({ database: host, mode: APPLY ? 'apply' : 'dry-run', cutoff: CUTOFF, markRead: MARK_READ, total, unread, byClass, plan, newestRowsSample: sample }, null, 2));
    console.log(`Report saved: ${reportFile}`);

    if (!APPLY) { console.log('\nDry run only. Nothing was changed.'); return; }
    if (total === 0) { console.log('\nNothing to do: every row already has a class.'); return; }

    const backup = `notifications_class_backup_${stamp}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TABLE ${backup} AS SELECT id, "notificationClass", "read", "archived", NOW() AS backed_up_at FROM notifications WHERE "notificationClass" IS NULL AND "createdAt" <= '${CUTOFF.replace(/'/g, '')}'::timestamptz`);
      let changed = 0;
      for (const cls of ['ACTIVITY', 'NOTIFICATION', 'ALERT']) {
        const types = plan.filter((p) => p.class === cls && p.mapped).map((p) => p.type);
        const unmapped = cls === 'ACTIVITY' ? plan.filter((p) => !p.mapped).map((p) => p.type) : [];
        const all = [...types, ...unmapped];
        if (!all.length) continue;
        changed += await tx.$executeRawUnsafe(
          `UPDATE notifications SET "notificationClass" = $1${MARK_READ ? ', "read" = true' : ''}
             WHERE "notificationClass" IS NULL AND "createdAt" <= $2::timestamptz AND type = ANY($3::text[])`, cls, CUTOFF, all);
      }
      console.log(`\nClassified ${changed} rows. Backup table: ${backup}`);
      console.log(`To undo:  DATABASE_URL=... BACKFILL_CONFIRM_DB_HOST=${host} node scripts/backfill-notification-class.cjs --rollback --backup-table=${backup}`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { classFor };

if (require.main === module) {
  main().catch((err) => { console.error('[backfill-notification-class] stopped:', err.message); process.exit(1); });
}
