-- Tenant isolation test (PRD AC-15). Run after the shim and all migrations.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com');

-- service role seeds data for both tenants
insert into public.projects (id, user_id, installation_id, repository_id, repository_name, repository_url, branch)
values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 1, 11, 'alice/app', 'https://github.com/alice/app', 'main'),
       ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 2, 22, 'bob/app', 'https://github.com/bob/app', 'main');
insert into public.builds (id, project_id, user_id, commit_sha, platform, packaging_strategy)
values ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', repeat('b', 40), 'android', 'capacitor');
insert into public.build_artifacts (build_id, user_id, artifact_type, storage_key, file_size, checksum)
values ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'apk', 'u/b/x.apk', 10, repeat('a', 64));
insert into public.signing_credentials (user_id, platform, credential_type, encrypted_payload, key_reference)
values ('00000000-0000-0000-0000-00000000000b', 'android', 'android-keystore', '\x00', 'kms:1');

-- now act as Alice through the browser role
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

do $$ declare n int; begin
  select count(*) into n from public.projects;            if n <> 1 then raise exception 'FAIL projects visible: %', n; end if;
  select count(*) into n from public.builds;              if n <> 0 then raise exception 'FAIL builds leak: %', n; end if;
  select count(*) into n from public.build_artifacts;     if n <> 0 then raise exception 'FAIL artifacts leak: %', n; end if;
  select count(*) into n from public.signing_credentials_meta; if n <> 0 then raise exception 'FAIL credential meta leak: %', n; end if;
end $$;

-- Alice cannot read ciphertext even of her own kind of table
do $$ begin
  perform 1 from public.signing_credentials;
  raise exception 'FAIL signing_credentials readable by browser role';
exception when insufficient_privilege then null; end $$;

-- Alice cannot create a project in Bob's name
do $$ begin
  insert into public.projects (user_id, installation_id, repository_id, repository_name, repository_url, branch)
  values ('00000000-0000-0000-0000-00000000000b', 9, 99, 'x/y', 'https://github.com/x/y', 'main');
  raise exception 'FAIL cross-tenant insert allowed';
exception when insufficient_privilege then null; end $$;

-- Alice cannot attach a configuration to Bob's project
do $$ begin
  insert into public.app_configurations (project_id, user_id, app_name, package_id, bundle_id)
  values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', 'X', 'com.x.y', 'com.x.y');
  raise exception 'FAIL config on foreign project allowed';
exception when insufficient_privilege then null; end $$;

-- Alice cannot create builds directly (must go through the API)
do $$ begin
  insert into public.builds (project_id, user_id, commit_sha, platform, packaging_strategy)
  values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', repeat('a', 40), 'ios', 'capacitor');
  raise exception 'FAIL browser created a build';
exception when insufficient_privilege then null; end $$;

-- A project root that escapes the repo is rejected by the schema
do $$ begin
  insert into public.projects (user_id, installation_id, repository_id, repository_name, repository_url, branch, project_root)
  values ('00000000-0000-0000-0000-00000000000a', 1, 12, 'alice/b', 'https://github.com/alice/b', 'main', 'apps/../..');
  raise exception 'FAIL traversal root accepted';
exception when check_violation then null; end $$;

-- Bob sees his own
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ declare n int; begin
  select count(*) into n from public.builds; if n <> 1 then raise exception 'FAIL bob builds: %', n; end if;
  select count(*) into n from public.signing_credentials_meta; if n <> 1 then raise exception 'FAIL bob credential meta: %', n; end if;
end $$;
reset role;
select 'RLS ISOLATION OK' as result;
