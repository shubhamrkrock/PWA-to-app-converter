-- A signing key's certificate fingerprint (SHA-256, AA:BB:..), public by nature: Android shows it,
-- and it is published in /.well-known/assetlinks.json so verified app links open the app (3 Nov 2026).
-- Known when Git2App made the key in the person's browser; null for an uploaded keystore.
alter table public.signing_credentials
  add column fingerprint_sha256 text check (fingerprint_sha256 ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$');

create or replace view public.signing_credentials_meta with (security_invoker = false) as
  select id, platform, credential_type, label, created_at, fingerprint_sha256
  from public.signing_credentials
  where user_id = auth.uid();
grant select on public.signing_credentials_meta to authenticated;
