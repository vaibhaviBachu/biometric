/**
 * Read-only catalog queries used by scripts/audit-rls-readonly.cjs (the before-state snapshot) and by the local lockdown test.
 * Every statement is a plain SELECT over catalog metadata; none reads a row of application data.
 */
const SCHEMAS = ['public', 'exchange', 'landing'];
const list = SCHEMAS.map((s) => `'${s}'`).join(',');

const QUERIES = {
  connection: `select current_user as current_user, session_user as session_user,
      (select rolbypassrls from pg_roles where rolname = current_user) as current_user_bypasses_rls,
      (select rolsuper from pg_roles where rolname = current_user) as current_user_is_superuser,
      version() as server_version`,
  roles: `select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','postgres','dev_app') order by 1`,
  exposedSchemas: `select rolname, rolconfig from pg_roles where rolname = 'authenticator'`,
  relations: `select n.nspname as schema, c.relname as name,
      case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view' when 'm' then 'materialized view' end as kind,
      c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
      pg_get_userbyid(c.relowner) as owner, c.reltuples::bigint as approx_rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${list}) and c.relkind in ('r','p','v','m') order by 1, 2`,
  policies: `select schemaname as schema, tablename as table, policyname, permissive, roles::text as roles, cmd, qual, with_check
    from pg_policies where schemaname in (${list}) order by 1, 2, 3`,
  // Privileges held by the API roles and by the shared teammate login on every relation (the part a rollback must restore).
  grants: `select n.nspname as schema, c.relname as name, case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname in (${list}) and c.relkind in ('r','p','v','m')
      and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','dev_app'))
    group by 1, 2, 3 order by 1, 2, 3`,
  sequenceGrants: `select n.nspname as schema, c.relname as name, pg_get_userbyid(a.grantee) as grantee,
      string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
    where n.nspname in (${list}) and c.relkind = 'S' and pg_get_userbyid(a.grantee) in ('anon','authenticated','dev_app')
    group by 1, 2, 3 order by 1, 2, 3`,
  sensitiveColumnNames: `select table_schema as schema, table_name as table, column_name
    from information_schema.columns
    where table_schema in (${list})
      and column_name ~* '(password|passwd|secret|token|api_?key|private|hash|salt|embedding|template|face|voice|fingerprint|biometric|credential|email|phone|ip_?address|government|aadhaar|passport|ssn|national|card|otp|session)'
    order by 1, 2, 3`,
  anonExecutableFunctions: `select n.nspname as schema, p.proname as function, p.prosecdef as security_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in (${list}) and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1, 2`,
  storageBuckets: `select id, public from storage.buckets order by 1`,
  realtimePublication: `select schemaname as schema, tablename as table from pg_publication_tables where pubname = 'supabase_realtime' order by 1, 2`,
  eventTriggers: `select evtname, evtevent, evtenabled, evtfoid::regproc::text as function from pg_event_trigger order by 1`,
  defaultPrivileges: `select pg_get_userbyid(defaclrole) as role, defaclnamespace::regnamespace::text as schema, defaclobjtype as object_type, defaclacl::text as acl from pg_default_acl order by 1, 2, 3`,
  appRoles: `select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper,
      (select string_agg(b.rolname, ',') from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid) as member_of
    from pg_roles r where r.rolname !~ '^(pg_|supabase_|cli_login|pgbouncer|dashboard_user|authenticator|anon$|authenticated$|service_role$)' order by 1`,
  hoidLocations: `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname = 'hoid_identities' and c.relkind = 'r'`,
};

module.exports = { SCHEMAS, QUERIES };
