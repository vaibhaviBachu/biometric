-- ════════════════════════════════════════════════════════════════════════════
-- PINIT — HOID identity store
-- RETIRED — do not run. Nothing in the app reads or writes this table, and it does not exist in production.
-- It once described a browser-side store for face/biometric registration data; that path was removed
-- (docs/BIOMETRIC_AUTH_REBUILD.md). If it is ever run anyway, the table is created locked (see the end of this file).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.hoid_identities (
  id                      uuid primary key default gen_random_uuid(),
  hoid                    text not null,
  short_id                text not null,
  device_fp               text,
  face_image              text,           -- base64 JPEG data URL of the enrolment frame
  face_enrolled           boolean default false,
  webauthn_credential_id  text,           -- FIDO2 / platform authenticator credential id
  webauthn_simulated      boolean default false,
  voice_enrolled          boolean default false,
  liveness_passed         boolean default false,
  trust_score             numeric default 99.8,
  user_agent              text,
  created_at              timestamptz default now(),
  last_login_at           timestamptz
);

create index if not exists hoid_identities_short_id_idx on public.hoid_identities (short_id);
create index if not exists hoid_identities_hoid_idx     on public.hoid_identities (hoid);

-- Row Level Security on, and NO policies: the browser's public anon key gets nothing.
-- This file used to add anon insert/select/update policies with `using (true)`, which would have let anyone holding
-- the anon key read and overwrite every face image. The table was never created in production (checked 2026-10-21,
-- docs/SUPABASE-RLS-PHASE1-AUDIT.md) and nothing in the app uses it any more (client/src/lib/identity-store.ts is
-- imported nowhere). Kept only for reference: do not run it. Biometric data lives in the backend (BiometricIdentity).
alter table public.hoid_identities enable row level security;
revoke all on table public.hoid_identities from anon, authenticated;

-- Remove the old open policies wherever an earlier copy of this file was run.
drop policy if exists "hoid anon insert" on public.hoid_identities;
drop policy if exists "hoid anon select" on public.hoid_identities;
drop policy if exists "hoid anon update" on public.hoid_identities;
