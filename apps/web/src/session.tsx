import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { ENV } from './env.ts';
import { makeApi, type ApiClient } from './lib/api.ts';
import { hrefFor, parseRoute, type Route } from './lib/routes.ts';

interface Ctx {
  supabase: SupabaseClient;
  session: Session | null;
  ready: boolean;
  api: ApiClient;
  route: Route;
  go: (r: Route | string) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(ENV.supabaseUrl!, ENV.supabaseAnonKey!, { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true } }), []);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.search));

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname, location.search));
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const api = useMemo(() => makeApi(ENV.apiOrigin!, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null), [supabase]);

  const go = (r: Route | string) => {
    const href = typeof r === 'string' ? r : hrefFor(r);
    history.pushState(null, '', href);
    setRoute(parseRoute(location.pathname, location.search));
    scrollTo(0, 0);
  };

  return <AppCtx.Provider value={{ supabase, session, ready, api, route, go }}>{children}</AppCtx.Provider>;
}
