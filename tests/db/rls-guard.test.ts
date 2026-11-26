/**
 * The Supabase lockdown (supabase/rls-lockdown) and the deploy-time guard that keeps new tables from being created open.
 * These checks need no database; the behavioural rehearsal on a real Postgres is supabase/rls-lockdown/tests/run-local.cjs.
 */
import fs from 'fs';
import path from 'path';
import { describe, test, expect } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildEnsureRlsSql, SCHEMAS, API_ROLES } = require('../../scripts/lib/rls-guard.cjs');

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('buildEnsureRlsSql', () => {
  test('covers every PINIT schema and the three API-facing roles, and creates no policy', () => {
    const sql = buildEnsureRlsSql();
    for (const s of ['public', 'exchange', 'landing']) expect(sql).toContain(`'${s}'`);
    expect(SCHEMAS).toEqual(['public', 'exchange', 'landing']);
    expect(API_ROLES).toEqual(['anon', 'authenticated', 'dev_app']);
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all on table');
    expect(sql).not.toMatch(/create policy/i);
  });

  test('never touches the roles the backend relies on', () => {
    const sql = buildEnsureRlsSql();
    expect(sql).not.toMatch(/service_role|\bpostgres\b/);
    expect(sql).not.toMatch(/disable row level security|force row level security/i);
  });

  test('allow lists are quoted safely', () => {
    const sql = buildEnsureRlsSql({ publicRead: ["public.x'; drop table users; --"], devAppKeep: ['public.plans'] });
    expect(sql).toContain("'public.x''; drop table users; --'");
    expect(sql).toContain("array['public.plans']");
  });

  test('is the code in 02-enable-rls-and-revoke.sql (no drift between the file and the deploy guard)', () => {
    expect(read('supabase/rls-lockdown/02-enable-rls-and-revoke.sql')).toContain(buildEnsureRlsSql({ verbose: true }));
  });
});

describe('the lockdown files are safe to hand over', () => {
  const files = ['00-preflight.sql', '01-contain-sensitive.sql', '02-enable-rls-and-revoke.sql', '03-new-table-defaults.sql', '04-verify.sql', '05-exposure-audit-readonly.sql', 'optional/dev-app-readonly.sql'];

  test.each(files)('%s deletes nothing and never disables RLS', (f) => {
    const sql = read(`supabase/rls-lockdown/${f}`).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    // a privilege NAME inside a string (has_table_privilege(..., 'TRUNCATE')) is fine; a TRUNCATE statement is not
    expect(sql).not.toMatch(/\b(drop table|delete from|drop schema|drop column)\b|\btruncate\s+(table\s+)?["a-z_]/i);
    expect(sql).not.toMatch(/disable row level security/i);
    expect(sql).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  test('the sensitive tables the owner named are all contained by 01', () => {
    const sql = read('supabase/rls-lockdown/01-contain-sensitive.sql');
    for (const t of ['credentials', 'extension_auth_codes', 'government_id_records', 'identity_document_fingerprints', 'identity_verification_runs', 'organization_api_keys', 'organization_invites', 'organization_webhooks', 'webauthn_credentials']) {
      expect(sql).toContain(`'public.${t}'`);
    }
    expect(sql).toContain('landing."User"');
  });

  test('the optional dev_app file grants SELECT only and only on two non-sensitive tables', () => {
    const sql = read('supabase/rls-lockdown/optional/dev-app-readonly.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).toContain("array['plans', '_prisma_migrations']");
    expect(sql).toMatch(/grant select on table/);
    expect(sql).not.toMatch(/grant (all|insert|update|delete)/i);
  });
});

describe('deploy wiring', () => {
  test('ensure-rls runs last in db:ensure-all and is available on its own', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['db:ensure-all']).toMatch(/node scripts\/ensure-large-file-tables\.cjs && node scripts\/ensure-rls\.cjs$/);
    expect(pkg.scripts['db:ensure-rls']).toBe('node scripts/ensure-rls.cjs');
  });

  test('the guard only warns on failure unless RLS_ENFORCE=1 (like the other ensure scripts)', () => {
    const src = read('scripts/ensure-rls.cjs');
    expect(src).toContain("process.env.RLS_ENFORCE === '1'");
    expect(src).toContain('WARNING');
  });
});
