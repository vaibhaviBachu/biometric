-- 01-contain-sensitive.sql  (CONTAINMENT: run this first if the full lockdown has to wait)
--
-- Closes the public API on the tables that hold identity, credential, secret and access-token data. It deletes nothing and
-- changes no row. Per table it (a) enables Row Level Security and (b) removes every privilege held by anon, authenticated and the
-- shared teammate login dev_app. The backend connects as postgres (BYPASSRLS) and is not affected.
--
-- Idempotent: running it again changes nothing. Each table is handled separately; a busy table is skipped with a warning
-- (lock wait capped at 3 s) and the file can simply be run again.

do $$
declare
  t text;
  rl text;
  api_roles text[];
  tables text[] := array[
    -- named by the owner as sensitive
    'public.credentials', 'public.extension_auth_codes', 'public.government_id_records', 'public.identity_document_fingerprints',
    'public.identity_verification_runs', 'public.organization_api_keys', 'public.organization_invites',
    'public.organization_webhooks', 'public.webauthn_credentials',
    -- carry share / access tokens or recipient e-mail addresses
    'public.campaign_handovers', 'public.campaign_member_assets', 'public.campaign_handover_assets', 'public.client_reports',
    'public.version_approvals', 'public.share_viewer_messages', 'public.campaign_members', 'public.clients',
    -- password hash lives here (no API grants today; RLS added as defence in depth)
    'landing."User"'
  ];
  done int := 0;
begin
  perform set_config('lock_timeout', '3s', true);
  select coalesce(array_agg(rolname order by rolname), array[]::text[]) into api_roles
    from pg_roles where rolname in ('anon', 'authenticated', 'dev_app');

  foreach t in array tables loop
    if to_regclass(t) is null then
      raise notice 'skip % (not present)', t;
      continue;
    end if;
    begin
      execute format('alter table %s enable row level security', t);
      foreach rl in array api_roles loop
        execute format('revoke all on table %s from %I', t, rl);
      end loop;
      done := done + 1;
      raise notice 'contained %', t;
    exception when lock_not_available then
      raise warning '% is busy, skipped: run this file again', t;
    end;
  end loop;
  raise notice '01-contain-sensitive: % table(s) contained', done;
end $$;
