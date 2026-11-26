/**
 * Runs a reviewed .sql file against the database inside a READ ONLY transaction and prints each result set.
 * Postgres itself rejects any write in that transaction; as a second guard the script refuses a file that contains a
 * write or DDL keyword outside comments and string literals.
 *
 *   node scripts/run-readonly-sql.cjs supabase/rls-lockdown/00-preflight.sql
 *
 * WARNING: it uses whatever DATABASE_URL the environment holds (the developer .env is the production database).
 */
require('dotenv').config();
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const file = process.argv[2];
if (!file) { console.error('usage: run-readonly-sql.cjs <file.sql>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// Split into statements, keeping $$ ... $$ blocks whole and ignoring -- comments.
function split(sql) {
  const out = [];
  let cur = '';
  let inDollar = false;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (!inDollar && !inStr && c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
    if (!inStr && c === '$' && sql[i + 1] === '$') { inDollar = !inDollar; cur += '$$'; i++; continue; }
    if (!inDollar && c === "'") { inStr = !inStr; cur += c; continue; }
    if (c === ';' && !inDollar && !inStr) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const FORBIDDEN = /\b(insert\s+into|update\s+[a-z_".]+\s+set|delete\s+from|alter\s+(table|role|default|schema)|create\s+(table|policy|role|index|function|temp)|drop\s+|grant\s+|revoke\s+|truncate\s+[a-z_"]|vacuum|copy\s)/i;
const stripped = split(text).map((s) => s.replace(/'(?:[^']|'')*'/g, "''"));
if (stripped.some((s) => FORBIDDEN.test(s))) { console.error('refusing: the file contains a write or DDL statement'); process.exit(3); }

(async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      let n = 0;
      for (const stmt of split(text)) {
        n += 1;
        if (/^do\b/i.test(stmt)) {
          try { await tx.$executeRawUnsafe(stmt); console.log(`[${n}] DO block: passed (no exception raised)`); }
          catch (e) { console.log(`[${n}] DO block: RAISED -> ${String(e.message || e).split('\n').slice(-2).join(' ').slice(0, 300)}`); }
          continue;
        }
        const rows = await tx.$queryRawUnsafe(stmt);
        console.log(`[${n}] ${stmt.replace(/\s+/g, ' ').slice(0, 70)}...  (${rows.length} row(s))`);
        console.table(JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))));
      }
    }, { timeout: 120000, maxWait: 30000 });
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('failed:', String(e.message || e).split('\n')[0]); process.exit(1); });
