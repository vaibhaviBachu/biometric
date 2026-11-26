-- 00-preflight.sql  (READ ONLY: changes nothing)
-- Run first, in the Supabase SQL editor of project kqdqmimdqecensurjplh.
--
-- 1. Stops if the role is not the owner role. The lockdown enables RLS; a role that cannot bypass RLS would lock itself out
--    of its own tables. In Supabase the owner role is `postgres` (BYPASSRLS).
-- 2. Reports what is open right now, so the numbers can be compared with 04-verify.sql afterwards.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) then
    raise exception 'Run this as the owner role (postgres). % cannot bypass RLS.', current_user;
  end if;
  raise notice 'role ok: % (bypasses RLS)', current_user;
end $$;

-- Tables per schema: RLS on / off.
select n.nspname as schema,
       count(*) filter (where c.relrowsecurity)     as rls_on,
       count(*) filter (where not c.relrowsecurity) as rls_off
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p')
group by 1 order by 1;

-- Tables where the Supabase API roles hold privileges (expected today: all public tables).
select n.nspname as schema, count(distinct c.oid) as tables_open_to_api_roles
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p')
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
group by 1 order by 1;

-- Roles the lockdown has to know about.
select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'dev_app') order by 1;

-- The identity table described in supabase/hoid_identities.sql must still be absent.
select to_regclass('public.hoid_identities') as hoid_identities_present_if_not_null;
