// Geotagging at Start/Finish and property map pins.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { metres, pinProperties, setPostcodeLookup } from '../server/geo.ts';
import { A, as, pool, prop, resetDb, rid } from './helpers.ts';

beforeEach(resetDb);
afterAll(() => { delete process.env.GEO_IN_TESTS; });
const pin = (lat: number, lng: number) => pool.query(`update properties set latitude = $2, longitude = $3, location_source = 'manual' where id = $1`, [prop(1), lat, lng]);

describe('geotagging', () => {
  it('measures distance', () => {
    expect(metres(52.5, -1.9, 52.5, -1.9)).toBe(0);
    expect(metres(52.4862, -1.8904, 52.4862, -1.8757)).toBeGreaterThan(950); // ~1 km east in Birmingham
    expect(metres(52.4862, -1.8904, 52.4862, -1.8757)).toBeLessThan(1050);
  });

  it('records where the visit started and finished, and how far from the property', async () => {
    await pin(52.4862, -1.8904);
    const sam = await as('sam');
    const s = await sam.post('/api/visits/start').send({ property_id: prop(1), appointment_id: A.samVH, client_request_id: rid(), geo: { lat: 52.4863, lng: -1.8905, accuracy: 12.4 } });
    expect(s.status).toBe(201);
    expect(s.body.visit).toMatchObject({ start_accuracy_m: 12 });
    expect(s.body.visit.start_distance_m).toBeLessThan(30);
    const f = await sam.post(`/api/visits/${s.body.visit.id}/finish`).send({ work_category: 'inspection', summary: 'Checked the alarms', geo: { lat: 52.4862, lng: -1.8757 } });
    expect(f.status).toBe(200);
    expect(f.body.finish_distance_m).toBeGreaterThan(900);
    const list = (await (await as('priya')).get('/api/visits?from=2000-01-01&to=2100-01-01')).body.find((v: any) => v.id === s.body.visit.id);
    expect(list).toMatchObject({ geotagged: true });
  });

  it('still starts when location is not shared, and rejects impossible coordinates', async () => {
    const sam = await as('sam');
    expect((await sam.post('/api/visits/start').send({ property_id: prop(1), appointment_id: A.samVH, client_request_id: rid(), geo: { lat: 200, lng: 0 } })).status).toBe(400);
    const s = await sam.post('/api/visits/start').send({ property_id: prop(1), appointment_id: A.samVH, client_request_id: rid() });
    expect(s.status).toBe(201);
    expect(s.body.visit.start_lat).toBeNull();
  });
});

describe('property map pins', () => {
  it('pins from the postcode, re-pins when the postcode changes, and keeps a hand-placed pin', async () => {
    process.env.GEO_IN_TESTS = '1';
    setPostcodeLookup(async (pc) => (pc.startsWith('B21') ? [52.5, -1.93] : [52.48, -1.9]));
    await pool.query(`update properties set latitude = null, longitude = null, location_source = null`);
    expect(await pinProperties()).toBeGreaterThan(0);
    let p = (await pool.query('select latitude, location_source from properties where id = $1', [prop(1)])).rows[0];
    expect(p).toMatchObject({ location_source: 'postcode' });
    const alex = await as('alex');
    await alex.patch(`/api/properties/${prop(1)}`).send({ postcode: 'B21 9ES' });
    await new Promise((r) => setTimeout(r, 100)); // background re-pin
    p = (await pool.query('select latitude from properties where id = $1', [prop(1)])).rows[0];
    expect(p.latitude).toBe(52.5);
    await alex.patch(`/api/properties/${prop(1)}`).send({ latitude: 52.51, longitude: -1.94 });
    await alex.patch(`/api/properties/${prop(1)}`).send({ postcode: 'B1 1AA' });
    p = (await pool.query('select latitude, location_source from properties where id = $1', [prop(1)])).rows[0];
    expect(p).toMatchObject({ latitude: 52.51, location_source: 'manual' });
    expect((await alex.patch(`/api/properties/${prop(1)}`).send({ latitude: 52.5 })).status).toBe(400);
  });
});
