/**
 * Raw SQL in the server names tables directly, and a wrong name is invisible to every test that fakes the database
 * (a singular `local_feature_index` shipped once and silently disabled the CLIP search). This checks that each table
 * named in a raw query exists in the Prisma schema or is created by one of the scripts/ensure-*.cjs files.
 */
import fs from 'fs';
import path from 'path';
import { describe, test, expect } from '@jest/globals';

const root = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function knownTables(): Set<string> {
  const known = new Set<string>();
  const schema = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
  for (const m of schema.matchAll(/@@map\("([^"]+)"\)/g)) known.add(m[1]!);
  const scripts = path.join(root, 'scripts');
  for (const f of fs.readdirSync(scripts)) {
    if (!f.endsWith('.cjs') && !f.endsWith('.js') && !f.endsWith('.sql')) continue;
    const text = fs.readFileSync(path.join(scripts, f), 'utf8');
    for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_0-9]+)"?/gi)) known.add(m[1]!);
  }
  for (const dir of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sql = path.join(root, 'prisma', 'migrations', dir.name, 'migration.sql');
    if (!fs.existsSync(sql)) continue;
    for (const m of fs.readFileSync(sql, 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_0-9]+)"?/gi)) known.add(m[1]!);
  }
  return known;
}

/** Table names that follow FROM / JOIN / UPDATE / INSERT INTO inside tagged-template raw queries. */
function rawQueryTables(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const tables: string[] = [];
  for (const block of text.matchAll(/\$(?:queryRaw|executeRaw)(?:Unsafe)?\s*(?:<[^`(]*>)?\s*`([^`]*)`/g)) {
    // `DO UPDATE SET` is not a table, and `FROM unnest(...)` is a function, not a table.
    for (const m of block[1]!.matchAll(/\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+"?([a-z_][a-z_0-9]*)\b"?(?!\s*\()/gi)) {
      if (m[1]!.toUpperCase() !== 'SET') tables.push(m[1]!);
    }
  }
  return tables;
}

describe('raw SQL table names', () => {
  const known = knownTables();
  const files = walk(path.join(root, 'src')).filter((f) => /\$(queryRaw|executeRaw)/.test(fs.readFileSync(f, 'utf8')));

  test('the schema and the ensure scripts are being read', () => {
    expect(known.has('local_feature_indexes')).toBe(true);
    expect(known.has('dna_records')).toBe(true);
    expect(files.length).toBeGreaterThan(3);
  });

  test('the CLIP search and backfill use the real table name', () => {
    for (const f of ['src/services/scan/clip-retrieval.ts', 'src/services/forensics/local-dna-index.service.ts']) {
      const tables = rawQueryTables(path.join(root, f));
      expect(tables).toContain('local_feature_indexes');
      expect(tables).not.toContain('local_feature_index');
    }
  });

  test.each(files.map((f) => [path.relative(root, f).replace(/\\/g, '/'), f]))('%s names only tables that exist', (_rel, file) => {
    const unknown = rawQueryTables(file as string).filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });
});
