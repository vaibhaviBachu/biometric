-- optional/dev-app-readonly.sql   (NOT part of the default run order)
--
-- Teammates should develop against their own local database (see .env.example and docs/DATABASE_ACCESS.md). Run this file ONLY
-- if someone genuinely needs to read the shared database with the `dev_app` login.
--
-- It gives dev_app SELECT on two non-sensitive tables and nothing else:
--   public.plans              the plan catalogue (code, name, storage limit, feature keys)
--   public._prisma_migrations the migration history (names and checksums), so `prisma migrate status` works
-- Everything else stays unreachable for dev_app: RLS is on and no policy exists. dev_app cannot write to the two tables.
--
-- Run it AFTER 02-enable-rls-and-revoke.sql, and tell scripts/ensure-rls.cjs about the two tables, otherwise the next deploy
-- takes the access away again:
--   RLS_DEV_APP_READ_TABLES=public.plans,public._prisma_migrations
--
-- Rollback: drop the two policies and revoke select (statements at the end, commented).

begin;

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'dev_app') then
    raise notice 'no dev_app role: nothing to do';
    return;
  end if;
  foreach t in array array['plans', '_prisma_migrations'] loop
    if to_regclass('public.' || quote_ident(t)) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from dev_app', t);
    execute format('grant select on table public.%I to dev_app', t);
    execute format('drop policy if exists dev_app_read on public.%I', t);
    execute format('create policy dev_app_read on public.%I for select to dev_app using (true)', t);
    raise notice 'dev_app can read public.%', t;
  end loop;
end $$;

commit;

-- ROLLBACK (per table, only if this file was applied):
-- drop policy if exists dev_app_read on public.plans;               revoke all on table public.plans from dev_app;
-- drop policy if exists dev_app_read on public._prisma_migrations;  revoke all on table public._prisma_migrations from dev_app;
