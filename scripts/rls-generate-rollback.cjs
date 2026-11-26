/**
 * Builds a PER-TABLE rollback from a before-state snapshot (scripts/audit-rls-readonly.cjs <snapshot.json>).
 *
 *   node scripts/rls-generate-rollback.cjs <snapshot.json> --table public.credentials[,public.plans]   # executable SQL, those tables only
 *   node scripts/rls-generate-rollback.cjs <snapshot.json> --defaults                                  # default privileges for new tables
 *   node scripts/rls-generate-rollback.cjs <snapshot.json> --reference                                 # every table, fully COMMENTED OUT
 *
 * There is intentionally no "restore everything" mode. Restoring the old state re-opens the table to the public API key, so it is
 * meant for one table that is proven to break, and a narrowly scoped policy or grant is the better repair. Add --pg16 when the
 * target server is older than PostgreSQL 17 (the MAINTAIN privilege does not exist there).
 */
const fs = require('fs');

const TABLE_LETTERS = { a: 'INSERT', r: 'SELECT', w: 'UPDATE', d: 'DELETE', D: 'TRUNCATE', x: 'REFERENCES', t: 'TRIGGER', m: 'MAINTAIN' };
const SEQ_LETTERS = { r: 'SELECT', w: 'UPDATE', U: 'USAGE' };
const FUNC_LETTERS = { X: 'EXECUTE' };
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? 'true' : next;
}

function privs(list, pg16) {
  return list.split(',').map((x) => x.trim()).filter((p) => p && !(pg16 && p === 'MAINTAIN'));
}

function tableSection(snap, rel, pg16) {
  const q = `${ident(rel.schema)}.${ident(rel.name)}`;
  const lines = [`-- ROLLBACK ${rel.schema}.${rel.name}  (before: RLS ${rel.rls_enabled ? 'on' : 'OFF'})`, 'begin;'];
  if (!rel.rls_enabled) lines.push(`alter table ${q} disable row level security;`);
  for (const g of (snap.grants || []).filter((x) => x.schema === rel.schema && x.name === rel.name && x.grantee !== 'PUBLIC')) {
    const p = privs(g.privileges, pg16);
    if (p.length) lines.push(`grant ${p.join(', ')} on table ${q} to ${ident(g.grantee)};`);
  }
  for (const g of (snap.sequenceGrants || []).filter((x) => x.schema === rel.schema && x.name.startsWith(`${rel.name}_`))) {
    const p = privs(g.privileges, pg16);
    if (p.length) lines.push(`grant ${p.join(', ')} on sequence ${ident(g.schema)}.${ident(g.name)} to ${ident(g.grantee)};`);
  }
  lines.push('commit;');
  return lines.join('\n');
}

function defaultsSection(snap, pg16) {
  const lines = ['-- ROLLBACK default privileges for tables, sequences and functions created later', 'begin;'];
  for (const d of (snap.defaultPrivileges || []).filter((x) => x.role === 'postgres' && ['public', 'exchange', 'landing'].includes(x.schema))) {
    const map = d.object_type === 'r' ? TABLE_LETTERS : d.object_type === 'S' ? SEQ_LETTERS : d.object_type === 'f' ? FUNC_LETTERS : null;
    const kind = d.object_type === 'r' ? 'tables' : d.object_type === 'S' ? 'sequences' : 'functions';
    if (!map) continue;
    for (const entry of String(d.acl).replace(/^\{|\}$/g, '').split(',')) {
      const m = entry.match(/^"?([^=]*)=([^/]*)\//);
      if (!m || !m[1] || m[1] === 'postgres') continue;
      const p = privs([...m[2]].filter((l) => map[l]).map((l) => map[l]).join(','), pg16);
      if (p.length) lines.push(`alter default privileges for role postgres in schema ${ident(d.schema)} grant ${p.join(', ')} on ${kind} to ${ident(m[1])};`);
    }
  }
  lines.push('commit;');
  return lines.join('\n');
}

(function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: rls-generate-rollback.cjs <snapshot.json> --table schema.table | --defaults | --reference [--pg16]'); process.exit(2); }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pg16 = arg('pg16') !== undefined;
  const rels = (snap.relations || []).filter((r) => r.kind === 'table' || r.kind === 'partitioned table');
  const out = [`-- Rollback generated from snapshot taken ${snap.takenAt || '(unknown time)'}`];

  if (arg('defaults') !== undefined) out.push(defaultsSection(snap, pg16));
  const only = arg('table');
  if (only && only !== 'true') {
    for (const name of only.split(',').map((x) => x.trim()).filter(Boolean)) {
      const rel = rels.find((r) => `${r.schema}.${r.name}` === name);
      if (!rel) { console.error(`no such table in the snapshot: ${name}`); process.exit(2); }
      out.push(tableSection(snap, rel, pg16));
    }
  }
  if (arg('reference') !== undefined) {
    out.push('-- REFERENCE ONLY: every statement below is commented out. Do not run the whole file; copy ONE table section and uncomment it.');
    for (const rel of rels) out.push(tableSection(snap, rel, pg16).split('\n').map((l) => `-- ${l}`).join('\n'));
    out.push(defaultsSection(snap, pg16).split('\n').map((l) => `-- ${l}`).join('\n'));
  }
  if (out.length === 1) { console.error('nothing to generate: pass --table, --defaults or --reference'); process.exit(2); }
  console.log(out.join('\n\n'));
})();
