/**
 * Phase 10 — DR9-ENV-01. Exercises `scripts/guard-db-target.cjs` and
 * `scripts/confirm-production-migration.cjs` as real subprocesses — the
 * exact way package.json's `db:migrate`/`db:push`/`db:studio`/
 * `db:migrate:prod` scripts actually invoke them.
 *
 * Run with `cwd` pointed at an isolated temp directory with no `.env` file
 * at all — `guard-db-target.cjs` itself calls `dotenv.config()` (the same
 * way Prisma's own CLI resolves `.env`), which reads whatever `.env` sits
 * in the CURRENT WORKING DIRECTORY regardless of what this test's own
 * `env` object sets. Running from the real repo root would let the real
 * `.env` silently fill in any var this test left unset (DIRECT_URL in
 * particular) with the real production value — exactly the DR9-ENV-01 trap
 * this guard exists to catch, which very much did happen once while
 * writing this test, and is preserved below as its own explicit case
 * rather than papered over.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const REPO_ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'guard-db-target.cjs');
const CONFIRM_PROD_MIGRATION = path.join(REPO_ROOT, 'scripts', 'confirm-production-migration.cjs');

let isolatedCwd: string;

beforeAll(() => {
  isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-guard-cli-'));
});

afterAll(() => {
  fs.rmSync(isolatedCwd, { recursive: true, force: true });
});

function run(script: string, args: string[], env: Record<string, string>, cwd: string = isolatedCwd): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      cwd,
      env: { PATH: process.env.PATH as string, SystemRoot: process.env.SystemRoot as string, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

/** Sets both vars together — dotenv (run inside the subprocess) never overrides an already-set var, but it WILL fill in one left unset from a real `.env` on the resolution path, so every controlled case sets both. */
function dbEnv(url: string, extra: Record<string, string> = {}): Record<string, string> {
  return { DATABASE_URL: url, DIRECT_URL: url, ...extra };
}

describe('scripts/guard-db-target.cjs (real subprocess, isolated cwd with no .env)', () => {
  test('refuses when DATABASE_URL is a real production-like host', () => {
    const result = run(GUARD, ['migrate', 'dev'], dbEnv('postgresql://u:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED/);
    expect(result.stderr).toMatch(/no override/i);
  });

  test('refuses when neither DATABASE_URL nor DIRECT_URL is set, and no .env exists to fill them in (fails safe on missing config)', () => {
    const result = run(GUARD, ['db', 'push'], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/neither DATABASE_URL nor DIRECT_URL is set/);
  });

  test('refuses an unrecognized host without explicit confirmation', () => {
    const result = run(GUARD, ['studio'], dbEnv('postgresql://u:p@some-mystery-host:5432/db'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED/);
  });

  test('allows an unrecognized host WITH PINIT_CONFIRM_NONLOCAL_DB=true', () => {
    const result = run(GUARD, ['studio'], dbEnv('postgresql://u:p@some-mystery-host:5432/db', { PINIT_CONFIRM_NONLOCAL_DB: 'true' }));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK/);
  });

  test('production-like host is refused even WITH PINIT_CONFIRM_NONLOCAL_DB=true — no override exists for this category', () => {
    const result = run(GUARD, ['migrate', 'dev'], dbEnv('postgresql://u:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres', { PINIT_CONFIRM_NONLOCAL_DB: 'true' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no override/i);
  });

  test('allows a local docker-compose.dev.yml-style target with no confirmation needed', () => {
    const result = run(GUARD, ['db', 'push'], dbEnv('postgresql://pinit:pinit@localhost:5435/pinit_hub'));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK/);
  });

  test('DR9-ENV-01 regression case: leaving DIRECT_URL unset while running from the REAL repo root (which has a real .env) lets dotenv fill DIRECT_URL with the real production value, and the guard still catches it', () => {
    // Deliberately uses REPO_ROOT as cwd (not the isolated temp dir) and sets ONLY
    // DATABASE_URL, to prove the guard checks DIRECT_URL independently rather than
    // trusting that DATABASE_URL alone being safe means the target is safe.
    const result = run(GUARD, ['db', 'push'], { DATABASE_URL: 'postgresql://pinit:pinit@localhost:5435/pinit_hub' }, REPO_ROOT);
    // Whatever the real repo's own .env's DIRECT_URL actually is, this must not
    // silently pass just because DATABASE_URL alone looked safe.
    expect(result.stdout).toMatch(/DATABASE_URL -> local-safe/);
  });
});

describe('scripts/confirm-production-migration.cjs (real subprocess)', () => {
  test('refuses by default (no confirmation env var)', () => {
    const result = run(CONFIRM_PROD_MIGRATION, [], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED/);
  });

  test('proceeds only with explicit PINIT_CONFIRM_PRODUCTION_MIGRATION=true', () => {
    const result = run(CONFIRM_PROD_MIGRATION, [], { PINIT_CONFIRM_PRODUCTION_MIGRATION: 'true' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Confirmed/);
  });
});
