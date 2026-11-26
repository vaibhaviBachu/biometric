-- 05-exposure-audit-readonly.sql   (READ ONLY: two plain SELECT statements; run BEFORE the lockdown if possible, and again after)
--
-- Helps judge whether the exposure was used. It changes nothing, deletes nothing and reads no row content: only COUNTS and the newest
-- created / updated timestamp per table. Run as postgres in the Supabase SQL editor (results appear in the grid).
--
-- Interpretation: the API roles (anon / authenticated) could INSERT and UPDATE these tables, so a recent updated_last_30d that does
-- not match your own activity, or a row count you cannot explain, is worth investigating. Compare with the API logs (see
-- docs/SUPABASE-RLS-PHASE2-PLAN.md, "Audit steps").

with watched(name) as (values
  ('credentials'), ('extension_auth_codes'), ('government_id_records'), ('identity_document_fingerprints'),
  ('identity_verification_runs'), ('organization_api_keys'), ('organization_invites'), ('organization_webhooks'),
  ('webauthn_credentials'), ('campaign_handovers'), ('campaign_member_assets'), ('campaign_handover_assets'), ('client_reports'),
  ('version_approvals'), ('share_viewer_messages'), ('campaign_members'), ('clients'), ('subscriptions'),
  ('feature_entitlements'), ('usage_records'), ('billing_history'), ('organizations'), ('organization_members'),
  ('support_tickets'), ('portfolios')
),
present as (
  select w.name,
    exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = w.name and c.column_name = 'createdAt') as has_created,
    exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = w.name and c.column_name = 'updatedAt') as has_updated
  from watched w where to_regclass('public.' || quote_ident(w.name)) is not null
)
select name as table_name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', name), false, true, '')))[1]::text::bigint as row_count,
  case when has_created then (xpath('/row/c/text()', query_to_xml(format('select max("createdAt") as c from public.%I', name), false, true, '')))[1]::text end as newest_created,
  case when has_updated then (xpath('/row/c/text()', query_to_xml(format('select max("updatedAt") as c from public.%I', name), false, true, '')))[1]::text end as newest_updated,
  case when has_updated then (xpath('/row/c/text()', query_to_xml(format('select count(*) filter (where "updatedAt" > now() - interval ''30 days'') as c from public.%I', name), false, true, '')))[1]::text::bigint end as updated_last_30d
from present order by 1;

-- Secrets and tokens that sat in exposed tables and should be treated as seen: rotate or revoke them after containment.
select 'organization_webhooks (signing secrets, stored in clear)' as what, count(*) as row_count from public.organization_webhooks
union all select 'organization_invites (invite tokens)', count(*) from public.organization_invites
union all select 'extension_auth_codes', count(*) from public.extension_auth_codes
union all select 'organization_api_keys (hashes only)', count(*) from public.organization_api_keys
union all select 'campaign_handovers (accessToken)', count(*) from public.campaign_handovers
union all select 'client_reports (accessToken)', count(*) from public.client_reports
union all select 'campaign_member_assets (shareToken)', count(*) from public.campaign_member_assets
union all select 'version_approvals (shareToken)', count(*) from public.version_approvals
union all select 'share_viewer_messages (shareToken)', count(*) from public.share_viewer_messages;
