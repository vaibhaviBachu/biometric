/**
 * Exercises scripts/recovery/verify-backup-integrity.cjs as a real
 * subprocess against real fixture files — not a mock of the happy path.
 * Needs `pg_restore` on PATH; skips (not fails) if it genuinely isn't
 * available, since this is an environment capability, not a code defect.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'recovery', 'verify-backup-integrity.cjs');

function pgRestoreAvailable(): boolean {
  try {
    execFileSync('pg_restore', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('verify-backup-integrity.cjs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-backup-integrity-'));

  test('fails with a clear message when the file does not exist', () => {
    const result = runScript([path.join(tmpDir, 'does-not-exist.dump')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/file not found/);
  });

  test('fails on a zero-byte file', () => {
    const file = path.join(tmpDir, 'empty.dump');
    fs.writeFileSync(file, Buffer.alloc(0));
    const result = runScript([file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/zero bytes/);
  });

  test('fails on a non-archive file (plain text, not a pg_dump custom-format archive)', () => {
    const file = path.join(tmpDir, 'not-a-dump.dump');
    fs.writeFileSync(file, 'this is definitely not a postgres custom-format archive\n');
    const result = runScript([file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid\/readable/);
  });

  (pgRestoreAvailable() ? test : test.skip)(
    'succeeds on a real pg_dump custom-format archive and reports a non-zero TOC entry count',
    () => {
      // Build a tiny, genuinely real custom-format dump of a throwaway local
      // table — no production/dev data involved, created and dropped purely
      // for this test.
      const dumpFile = path.join(tmpDir, 'real.dump');
      execFileSync('bash', ['-c', [
        'set -e',
        'export PGPASSWORD=pinit',
        'psql -h localhost -p 5435 -U pinit -d pinit_hub -c "CREATE TABLE IF NOT EXISTS _phase9_integrity_test_fixture (id int)" >/dev/null',
        `pg_dump -h localhost -p 5435 -U pinit -d pinit_hub -Fc -t _phase9_integrity_test_fixture -f "${dumpFile}"`,
        'psql -h localhost -p 5435 -U pinit -d pinit_hub -c "DROP TABLE _phase9_integrity_test_fixture" >/dev/null',
      ].join(' && ')], { stdio: 'pipe' });

      const manifestOut = path.join(tmpDir, 'manifest.json');
      const result = runScript([dumpFile, `--manifest-out=${manifestOut}`]);
      expect(result.status).toBe(0);

      const manifest = JSON.parse(fs.readFileSync(manifestOut, 'utf8'));
      expect(manifest.result).toBe('VALID_ARCHIVE_STRUCTURE');
      expect(manifest.tocEntryCount).toBeGreaterThan(0);
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.sizeBytes).toBeGreaterThan(0);
    },
  );
});
