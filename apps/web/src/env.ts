/** Public build-time settings (they end up in the page; none of them is a secret). */
export const ENV = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  apiOrigin: import.meta.env.VITE_API_ORIGIN as string | undefined,
};

export const configured = !!(ENV.supabaseUrl && ENV.supabaseAnonKey && ENV.apiOrigin);
