// Locations: property pins from UK postcodes (postcodes.io, free, no key) and visit geotags taken at Start and Finish.
import { z } from 'zod';
import { type Db, one, pool, q } from './db.ts';

export const geoBody = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), accuracy: z.coerce.number().min(0).max(100_000).optional() }).optional();

// Great-circle distance in metres.
export function metres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(a)));
}

// Columns for a visit's start or finish geotag; distance from the property when its pin is known.
export async function geotag(db: Db, propertyId: string, g: z.infer<typeof geoBody>) {
  if (!g) return [null, null, null, null];
  const p = await one<{ latitude: number | null; longitude: number | null }>('select latitude, longitude from properties where id = $1', [propertyId], db);
  const d = p?.latitude != null && p.longitude != null ? metres(g.lat, g.lng, p.latitude, p.longitude) : null;
  return [g.lat, g.lng, g.accuracy != null ? Math.round(g.accuracy) : null, d];
}

let lookup = async (postcode: string): Promise<[number, number] | null> => {
  const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.trim())}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result?.latitude != null ? [j.result.latitude, j.result.longitude] : null;
};
export const setPostcodeLookup = (f: typeof lookup) => { lookup = f; };

// Pin properties that have no location yet (new ones, or after a postcode change). Failures are retried next run.
export async function pinProperties(db: Db = pool, limit = 50) {
  if (process.env.NODE_ENV === 'test' && !process.env.GEO_IN_TESTS) return 0;
  const rows = await q<{ id: string; postcode: string }>('select id, postcode from properties where latitude is null and location_source is null limit $1', [limit], db);
  let n = 0;
  for (const p of rows) {
    const ll = await lookup(p.postcode).catch(() => null);
    if (ll) { await q(`update properties set latitude = $2, longitude = $3, location_source = 'postcode' where id = $1 and latitude is null`, [p.id, ll[0], ll[1]], db); n++; }
  }
  return n;
}
