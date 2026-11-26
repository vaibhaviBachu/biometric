-- 04-verify.sql  (READ ONLY: raises an error and lists offenders if anything is still open)
--
-- Run after 01-03. It is also safe to run at any time later as a health check.
-- Allow-listed tables (a table that intentionally keeps API access, with its own reviewed policy) must be added to `allow` below.

do $$
declare
  allow text[] := array[]::text[];   -- 'schema.table' entries intentionally readable through the API (none today)
  bad text;
begin
  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if bad is not null then raise exception 'RLS is still OFF on: %', bad; end if;

  select string_agg(distinct n.nspname || '.' || c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p')
    and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
    and not ((n.nspname || '.' || c.relname) = any (allow));
  if bad is not null then raise exception 'anon / authenticated / PUBLIC still hold privileges on: %', bad; end if;

  select string_agg(distinct n.nspname || '.' || c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  where n.nspname in ('public', 'exchange', 'landing') and c.relkind = 'S'
    and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'));
  if bad is not null then raise exception 'API roles still hold privileges on sequences: %', bad; end if;

  select string_agg(distinct n.nspname || '.' || p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'exchange', 'landing') and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.prokind = 'f' and p.prosecdef;
  if bad is not null then raise exception 'anon can execute SECURITY DEFINER functions (they run with the owner rights): %', bad; end if;

  select string_agg(pg_get_userbyid(d.defaclrole) || ' in ' || d.defaclnamespace::regnamespace::text, ', ') into bad
  from pg_default_acl d
  where pg_get_userbyid(d.defaclrole) = 'postgres'
    and d.defaclnamespace::regnamespace::text in ('public', 'exchange', 'landing')
    and d.defaclacl::text ~ '(^|[{,])(anon|authenticated)=';
  if bad is not null then raise exception 'default privileges still give anon / authenticated access to new objects: %', bad; end if;

  raise notice 'verify OK: RLS on for every table, no API-role privileges on tables, sequences or functions, safe defaults for new objects';
end $$;

-- Informational: what dev_app (the shared teammate login) can still reach.
select n.nspname as schema, c.relname as table_name, string_agg(a.privilege_type, ',' order by a.privilege_type) as dev_app_privileges
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname in ('public', 'exchange', 'landing') and c.relkind in ('r', 'p') and pg_get_userbyid(a.grantee) = 'dev_app'
group by 1, 2 order by 1, 2;
