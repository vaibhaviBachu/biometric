-- 02-enable-rls-and-revoke.sql   (GENERATED from scripts/lib/rls-guard.cjs, buildEnsureRlsSql({ verbose: true }); do not edit by hand)
--
-- For EVERY table in the public, exchange and landing schemas:
--   * enable Row Level Security (no policy is created: the API roles get nothing), and
--   * remove every privilege held by anon, authenticated and the shared teammate login dev_app (tables and sequences).
-- Deletes nothing, changes no row, keeps the four existing exchange read policies untouched, and does not touch service_role or
-- postgres (the backend role bypasses RLS). Idempotent: a second run changes nothing. A table that is busy for more than 3 s is
-- skipped with a warning; run the file again.
--
-- Run 01-contain-sensitive.sql first if you want the sensitive tables closed before the rest. Run 03 and 04 afterwards.

do $$
declare
  r record;
  rl text;
  api_roles text[];
  public_read text[] := array[]::text[];
  dev_app_keep text[] := array[]::text[];
  qname text;
  enabled int := 0;
  revoked int := 0;
  busy int := 0;
begin
  perform set_config('lock_timeout', '3s', true);
  select coalesce(array_agg(rolname order by rolname), array[]::text[]) into api_roles
    from pg_roles where rolname in ('anon', 'authenticated', 'dev_app');

  for r in
    select n.nspname as s, c.relname as t, c.oid as oid, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p')
    order by 1, 2
  loop
    qname := r.s || '.' || r.t;
    begin
      if not r.rls then
        execute format('alter table %I.%I enable row level security', r.s, r.t);
        enabled := enabled + 1;
        raise notice 'RLS enabled on %', qname;
      end if;
      foreach rl in array api_roles loop
        continue when qname = any (public_read) and rl in ('anon', 'authenticated');
        continue when qname = any (dev_app_keep) and rl = 'dev_app';
        if has_table_privilege(rl, r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
          execute format('revoke all on table %I.%I from %I', r.s, r.t, rl);
          revoked := revoked + 1;
          raise notice 'revoked % from %', qname, rl;
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
    where n.nspname in ('public', 'exchange', 'landing') and c.relkind = 'S'
  loop
    foreach rl in array api_roles loop
      if has_sequence_privilege(rl, r.oid, 'USAGE,SELECT,UPDATE') then
        execute format('revoke all on sequence %I.%I from %I', r.s, r.t, rl);
        revoked := revoked + 1;
      end if;
    end loop;
  end loop;

  raise notice 'rls-guard: RLS enabled on % table(s); % privilege(s) revoked; % table(s) busy (retry)', enabled, revoked, busy;
end $$;
