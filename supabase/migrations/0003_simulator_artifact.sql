-- iOS debug builds produce a simulator app (a zipped App.app), which runs in the iOS Simulator
-- and needs no Apple signing. It is a package like apk/aab/ipa: downloadable only once validated.
alter table public.build_artifacts drop constraint build_artifacts_artifact_type_check;
alter table public.build_artifacts add constraint build_artifacts_artifact_type_check
  check (artifact_type in ('apk', 'aab', 'ipa', 'ios-simulator-app', 'android-project', 'ios-project', 'log', 'report'));
