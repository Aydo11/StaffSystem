// UK English, GBP, Europe/London display. Timestamps arrive from the server in UTC ISO format.
const TZ = 'Europe/London';
const dateF = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const timeF = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayF = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const partsF = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

// A date-only string ('2026-10-20') is a calendar date, so format it at UTC noon to avoid shifting a day.
const asDate = (v: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
export const fmtDate = (v?: string | null) => (v ? dateF.format(asDate(v)) : '—');
export const fmtDay = (v?: string | null) => (v ? dayF.format(asDate(v)) : '—');
export const fmtTime = (v?: string | null) => (v ? timeF.format(new Date(v)) : '—');
export const fmtDateTime = (v?: string | null) => (v ? `${fmtDate(v)}, ${fmtTime(v)}` : '—');
export const money = (v?: string | number | null) => (v === null || v === undefined ? '—' : gbp.format(Number(v))); // display only; arithmetic happens in Postgres numeric

export function fmtMinutes(m?: number | null) {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}
export const fmtHours = (m: number) => `${(m / 60).toFixed(1)} h`;
export function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function londonParts(d = new Date()) {
  const o: Record<string, string> = {};
  for (const p of partsF.formatToParts(d)) o[p.type] = p.value;
  return o;
}
export const londonToday = (d = new Date()) => { const o = londonParts(d); return `${o.year}-${o.month}-${o.day}`; };
export const londonLocal = (d = new Date()) => { const o = londonParts(d); return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`; };
export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function weekStart(iso: string) {
  const dow = (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, -dow);
}
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const initials = (name?: string | null) => (name ?? '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
