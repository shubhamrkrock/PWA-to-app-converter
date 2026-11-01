-- profiles.subscription_plan sets build quotas, so a signed-in user must not be able to change
-- it through the public API. Users only read their own profile; the sign-up trigger (security
-- definer) and the API (service role) are the only writers.
drop policy profiles_own on public.profiles;
create policy profiles_read_own on public.profiles
  for select to authenticated using (id = auth.uid());
revoke insert, update, delete on public.profiles from anon, authenticated;
