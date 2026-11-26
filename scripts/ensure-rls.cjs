/**
 * Security guard for new tables: enables Row Level Security and removes the Supabase API roles' privileges on every table in
 * the public, exchange and landing schemas. See scripts/lib/rls-guard.cjs and supabase/rls-lockdown/README.md.
 *
 * ADDITIVE-SAFE AND IDEMPOTENT. Safe on every deploy (it runs last in db:ensure-all, after the other scripts created their tables).
 * Like the other ensure scripts it only warns on failure, so a database hiccup cannot block a deploy; set RLS_ENFORCE=1 to
 * make leftover unprotected tables fail the step instead.
 *
 * Optional environment (comma-separated "schema.table"):
 *   RLS_PUBLIC_READ_TABLES   tables the API roles may keep reading (each needs its own reviewed policy)
 *   RLS_DEV_APP_READ_TABLES  tables whose dev_app privileges are managed separately (see optional/dev-app-readonly.sql)
 */
const { PrismaClient } = require('@prisma/client');
const { buildEnsureRlsSql, COUNT_UNSAFE_SQL } = require('./lib/rls-guard.cjs');

const prisma = new PrismaClient();
const log = (...a) => console.log('[ensure-rls]', ...a);
const list = (name) => (process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);

(async () => {
  let leftover = null;
  try {
    await prisma.$executeRawUnsafe(buildEnsureRlsSql({ publicRead: list('RLS_PUBLIC_READ_TABLES'), devAppKeep: list('RLS_DEV_APP_READ_TABLES') }));
    const [row] = await prisma.$queryRawUnsafe(COUNT_UNSAFE_SQL);
    leftover = Number(row.rls_off) + Number(row.open_to_api_roles);
    if (leftover === 0) log('ok: every table in public / exchange / landing has RLS on and no API-role privileges');
    else log(`WARNING — ${row.rls_off} table(s) without RLS and ${row.open_to_api_roles} table(s) still open to API roles (allow-listed tables count here)`);
  } catch (err) {
    log('WARNING — could not apply the RLS guard:', String(err.message || err).split('\n')[0]);
  } finally {
    await prisma.$disconnect();
  }
  if (process.env.RLS_ENFORCE === '1' && leftover !== 0) process.exit(1);
})();
