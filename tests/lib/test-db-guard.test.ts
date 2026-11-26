/**
 * F1: automated tests must never reach the production database.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GUARD_DATABASE_URL, applyTestDatabaseEnv, decideTestDatabase, isSameDatabase, parseDatabaseUrl, productionDatabaseUrls,
} from '../helpers/db-guard';

// Shaped like the real Supabase URLs, with made-up ids and passwords.
const PROD_POOLER = 'postgresql://postgres.prodprojectref1:secret-pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
const PROD_DIRECT = 'postgresql://postgres:secret-pass@db.prodprojectref1.supabase.co:5432/postgres';
const OTHER_POOLER = 'postgresql://postgres.otherprojectref2:other-pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
const LOCAL = 'postgresql://pinit:pinit@localhost:5435/pinit_hub_test';
const PRODUCTION = [PROD_POOLER, PROD_DIRECT];

const decide = (env: Record<string, string>, prod: string[] = PRODUCTION) => decideTestDatabase(env as NodeJS.ProcessEnv, prod);

describe('which database a test run may use', () => {
  test('nothing set: the unreachable guard address, not rejected (just not configured)', () => {
    const d = decide({});
    expect(d.mode).toBe('guard');
    expect(d.databaseUrl).toBe(GUARD_DATABASE_URL);
    expect(d.rejected).toBe(false);
  });

  test('a local test database is accepted', () => {
    const d = decide({ TEST_DATABASE_URL: LOCAL });
    expect(d).toMatchObject({ mode: 'test-db', databaseUrl: LOCAL, rejected: false });
  });

  test.each(['not a url', 'mysql://u:p@localhost:3306/x', 'http://localhost:5432/x'])('%s is refused', (url) => {
    const d = decide({ TEST_DATABASE_URL: url });
    expect(d).toMatchObject({ mode: 'guard', databaseUrl: GUARD_DATABASE_URL, rejected: true });
  });

  test('a remote host is refused unless remote test databases are allowed explicitly', () => {
    const d = decide({ TEST_DATABASE_URL: OTHER_POOLER });
    expect(d).toMatchObject({ mode: 'guard', rejected: true });
    expect(d.reason).toMatch(/ALLOW_REMOTE_TEST_DATABASE/);
  });

  test('the production URL itself is refused, in pooler and direct form, even when remote is allowed', () => {
    for (const url of [PROD_POOLER, PROD_DIRECT]) {
      const d = decide({ TEST_DATABASE_URL: url, ALLOW_REMOTE_TEST_DATABASE: '1' });
      expect(d).toMatchObject({ mode: 'guard', databaseUrl: GUARD_DATABASE_URL, rejected: true });
    }
  });

  test('another user or password on the same Supabase project is still production', () => {
    const d = decide({ TEST_DATABASE_URL: 'postgresql://postgres.prodprojectref1:different@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres', ALLOW_REMOTE_TEST_DATABASE: '1' });
    expect(d).toMatchObject({ mode: 'guard', rejected: true });
    expect(d.reason).toMatch(/same Supabase project/);
  });

  test('a different Supabase project on the same pooler host is allowed when remote is allowed', () => {
    const d = decide({ TEST_DATABASE_URL: OTHER_POOLER, ALLOW_REMOTE_TEST_DATABASE: '1' });
    expect(d).toMatchObject({ mode: 'test-db', rejected: false });
  });

  test('a remote database is refused when no production URL is known to compare with', () => {
    const d = decide({ TEST_DATABASE_URL: OTHER_POOLER, ALLOW_REMOTE_TEST_DATABASE: '1' }, []);
    expect(d).toMatchObject({ mode: 'guard', rejected: true });
  });

  test('a local test database that is the same server and database as a local production URL is refused', () => {
    const d = decide({ TEST_DATABASE_URL: 'postgresql://a:b@localhost:5435/pinit_hub' }, ['postgresql://x:y@localhost:5435/pinit_hub']);
    expect(d).toMatchObject({ mode: 'guard', rejected: true });
  });

  test('parsing finds the project id in both URL forms and never needs the password', () => {
    expect(parseDatabaseUrl(PROD_POOLER)?.projectRef).toBe('prodprojectref1');
    expect(parseDatabaseUrl(PROD_DIRECT)?.projectRef).toBe('prodprojectref1');
    expect(parseDatabaseUrl(LOCAL)?.projectRef).toBeNull();
    expect(isSameDatabase(parseDatabaseUrl(PROD_POOLER)!, parseDatabaseUrl(OTHER_POOLER)!)).toBe(false);
  });
});

describe('applying the decision to an environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-guard-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('without a test database: guard address, storage secrets blanked, production URL gone', () => {
    const env = { DATABASE_URL: PROD_POOLER, DIRECT_URL: PROD_DIRECT, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', SUPABASE_ANON_KEY: 'a', SUPABASE_KEY: 'b' } as NodeJS.ProcessEnv;
    const d = applyTestDatabaseEnv(env, root);
    expect(d.mode).toBe('guard');
    expect(env['DATABASE_URL']).toBe(GUARD_DATABASE_URL);
    expect(env['DIRECT_URL']).toBe(GUARD_DATABASE_URL);
    expect(env['PINIT_TEST_DB_MODE']).toBe('guard');
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY']) expect(env[key]).toBe('');
  });

  test('a production URL only in the .env file is found and refused as a test database', () => {
    fs.writeFileSync(path.join(root, '.env'), `DATABASE_URL="${PROD_POOLER}"\n`);
    expect(productionDatabaseUrls({} as NodeJS.ProcessEnv, root)).toContain(PROD_POOLER);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const env = { TEST_DATABASE_URL: PROD_POOLER, ALLOW_REMOTE_TEST_DATABASE: '1' } as NodeJS.ProcessEnv;
    const d = applyTestDatabaseEnv(env, root);
    expect(d).toMatchObject({ mode: 'guard', rejected: true });
    expect(env['DATABASE_URL']).toBe(GUARD_DATABASE_URL);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[test-db-guard]'));
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('secret-pass'); // the message never carries a password
    spy.mockRestore();
  });

  test('a safe local test database is used for DATABASE_URL and DIRECT_URL', () => {
    const env = { TEST_DATABASE_URL: LOCAL } as NodeJS.ProcessEnv;
    const d = applyTestDatabaseEnv(env, root);
    expect(d.mode).toBe('test-db');
    expect(env['DATABASE_URL']).toBe(LOCAL);
    expect(env['DIRECT_URL']).toBe(LOCAL);
  });
});

describe('this Jest run itself', () => {
  test('the setup file has already pointed the database away from production', () => {
    const url = process.env['DATABASE_URL'] ?? '';
    expect(process.env['PINIT_TEST_DB_MODE']).toMatch(/^(guard|test-db)$/);
    const parsed = parseDatabaseUrl(url);
    expect(parsed).not.toBeNull();
    if (process.env['PINIT_TEST_DB_MODE'] === 'guard') expect(url).toBe(GUARD_DATABASE_URL);
    const root = path.resolve(__dirname, '..', '..');
    for (const prodUrl of productionDatabaseUrls({} as NodeJS.ProcessEnv, root)) {
      const prod = parseDatabaseUrl(prodUrl);
      if (prod) expect(isSameDatabase(parsed!, prod)).toBe(false);
    }
  });

  test('production storage keys are blank in the test process', () => {
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY']) expect(process.env[key] ?? '').toBe('');
  });
});
