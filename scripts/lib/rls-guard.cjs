/**
 * Shared SQL for the Supabase security lockdown (see supabase/rls-lockdown/README.md).
 *
 * Why this exists: Postgres tables created through Prisma, the ensure-*.cjs scripts or the SQL editor start with Row Level
 * Security OFF, and Supabase's default privileges hand `anon` / `authenticated` (and the shared `dev_app` login) access to every
 * new `public` table. The public anon key ships in the browser bundle, so a new table is readable and writable through
 * /rest/v1/ until someone locks it. This guard enables RLS on every table in the three PINIT schemas and removes the
 * API roles' privileges. It does NOT create policies: a table that genuinely needs API access gets an explicit, reviewed
 * policy and an entry in the allow lists below.
 *
 * IDEMPOTENT: a second run changes nothing. Per-table lock waits are capped (3 s); a busy table is skipped with a warning and
 * picked up by the next run.
 */

const SCHEMAS = ['public', 'exchange', 'landing'];
const API_ROLES = ['anon', 'authenticated', 'dev_app'];

function lit(values) {
  if (!values.length) return `array[]::text[]`;
  return `array[${values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')}]`;
}

/**
 * @param {{ verbose?: boolean,
 *           publicRead?: string[],   // 'schema.table' entries the API roles may keep reading (needs its own policy)
 *           devAppKeep?: string[],   // 'schema.table' entries whose dev_app privileges are managed separately (read-only share)
 * }} [opts]
 */
function buildEnsureRlsSql(opts = {}) {
  const verbose = Boolean(opts.verbose);
  const publicRead = opts.publicRead ?? [];
  const devAppKeep = opts.devAppKeep ?? [];
  const note = (msg) => (verbose ? `raise notice ${msg};` : '');
  return `do $$
declare
  r record;
  rl text;
  api_roles text[];
  public_read text[] := ${lit(publicRead)};
  dev_app_keep text[] := ${lit(devAppKeep)};
  qname text;
  enabled int := 0;
  revoked int := 0;
  busy int := 0;
begin
  perform set_config('lock_timeout', '3s', true);
  select coalesce(array_agg(rolname order by rolname), array[]::text[]) into api_roles
    from pg_roles where rolname in (${API_ROLES.map((x) => `'${x}'`).join(', ')});

  for r in
    select n.nspname as s, c.relname as t, c.oid as oid, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${SCHEMAS.map((x) => `'${x}'`).join(', ')}) and c.relkind in ('r', 'p')
    order by 1, 2
  loop
    qname := r.s || '.' || r.t;
    begin
      if not r.rls then
        execute format('alter table %I.%I enable row level security', r.s, r.t);
        enabled := enabled + 1;
        ${note(`'RLS enabled on %', qname`)}
      end if;
      foreach rl in array api_roles loop
        continue when qname = any (public_read) and rl in ('anon', 'authenticated');
        continue when qname = any (dev_app_keep) and rl = 'dev_app';
        if has_table_privilege(rl, r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
          execute format('revoke all on table %I.%I from %I', r.s, r.t, rl);
          revoked := revoked + 1;
          ${note(`'revoked % from %', qname, rl`)}
        end if;
      end loop;
    exception when lock_not_available then
      busy := busy + 1;
      raise warning 'rls-guard: % is busy, skipped; the next run will handle it', qname;
    end;
  end loop;

  for r in
    select n.nspname as s, c.relname as t, c.oid as oid
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${SCHEMAS.map((x) => `'${x}'`).join(', ')}) and c.relkind = 'S'
  loop
    foreach rl in array api_roles loop
      if has_sequence_privilege(rl, r.oid, 'USAGE,SELECT,UPDATE') then
        execute format('revoke all on sequence %I.%I from %I', r.s, r.t, rl);
        revoked := revoked + 1;
      end if;
    end loop;
  end loop;

  raise notice 'rls-guard: RLS enabled on % table(s); % privilege(s) revoked; % table(s) busy (retry)', enabled, revoked, busy;
end $$;`;
}

/** Read-only: how many tables are still unprotected (RLS off, or privileges held by an API role). */
const COUNT_UNSAFE_SQL = `
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in (${SCHEMAS.map((x) => `'${x}'`).join(', ')}) and c.relkind in ('r', 'p') and not c.relrowsecurity)::int as rls_off,
  (select count(distinct c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where n.nspname in (${SCHEMAS.map((x) => `'${x}'`).join(', ')}) and c.relkind in ('r', 'p')
       and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated')))::int as open_to_api_roles`;

module.exports = { SCHEMAS, API_ROLES, buildEnsureRlsSql, COUNT_UNSAFE_SQL };
