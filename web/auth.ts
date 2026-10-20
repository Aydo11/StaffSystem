// The Hub's own sign-in: the server issues an opaque session token, kept in this browser until sign-out or expiry.
export type AuthConfig = { devAuth: boolean; helpContact: string | null; selfServiceReset: boolean };

const KEY = 'hub.session';
let token: string | null = null;
try { token = localStorage.getItem(KEY); } catch { /* storage blocked: session lasts this tab only */ }
let config: AuthConfig | null = null;

const listeners = new Set<() => void>();
export const onAuthChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => listeners.forEach((f) => f());

export async function initAuth(): Promise<AuthConfig> {
  config ??= await (await fetch('/api/auth/config')).json();
  return config!;
}
export async function getToken() { return token; }
export async function isSignedIn() { return !!token; }

export function setToken(t: string) {
  token = t;
  try { localStorage.setItem(KEY, t); } catch { /* see above */ }
  emit();
}
function clear() {
  token = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  emit();
}
export async function signOut() {
  const t = token;
  clear();
  if (t) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {}); // ends the session on the server too
}
let unauthHandled = false;
export function onUnauthenticated() {
  if (unauthHandled) return;
  unauthHandled = true;
  clear(); // the server already rejected this token
  unauthHandled = false;
}
