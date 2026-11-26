/**
 * Phase 10 — DR9-ENV-01. Proves `scripts/reset-test-user-data.cjs` — a
 * purpose-built mass-TRUNCATE tool with no npm-script wrapper, invoked
 * directly — refuses before ever opening a database connection, for every
 * unsafe case, and that the guard lives inside the script itself (not only
 * in an external wrapper a direct invocation could skip).
 *
 * This script's own `applyEnvFile()` reads `.env` from `path.resolve(
 * __dirname, '..')` — i.e. the script's own install location, NOT
 * `process.cwd()` — so changing the test's cwd has no effect here (unlike
 * `guard-db-target-cli.test.ts`'s target script). It also only fills a key
 * that is NOT already set, for BOTH `<repo-root>/.env` and
 * `<repo-root>/exchange/.env` (both real files in this repo). Every case
 * below therefore sets DATABASE_URL, DIRECT_URL, AND EXCHANGE_DATABASE_URL
 * together whenever it controls a target, so neither real `.env` file gets
 * a chance to fill in an unset var with its real value — the same class of
 * trap `guard-db-target-cli.test.ts` hit once already, deliberately not
 * repeated here.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reset-test-user-data.cjs');

function run(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000,
      env: { PATH: process.env.PATH as string, SystemRoot: process.env.SystemRoot as string, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

/** Sets every URL this script reads together, so neither real .env file can fill in an unset one. */
function dbEnv(url: string, extra: Record<string, string> = {}): Record<string, string> {
  return { DATABASE_URL: url, DIRECT_URL: url, EXCHANGE_DATABASE_URL: url, ...extra };
}

describe('scripts/reset-test-user-data.cjs — DR9-ENV-01 guard', () => {
  test('refuses without CONFIRM_WIPE_TEST_DATA, even for an otherwise-local target', () => {
    const result = run(dbEnv('postgresql://pinit:pinit@localhost:5435/pinit_hub'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED.*CONFIRM_WIPE_TEST_DATA/s);
  });

  test('refuses a production-like target even WITH CONFIRM_WIPE_TEST_DATA=true — no override exists', () => {
    const result = run(dbEnv('postgresql://u:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres', { CONFIRM_WIPE_TEST_DATA: 'true' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED.*Hub DATABASE_URL/s);
  });

  test('refuses an "unknown" (unrecognized) target even WITH CONFIRM_WIPE_TEST_DATA=true — this destructive script requires a RECOGNIZED local target, not merely unverified', () => {
    const result = run(dbEnv('postgresql://u:p@some-shared-staging-host:5432/db', { CONFIRM_WIPE_TEST_DATA: 'true' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires a RECOGNIZED local-safe target/);
  });

  test('refuses when SUPABASE_URL is a real project, even if the DB target is local-safe and confirmed', () => {
    const result = run(dbEnv('postgresql://pinit:pinit@localhost:5435/pinit_hub', {
      CONFIRM_WIPE_TEST_DATA: 'true',
      SUPABASE_URL: 'https://kqdqmimdqecensurjplh.supabase.co',
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/real cloud Storage project/);
  });

  test('a fully local-safe + confirmed target (including a non-empty, recognized-local SUPABASE_URL) passes the guard (fails later only on the actual DB connection, proving it got past the guard, not that it wiped anything)', () => {
    // SUPABASE_URL must be set to SOME non-empty value here: applyEnvFile()
    // fills any falsy/unset var from the real .env, so leaving it empty
    // would let the real production SUPABASE_URL leak in and correctly
    // block this case for the wrong reason (Storage, not DB).
    const result = run(dbEnv('postgresql://pinit:pinit@127.0.0.1:1/definitely_not_a_real_port_nothing_is_listening_here', {
      CONFIRM_WIPE_TEST_DATA: 'true',
      SUPABASE_URL: 'http://localhost:54321',
    }));
    // No refusal from the guard itself — the failure past this point is a
    // real connection error (note: "ECONNREFUSED" itself contains the
    // substring "REFUSED", so this checks the script's own refusal-message
    // prefix specifically, not a bare substring match).
    expect(result.stderr).not.toMatch(/\[reset-test-user-data\] REFUSED/);
    expect(result.stderr).toMatch(/ECONNREFUSED/);
  });
});
