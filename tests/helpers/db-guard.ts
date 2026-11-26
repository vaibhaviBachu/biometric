/**
 * Keeps automated tests away from the production database (and storage).
 *
 * Why: the project's `.env` points at production, and `src/config` loads it into every test run. Most suites mock the database, but
 * some (the unified investigation tests, for one) run real code with the real Prisma client, which then reads and writes
 * production. This module runs first (tests/jest.env.setup.ts) and decides which database a test run may use:
 *
 *   - TEST_DATABASE_URL not set  -> an unreachable address. Mocked unit tests are unaffected. Anything that needs a database fails
 *                                   at once, and `describeWithTestDatabase` suites are skipped.
 *   - TEST_DATABASE_URL set and safe -> that database, for the suites that need one.
 *   - TEST_DATABASE_URL set but unsafe -> the unreachable address again (fail safe), with a message saying why.
 *
 * "Safe" means all of: a postgres URL; a local host (localhost, 127.0.0.1, ::1, host.docker.internal) unless
 * ALLOW_REMOTE_TEST_DATABASE=1; and never the same server and database as, nor the same Supabase project as, any production URL
 * (DATABASE_URL / DIRECT_URL in the environment, in the root `.env`, or PRODUCTION_DATABASE_URL). A remote host whose production
 * URLs cannot be found is refused, because it cannot be compared.
 *
 * The production Supabase storage keys are also blanked, so no test can reach production storage by accident.
 * Nothing here reads a secret into a log, and nothing here changes a real environment variable of the machine or of Render.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export type TestDbMode = 'guard' | 'test-db';

export interface TestDbDecision {
  mode: TestDbMode;
  databaseUrl: string;
  reason: string;
  /** True when TEST_DATABASE_URL was given but refused, so the person can be told. */
  rejected: boolean;
}

/** Nothing listens on port 1, so any real database call fails at once with "can't reach database server". */
export const GUARD_DATABASE_URL = 'postgresql://test-guard:test-guard@127.0.0.1:1/test_guard_unreachable';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export interface ParsedDatabaseUrl {
  protocol: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** The Supabase project id, from the pooler user ("postgres.<ref>") or the direct host ("db.<ref>.supabase.co"). */
  projectRef: string | null;
}

export function parseDatabaseUrl(raw: string | undefined | null): ParsedDatabaseUrl | null {
  const text = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) return null;
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase();
    const user = decodeURIComponent(u.username || '');
    const fromUser = /^[A-Za-z_]+\.([a-z0-9]{12,})$/i.exec(user)?.[1];
    const fromHost = /^db\.([a-z0-9]{12,})\.supabase\.co$/i.exec(host)?.[1];
    return {
      protocol: u.protocol.toLowerCase(),
      host,
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      user,
      projectRef: (fromUser ?? fromHost ?? null)?.toLowerCase() ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether two URLs point at the same database. On Supabase every project of a region shares one pooler host, port and database name
 * ("postgres"); only the project id in the user tells them apart. So when both URLs carry a project id, that decides. Otherwise the
 * server, port and database name must all match.
 */
export function isSameDatabase(a: ParsedDatabaseUrl, b: ParsedDatabaseUrl): boolean {
  if (a.projectRef && b.projectRef) return a.projectRef === b.projectRef;
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

const guard = (reason: string, rejected = false): TestDbDecision => ({ mode: 'guard', databaseUrl: GUARD_DATABASE_URL, reason, rejected });

/** The pure decision. `productionUrls` are every URL that points at the real database. */
export function decideTestDatabase(env: NodeJS.ProcessEnv, productionUrls: string[]): TestDbDecision {
  const raw = (env['TEST_DATABASE_URL'] ?? '').trim();
  if (!raw) return guard('TEST_DATABASE_URL is not set: database tests are skipped and any unmocked database call fails.');

  const test = parseDatabaseUrl(raw);
  if (!test) return guard('TEST_DATABASE_URL is not a valid database URL.', true);
  if (test.protocol !== 'postgresql:' && test.protocol !== 'postgres:') return guard('TEST_DATABASE_URL must be a postgres URL.', true);

  const local = LOCAL_HOSTS.has(test.host);
  if (!local && (env['ALLOW_REMOTE_TEST_DATABASE'] ?? '').trim() !== '1') {
    return guard('TEST_DATABASE_URL points at a remote host. Set ALLOW_REMOTE_TEST_DATABASE=1 to allow a separate, non-production database.', true);
  }

  const production = productionUrls.map(parseDatabaseUrl).filter((p): p is ParsedDatabaseUrl => p !== null);
  if (!local && production.length === 0) {
    return guard('A remote TEST_DATABASE_URL cannot be compared with production because no production URL was found, so it is refused.', true);
  }
  for (const prod of production) {
    if (isSameDatabase(test, prod)) {
      return guard(test.projectRef && prod.projectRef
        ? 'TEST_DATABASE_URL belongs to the same Supabase project as production.'
        : 'TEST_DATABASE_URL is the same server and database as the production DATABASE_URL.', true);
    }
  }
  return { mode: 'test-db', databaseUrl: raw, reason: 'TEST_DATABASE_URL accepted.', rejected: false };
}

/** Every URL that should be treated as production: the environment, the root `.env` (read, never printed) and PRODUCTION_DATABASE_URL. */
export function productionDatabaseUrls(env: NodeJS.ProcessEnv, rootDir: string): string[] {
  const urls: string[] = [];
  for (const key of ['DATABASE_URL', 'DIRECT_URL', 'PRODUCTION_DATABASE_URL']) if (env[key]) urls.push(String(env[key]));
  try {
    const file = path.resolve(rootDir, '.env');
    if (fs.existsSync(file)) {
      const parsed = dotenv.parse(fs.readFileSync(file));
      for (const key of ['DATABASE_URL', 'DIRECT_URL']) if (parsed[key]) urls.push(parsed[key]);
    }
  } catch {
    /* an unreadable .env only means there is less to compare with */
  }
  return urls.filter((u) => u && u !== GUARD_DATABASE_URL);
}

/** Production storage credentials: blanked for tests, so nothing can upload to or delete from the real bucket. */
const STORAGE_SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY'];

export function applyTestDatabaseEnv(env: NodeJS.ProcessEnv = process.env, rootDir: string = path.resolve(__dirname, '..', '..')): TestDbDecision {
  const decision = decideTestDatabase(env, productionDatabaseUrls(env, rootDir));
  env['DATABASE_URL'] = decision.databaseUrl;
  env['DIRECT_URL'] = decision.databaseUrl;
  env['PINIT_TEST_DB_MODE'] = decision.mode;
  env['PINIT_TEST_DB_REASON'] = decision.reason;
  // Set (even empty) so that dotenv, which never overrides an existing variable, cannot bring the real ones back from `.env`.
  for (const key of STORAGE_SECRETS) env[key] = '';
  if (decision.rejected) console.error(`[test-db-guard] ${decision.reason} Using the unreachable guard database instead.`);
  return decision;
}

export const hasTestDatabase = (env: NodeJS.ProcessEnv = process.env): boolean => env['PINIT_TEST_DB_MODE'] === 'test-db';

/**
 * `describe` for suites that need a real database: skipped (not failed, not run against production) unless a safe TEST_DATABASE_URL is set.
 * Looked up when called, because this file is also loaded by the Jest setup file, before the test globals exist.
 */
export const describeWithTestDatabase = ((name: string, fn: () => void): void => {
  const g = globalThis as unknown as { describe: { (n: string, f: () => void): void; skip: (n: string, f: () => void) => void } };
  if (hasTestDatabase()) g.describe(name, fn);
  else g.describe.skip(name, fn);
}) as (name: string, fn: () => void) => void;
