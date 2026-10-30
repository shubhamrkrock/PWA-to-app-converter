-- Analysis runs as a job on an isolated build worker (the API never executes or bulk-reads
-- repository contents). This table tracks those jobs; results land in project_analyses.

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  run_id text,             -- GitHub Actions run that claimed the job (claim is once only)
  claimed_at timestamptz,
  error_message text,
  analysis_id uuid references public.project_analyses (id) on delete set null,
  created_at timestamptz not null default now()
);
create index analysis_jobs_project on public.analysis_jobs (project_id, created_at desc);

alter table public.analysis_jobs enable row level security;
create policy analysis_jobs_read_own on public.analysis_jobs
  for select to authenticated using (user_id = auth.uid());

-- Builds record which Actions run claimed them; a job can be claimed once.
alter table public.builds add column claimed_at timestamptz;
