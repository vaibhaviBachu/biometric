/**
 * Local rehearsal of the RLS lockdown on an in-memory PostgreSQL (PGlite). It NEVER connects to Supabase.
 *
 * It rebuilds the production BEFORE state from a snapshot (scripts/audit-rls-readonly.cjs): the same tables in public, exchange and
 * landing, the same RLS flags, the four exchange policies, the roles anon / authenticated / service_role / dev_app and the
 * default privileges Supabase gives new tables. Then it proves, as those roles, that
 *   - before the lockdown an anonymous caller can read and change the open tables (the problem is reproduced),
 *   - 01 closes the sensitive tables only; 02 closes everything; 03 protects tables created later; 04 verifies,
 *   - the owner role and service_role still work, the exchange policies survive, a second run changes nothing,
 *   - the per-table rollback restores exactly the before state of a table.
 *
 *   npm install --no-save @electric-sql/pglite        (or point PGLITE_DIR at a folder whose node_modules has it)
 *   node supabase/rls-lockdown/tests/run-local.cjs <snapshot.json>
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..', '..');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const { QUERIES } = require(path.join(root, 'scripts', 'lib', 'rls-audit-queries.cjs'));
const { buildEnsureRlsSql, COUNT_UNSAFE_SQL } = require(path.join(root, 'scripts', 'lib', 'rls-guard.cjs'));

const snapshotFile = process.argv[2];
if (!snapshotFile) { console.error('usage: run-local.cjs <snapshot.json>'); process.exit(2); }
const prod = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));

let pass = 0;
const failures = [];
const ok = (cond, label) => { if (cond) pass += 1; else { failures.push(label); console.log('  FAIL', label); } };
const q = (n) => `"${String(n).replace(/"/g, '""')}"`;

(async () => {
  const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths: [process.env.PGLITE_DIR || process.cwd()] }));
  const db = new PGlite();
  const run = async (sql) => db.exec(sql);
  const rows = async (sql) => (await db.query(sql)).rows;
  const as = async (role, fn) => { await run(`set role ${role}`); try { return await fn(); } finally { await run('reset role'); } };
  const denied = async (role, sql) => as(role, async () => { try { await db.query(sql); return false; } catch (e) { return /permission denied|row-level security|must be owner/i.test(String(e.message)); } });
  const count = async (role, sql) => as(role, async () => { try { return Number((await db.query(sql)).rows[0].n); } catch { return 'denied'; } });

  // ── 1. Rebuild the production before state ────────────────────────────────────────────────────────────────────────
  await run(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role authenticator login noinherit; create role dev_app login;
    create schema exchange; create schema landing;
    grant usage on schema public to anon, authenticated, service_role, dev_app;
    -- what Supabase gives every new table / sequence / function (MAINTAIN is PostgreSQL 17 only)
    alter default privileges for role postgres in schema public grant select, insert, update, references, trigger on tables to anon, authenticated;
    alter default privileges for role postgres in schema public grant select, insert, update on tables to dev_app;
    alter default privileges for role postgres in schema public grant all on tables to service_role;
    alter default privileges for role postgres in schema public grant usage, select, update on sequences to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const extraCols = {
    'exchange.listings': ['asset_id', 'listing_id', 'status'], 'exchange.hub_assets': ['asset_id'],
    'exchange.reviews': ['listing_id'], 'exchange.requirements': ['status'],
  };
  const sensitive = {};
  for (const c of prod.sensitiveColumnNames) (sensitive[`${c.schema}.${c.table}`] = sensitive[`${c.schema}.${c.table}`] || new Set()).add(c.column_name);
  const tables = prod.relations.filter((r) => r.kind === 'table');
  for (const r of tables) {
    const key = `${r.schema}.${r.name}`;
    const cols = new Set(['createdAt', 'updatedAt', ...(sensitive[key] || []), ...(extraCols[key] || [])]);
    cols.delete('id');
    await run(`create table ${q(r.schema)}.${q(r.name)} (id text primary key default md5(random()::text), ${[...cols].map((c) => `${q(c)} ${/At$/.test(c) ? 'timestamptz default now()' : 'text'}`).join(', ')})`);
    if (r.rls_enabled) await run(`alter table ${q(r.schema)}.${q(r.name)} enable row level security`);
  }
  for (const p of prod.policies) {
    await run(`create policy ${q(p.policyname)} on ${q(p.schema)}.${q(p.table)} for select to public using (${p.qual})`);
  }
  await run(`create sequence public.zz_seq; create function public.zz_fn() returns int language sql as 'select 1';`);
  await run(`insert into public.credentials (id) values ('c1'), ('c2'); insert into public.plans (id) values ('p1');
             insert into public.users (id) values ('u1'); insert into exchange.listings (id, listing_id, asset_id, status) values ('l1','l1','a1','published');
             insert into landing."User" (id) values ('lu1');`);
  console.log(`rebuilt before state: ${tables.length} tables (${tables.filter((t) => !t.rls_enabled).length} with RLS off)`);

  const capture = async () => {
    const out = {};
    for (const [name, sql] of Object.entries(QUERIES)) { try { out[name] = (await db.query(sql)).rows; } catch { out[name] = []; } }
    return JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  };
  const norm = (s) => ({
    rls: s.relations.filter((r) => r.kind === 'table').map((r) => `${r.schema}.${r.name}=${r.rls_enabled}`).sort(),
    grants: s.grants.filter((g) => g.grantee !== 'PUBLIC').map((g) => `${g.schema}.${g.name}|${g.grantee}|${g.privileges}`).sort(),
    seq: s.sequenceGrants.map((g) => `${g.schema}.${g.name}|${g.grantee}|${g.privileges}`).sort(),
    defaults: s.defaultPrivileges.filter((d) => d.role === 'postgres').map((d) => `${d.schema}|${d.object_type}|${d.acl}`).sort(),
    policies: s.policies.map((p) => `${p.schema}.${p.table}.${p.policyname}`).sort(),
  });
  const before = await capture();

  // ── 2. The problem, reproduced ────────────────────────────────────────────────────────────────────────────────────
  ok(await count('anon', 'select count(*) n from public.credentials') === 2, 'before: anon can read credentials (RLS off, grants open)');
  ok(await count('anon', 'select count(*) n from public.users') === 0, 'before: RLS-on users shows anon zero rows');
  ok(!(await denied('anon', "update public.credentials set id = id")), 'before: anon can UPDATE credentials');
  ok(await count('dev_app', 'select count(*) n from public.credentials') === 2, 'before: dev_app can read credentials');
  ok(await count('anon', 'select count(*) n from exchange.listings') === 'denied', 'before: exchange tables carry no anon grants');
  ok((await db.query(COUNT_UNSAFE_SQL)).rows[0].open_to_api_roles > 70, 'before: more than 70 tables open to API roles');

  // ── 3. Preflight and verify behave ────────────────────────────────────────────────────────────────────────────────
  try { await run(SQL('00-preflight.sql')); ok(true, 'preflight passes as the owner'); } catch (e) { ok(false, `preflight failed as owner: ${e.message}`); }
  const preflightDo = SQL('00-preflight.sql').match(/do \$\$[\s\S]*?end \$\$;/)[0];
  ok(await as('dev_app', async () => { try { await db.exec(preflightDo); return false; } catch (e) { return /Run this as the owner role/.test(String(e.message)); } }), 'preflight refuses a role that cannot bypass RLS');
  let verifyFailedBefore = false;
  try { await run(SQL('04-verify.sql').split('-- Informational')[0]); } catch { verifyFailedBefore = true; }
  ok(verifyFailedBefore, 'verify FAILS on the unprotected state');

  // ── 4. 01 contains the sensitive tables only ─────────────────────────────────────────────────────────────────────
  await run(SQL('01-contain-sensitive.sql'));
  for (const t of ['credentials', 'extension_auth_codes', 'government_id_records', 'identity_document_fingerprints', 'identity_verification_runs', 'organization_api_keys', 'organization_invites', 'organization_webhooks', 'webauthn_credentials']) {
    ok(await denied('anon', `select 1 from public.${t} limit 1`), `01: anon denied on ${t}`);
    ok(await denied('authenticated', `select 1 from public.${t} limit 1`), `01: authenticated denied on ${t}`);
    ok(await denied('dev_app', `select 1 from public.${t} limit 1`), `01: dev_app denied on ${t}`);
  }
  ok(!(await denied('anon', 'select 1 from public.plans limit 1')), '01 is selective: a table outside its list is still open until 02');
  ok((await rows(`select relrowsecurity r from pg_class where oid = 'landing."User"'::regclass`))[0].r === true, '01: RLS enabled on landing."User"');

  // ── 5. 02 + 03 close everything; the owner and service_role keep working ─────────────────────────────────────────
  await run(SQL('02-enable-rls-and-revoke.sql'));
  await run(SQL('03-new-table-defaults.sql'));
  try { await run(SQL('04-verify.sql')); ok(true, 'verify passes after 01-03'); } catch (e) { ok(false, `verify failed after lockdown: ${e.message}`); }
  const afterTables = (await rows(`select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','exchange','landing') and c.relkind in ('r','p')`));
  let closed = 0;
  for (const { s, t } of afterTables) {
    const id = `${q(s)}.${q(t)}`;
    const r = await Promise.all(['anon', 'authenticated', 'dev_app'].map(async (role) => (await denied(role, `select 1 from ${id} limit 1`)) && (await denied(role, `update ${id} set id = id`)) && (await denied(role, `insert into ${id} (id) values ('x')`))));
    if (r.every(Boolean)) closed += 1; else ok(false, `still reachable by an API role: ${s}.${t}`);
  }
  ok(closed === afterTables.length, `every one of ${afterTables.length} tables is closed to anon, authenticated and dev_app (select, insert, update)`);
  ok(await count('postgres', 'select count(*) n from public.credentials') === 2, 'owner (postgres) still reads credentials');
  await run(`insert into public.credentials (id) values ('c3')`); ok(await count('postgres', 'select count(*) n from public.credentials') === 3, 'owner can still write');
  ok(await count('service_role', 'select count(*) n from public.credentials') === 3, 'service_role (bypasses RLS) still reads credentials');
  ok(await count('service_role', 'select count(*) n from public.users') === 1, 'service_role still reads users');
  ok((await rows(`select count(*)::int n from pg_policies where schemaname = 'exchange'`))[0].n === 4, 'the 4 exchange public-read policies are untouched');
  ok(await denied('anon', 'select nextval(\'public.zz_seq\')'), 'anon cannot use sequences');
  const cnt = (await db.query(COUNT_UNSAFE_SQL)).rows[0];
  ok(cnt.rls_off === 0 && cnt.open_to_api_roles === 0, 'guard counters report 0 unsafe tables');

  // ── 6. Idempotent ─────────────────────────────────────────────────────────────────────────────────────────────────
  const after1 = norm(await capture());
  await run(SQL('01-contain-sensitive.sql')); await run(SQL('02-enable-rls-and-revoke.sql')); await run(SQL('03-new-table-defaults.sql')); await run(SQL('04-verify.sql'));
  ok(JSON.stringify(after1) === JSON.stringify(norm(await capture())), 'a second run of 01-04 changes nothing');

  // ── 7. New tables ─────────────────────────────────────────────────────────────────────────────────────────────────
  await run(`create table public.zz_new (id text primary key); create table exchange.zz_new_ex (id text primary key);`);
  ok(await denied('anon', 'select 1 from public.zz_new limit 1'), '03: a new public table is not readable by anon even before the guard runs');
  ok(await denied('dev_app', 'select 1 from public.zz_new limit 1'), '03: nor by dev_app');
  ok((await rows(`select relrowsecurity r from pg_class where oid = 'public.zz_new'::regclass`))[0].r === false, 'a new table starts with RLS off (Postgres has no default)');
  await run(buildEnsureRlsSql());
  ok((await rows(`select relrowsecurity r from pg_class where oid = 'public.zz_new'::regclass`))[0].r === true, 'ensure-rls guard enables RLS on the new public table');
  ok((await rows(`select relrowsecurity r from pg_class where oid = 'exchange.zz_new_ex'::regclass`))[0].r === true, '... and on the new exchange table');
  await run('grant select on public.zz_new to anon');
  await run(buildEnsureRlsSql());
  ok(await denied('anon', 'select 1 from public.zz_new limit 1'), 'the guard removes a privilege someone granted by mistake');
  await run('grant select on public.zz_new to anon; create table public.zz_pub (id text); grant select on public.zz_pub to anon;');
  await run(buildEnsureRlsSql({ publicRead: ['public.zz_pub'] }));
  ok(!(await denied('anon', 'select 1 from public.zz_pub limit 1')) && (await db.query(`select relrowsecurity r from pg_class where oid = 'public.zz_pub'::regclass`)).rows[0].r === true, 'allow-list: a table kept readable keeps its grant but still gets RLS (so it needs its own policy)');
  ok(fs.readFileSync(path.join(__dirname, '..', '02-enable-rls-and-revoke.sql'), 'utf8').includes(buildEnsureRlsSql({ verbose: true })), '02 file equals the guard code (no drift)');

  // ── 8. Optional dev_app read-only share ───────────────────────────────────────────────────────────────────────────
  await run(SQL('optional/dev-app-readonly.sql'));
  ok(await count('dev_app', 'select count(*) n from public.plans') === 1, 'optional: dev_app can read plans');
  ok(await denied('dev_app', `insert into public.plans (id) values ('zz')`), 'optional: dev_app cannot write plans');
  ok(await denied('dev_app', 'select 1 from public.credentials limit 1'), 'optional: dev_app still cannot read credentials');
  ok(await denied('dev_app', 'select 1 from public.users limit 1'), 'optional: dev_app still cannot read users');
  await run(buildEnsureRlsSql({ devAppKeep: ['public.plans', 'public._prisma_migrations'] }));
  ok(await count('dev_app', 'select count(*) n from public.plans') === 1, 'optional: the guard with dev-app keep list leaves the read-only share alone');
  await run(buildEnsureRlsSql());
  ok(await count('dev_app', 'select count(*) n from public.plans') === 'denied', 'without the keep list the guard removes it again (so the deploy env var is required)');

  // ── 9. Exposure audit script runs ────────────────────────────────────────────────────────────────────────────────
  try { await run(SQL('05-exposure-audit-readonly.sql')); ok(true, '05 audit file runs'); } catch (e) { ok(false, `05 audit failed: ${e.message}`); }

  // ── 10. Per-table rollback restores exactly the before state ─────────────────────────────────────────────────────
  const tmp = path.join(require('os').tmpdir(), `rls-before-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(before));
  const gen = (...args) => { const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'rls-generate-rollback.cjs'), tmp, '--pg16', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  for (const t of ['public.credentials', 'public.users', 'exchange.listings']) {
    await run(gen('--table', t));
    const b = norm(before);
    const a = norm(await capture());
    const pick = (n) => ({ rls: n.rls.filter((x) => x.startsWith(`${t}=`)), grants: n.grants.filter((x) => x.startsWith(`${t}|`)) });
    ok(JSON.stringify(pick(a)) === JSON.stringify(pick(b)), `rollback restores ${t} to its exact before state (RLS flag and grants)`);
  }
  await run(buildEnsureRlsSql()); // re-lock the three tables again
  const reference = gen('--reference');
  ok(reference.split('\n').filter((l) => l.trim() && !l.startsWith('--')).length === 0, '--reference output is entirely commented out (no blanket rollback)');
  await run(gen('--defaults'));
  ok((await rows(`select count(*)::int n from pg_default_acl d where pg_get_userbyid(d.defaclrole) = 'postgres' and d.defaclnamespace::regnamespace::text = 'public' and d.defaclacl::text ~ 'anon='`))[0].n >= 1, 'rollback --defaults restores the default privileges');
  ok(await count('postgres', 'select count(*) n from public.credentials') >= 2, 'no data was deleted by any step');

  console.log(`\n${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(' -', f)); process.exit(1); }
})().catch((e) => { console.error('test error:', e); process.exit(1); });
