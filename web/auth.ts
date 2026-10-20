import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AuthConfig = { supabaseUrl: string | null; supabaseAnonKey: string | null; devAuth: boolean; helpContact: string | null };

let sb: SupabaseClient | null = null;
let config: AuthConfig | null = null;
const DEV_KEY = 'hub.devToken';
let devToken: string | null = null;
try { devToken = sessionStorage.getItem(DEV_KEY); } catch { /* storage blocked */ }

const listeners = new Set<() => void>();
export const onAuthChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => listeners.forEach((f) => f());

export async function initAuth(): Promise<AuthConfig> {
  if (config) return config;
  config = await (await fetch('/api/auth/config')).json();
  if (config!.supabaseUrl && config!.supabaseAnonKey) {
    sb = createClient(config!.supabaseUrl, config!.supabaseAnonKey);
    sb.auth.onAuthStateChange(() => emit());
  }
  return config!;
}
export const supabase = () => sb;

export async function getToken(): Promise<string | null> {
  if (devToken) return devToken;
  if (!sb) return null;
  return (await sb.auth.getSession()).data.session?.access_token ?? null;
}
export async function isSignedIn() { return !!(await getToken()); }

export function setDevToken(t: string) {
  devToken = t;
  try { sessionStorage.setItem(DEV_KEY, t); } catch { /* storage blocked: session lasts this tab only */ }
  emit();
}
export async function signOut() {
  devToken = null;
  try { sessionStorage.removeItem(DEV_KEY); } catch { /* ignore */ }
  if (sb) await sb.auth.signOut();
  emit();
}
let unauthHandled = false;
export function onUnauthenticated() {
  if (unauthHandled) return;
  unauthHandled = true;
  signOut().finally(() => { unauthHandled = false; });
}
