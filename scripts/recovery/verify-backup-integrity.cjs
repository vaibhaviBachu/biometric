/**
 * PINIT-DNA — Phase 9: read-only backup integrity verification.
 *
 * Wraps `pg_restore --list`, which only reads a custom-format (-Fc) archive's
 * table of contents — it never connects to any database and never writes
 * anything — plus a SHA-256 checksum of the file itself. Produces a manifest
 * that demonstrates the archive is structurally valid and lists what it
 * actually contains, rather than assuming "a backup is usable" from file
 * size or existence alone (the master prompt's own explicit anti-pattern).
 *
 * This does NOT prove the data is current, complete, or restorable without
 * error — only an actual restore drill proves that. See
 * PHASE_9_NON_PRODUCTION_RESTORE_DRILL_REPORT.pdf for the one drill that was
 * actually run against this exact check.
 *
 * Usage: node scripts/recovery/verify-backup-integrity.cjs <path-to-dump> [--manifest-out=<path>]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function fail(msg) {
  console.error('[verify-backup-integrity] FAIL —', msg);
  process.exit(1);
}

function main() {
  const file = process.argv[2];
  if (!file) fail('usage: node scripts/recovery/verify-backup-integrity.cjs <path-to-dump> [--manifest-out=<path>]');
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);

  const stat = fs.statSync(file);
  if (stat.size === 0) fail('backup file is zero bytes — not a usable backup');

  let listOutput;
  try {
    listOutput = execFileSync('pg_restore', ['--list', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    fail(`pg_restore --list failed — archive is not a valid/readable custom-format dump: ${err.message}`);
    return;
  }

  const lines = listOutput.split('\n');
  const tocLines = lines.filter((l) => /^\d+;/.test(l));
  if (tocLines.length === 0) fail('pg_restore --list returned zero table-of-contents entries — archive appears empty or corrupt');

  const header = lines.find((l) => l.startsWith(';')) || '';

  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  const sha256 = hash.digest('hex');

  const manifest = {
    verifiedAt: new Date().toISOString(),
    file: path.resolve(file),
    sizeBytes: stat.size,
    sha256,
    tocEntryCount: tocLines.length,
    archiveHeader: header.trim(),
    result: 'VALID_ARCHIVE_STRUCTURE',
    note:
      'Confirms the archive is structurally valid and readable by pg_restore (non-destructive — this check never connects to any ' +
      'database). It does NOT confirm the data is semantically correct, current, or restorable without error — only an actual ' +
      'restore drill proves that.',
  };

  const outArg = process.argv.find((a) => a.startsWith('--manifest-out='));
  if (outArg) {
    const outPath = outArg.slice('--manifest-out='.length);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    console.log('[verify-backup-integrity] manifest written to', outPath);
  }
  console.log(JSON.stringify(manifest, null, 2));
}

main();
