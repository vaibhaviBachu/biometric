-- 03-new-table-defaults.sql
--
-- Tables, sequences and functions created LATER by the owner role (postgres: Prisma migrations, the ensure-*.cjs scripts, the
-- SQL editor) must stop being handed to the API roles. Supabase's default privileges currently give anon and authenticated
-- (and dev_app) access to every new table in public; after this file a new table starts with no API access at all.
--
-- This changes no existing table. Idempotent. Only affects objects created from now on by `postgres`.
-- (Row Level Security on a new table is switched on by scripts/ensure-rls.cjs, which runs on every deploy, because Postgres
--  has no default for it that a non-superuser can set. Supabase's own "Automatically enable RLS" project setting can be turned
--  on as well for tables made in the dashboard.)

begin;

alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dev_app') then
    alter default privileges for role postgres in schema public revoke all on tables    from dev_app;
    alter default privileges for role postgres in schema public revoke all on sequences from dev_app;
  end if;
end $$;

-- Same for the other two PINIT schemas (a no-op if they never had defaults).
alter default privileges for role postgres in schema exchange revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema exchange revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema landing  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema landing  revoke all on sequences from anon, authenticated;

commit;
