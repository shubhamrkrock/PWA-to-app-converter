-- Artifact types (migration 0003). Run after 10_rls_isolation.sql, as the service role.
\set ON_ERROR_STOP on
reset role;
insert into public.build_artifacts (build_id, user_id, artifact_type, storage_key, file_size, checksum)
values ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'ios-simulator-app', 'u/b/App.app.zip', 10, repeat('c', 64));
do $$
begin
  begin
    insert into public.build_artifacts (build_id, user_id, artifact_type, storage_key, file_size, checksum)
    values ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'exe', 'u/b/x.exe', 10, repeat('d', 64));
    raise exception 'FAIL unknown artifact type accepted';
  exception when check_violation then null;
  end;
end $$;
select 'ARTIFACT TYPES OK';
