-- Git2App initial schema (PRD §12) with row-level security on every table (PRD §11.3).
-- Every row carries user_id; every policy is user_id = auth.uid(). The API Worker uses the
-- service role only for build dispatch and webhook handling, never on behalf of a browser.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  subscription_plan text not null default 'free' check (subscription_plan in ('free', 'developer', 'pro')),
  created_at timestamptz not null default now()
);

-- A profile row appears when a user signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- github_installations
-- No tokens stored: installation tokens are minted per request from the App private key.
create table public.github_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id bigint not null,
  account_name text not null,
  account_type text not null check (account_type in ('User', 'Organization')),
  created_at timestamptz not null default now(),
  unique (user_id, installation_id)
);

-- ---------------------------------------------------------------- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id bigint not null,
  repository_id bigint not null,
  repository_name text not null,            -- owner/name
  repository_url text not null,
  branch text not null,
  project_root text not null default '' check (project_root !~ '(^|/)\.\.(/|$)' and project_root !~ '^/'),
  output_dir text,
  hosted_origin text check (hosted_origin is null or hosted_origin ~ '^https://'),
  framework text,
  package_manager text,
  auto_build boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, repository_id, branch, project_root)
);

-- ---------------------------------------------------------------- project_analyses
create table public.project_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  framework_detected text,
  pwa_detected boolean not null default false,
  compatibility_score integer check (compatibility_score between 0 and 100),
  recommended_android_strategy text check (recommended_android_strategy in ('twa', 'capacitor', 'unsupported')),
  recommended_ios_strategy text check (recommended_ios_strategy in ('capacitor', 'unsupported')),
  analysis_report jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- app_configurations
create table public.app_configurations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  app_name text not null check (char_length(app_name) between 1 and 50),
  package_id text not null check (package_id ~ '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$'),
  bundle_id text not null check (bundle_id ~ '^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$'),
  version text not null default '1.0.0' check (version ~ '^\d+\.\d+\.\d+$'),
  build_number integer not null default 1 check (build_number > 0),
  icon_url text,
  splash_url text,
  permissions jsonb not null default '[]'::jsonb,
  android_config jsonb not null default '{}'::jsonb,
  ios_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- builds
create table public.builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  configuration_id uuid references public.app_configurations (id) on delete set null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  platform text not null check (platform in ('android', 'ios')),
  packaging_strategy text not null check (packaging_strategy in ('twa', 'capacitor')),
  variant text not null default 'debug' check (variant in ('debug', 'release')),
  status text not null default 'CREATED',
  build_stage text,
  worker_id text,
  -- Dedupe for webhook redeliveries (PRD §14): one build per project+commit+platform+variant+trigger.
  idempotency_key text unique,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  build_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index builds_user_created on public.builds (user_id, created_at desc);

-- ---------------------------------------------------------------- build_artifacts
create table public.build_artifacts (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references public.builds (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  artifact_type text not null check (artifact_type in ('apk', 'aab', 'ipa', 'android-project', 'ios-project', 'log', 'report')),
  storage_key text not null unique,
  file_size bigint not null check (file_size >= 0),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'), -- SHA-256 hex
  validated boolean not null default false,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- signing_credentials
-- Ciphertext only. The data key is wrapped by a master key that lives outside the database
-- (Worker secret / KMS), referenced by key_reference. Browsers never read encrypted_payload.
create table public.signing_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  credential_type text not null check (credential_type in ('android-keystore', 'ios-certificate', 'ios-profile', 'asc-api-key')),
  label text not null default '',
  encrypted_payload bytea not null,
  key_reference text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit log (PRD §19 auditability)
create table public.audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  subject text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ================================================================= RLS
alter table public.profiles enable row level security;
alter table public.github_installations enable row level security;
alter table public.projects enable row level security;
alter table public.project_analyses enable row level security;
alter table public.app_configurations enable row level security;
alter table public.builds enable row level security;
alter table public.build_artifacts enable row level security;
alter table public.signing_credentials enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_own on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Installations are written by the API (service role) after verifying the GitHub callback.
create policy installations_read_own on public.github_installations
  for select to authenticated using (user_id = auth.uid());

create policy projects_own on public.projects
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Analyses are produced by the analyzer (service role); users read their own.
create policy analyses_read_own on public.project_analyses
  for select to authenticated using (user_id = auth.uid());

create policy configs_own on public.app_configurations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- Builds: users read their own; creation and status changes go through the API so quotas,
-- the state machine and job tickets are enforced server-side.
create policy builds_read_own on public.builds
  for select to authenticated using (user_id = auth.uid());

create policy artifacts_read_own on public.build_artifacts
  for select to authenticated using (user_id = auth.uid());

create policy audit_read_own on public.audit_events
  for select to authenticated using (user_id = auth.uid());

-- signing_credentials: no policy for authenticated at all, so browsers can neither read nor
-- write ciphertext. A safe metadata view below lets users see what they have stored.
revoke all on public.signing_credentials from anon, authenticated;

create view public.signing_credentials_meta with (security_invoker = false) as
  select id, platform, credential_type, label, created_at
  from public.signing_credentials
  where user_id = auth.uid();
grant select on public.signing_credentials_meta to authenticated;

revoke all on public.audit_events from anon;
