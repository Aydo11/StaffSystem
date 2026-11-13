// Rooms and voids (migration 050): the checks the owner asked for, on the server.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

beforeEach(async () => {
  await resetDb();
  // Priya manages property 1 and Casey property 2 (both Valor Housing). Neither has a company-wide voids role.
  await pool.query('update properties set manager_person_id = null');
  await pool.query('update properties set manager_person_id = $2 where id = $1', [prop(1), P.priya]);
  await pool.query('update properties set manager_person_id = $2, company_id = $3 where id = $1', [prop(2), P.casey, C.VH]);
});

const counts = async (who: any, id = prop(1)) => {
  const rooms = (await who.get(`/api/properties/${id}/rooms`)).body.rooms;
  return { rooms, available: rooms.filter((r: any) => r.status === 'available').length, total: rooms.length };
};

describe('rooms and voids', () => {
  it('works end to end for a six-room property', async () => {
    const priya = await as('priya');
    expect((await priya.post(`/api/properties/${prop(1)}/rooms`).send({ count: 6 })).status).toBe(201);
    let { rooms } = await counts(priya);
    expect(rooms.map((r: any) => r.label)).toEqual(['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Room 5', 'Room 6']);
    expect(rooms.every((r: any) => r.status === 'not_set')).toBe(true);
    const [r1, r2, r3, r4, r5, r6] = rooms;

    // Not available until size, bathroom and floor are chosen.
    const no = await priya.patch(`/api/rooms/${r2.id}`).send({ version: r2.version, status: 'available' });
    expect(no.status).toBe(400);
    const bulk = (await priya.post(`/api/properties/${prop(1)}/rooms/status`).send({ status: 'available', rooms: [r2, r5].map((r) => ({ id: r.id, version: r.version })) })).body;
    expect(bulk.needs_details.sort()).toEqual([r2.id, r5.id].sort());

    const d2 = await priya.patch(`/api/rooms/${r2.id}`).send({ version: r2.version, size: 'double', bathroom: 'ensuite', floor: 'ground', description: 'Ground-floor double near the entrance.', access_notes: 'Two steps at the front door.', status: 'available' });
    expect(d2.status).toBe(200);
    await priya.patch(`/api/rooms/${r5.id}`).send({ version: r5.version, size: 'single', bathroom: 'shared', floor: 'first', status: 'available' });
    await priya.post(`/api/properties/${prop(1)}/rooms/status`).send({ status: 'filled', rooms: [r1, r3, r4, r6].map((r) => ({ id: r.id, version: r.version })) });
    let c = await counts(priya);
    expect(c.rooms.filter((r: any) => r.status === 'available').map((r: any) => r.label)).toEqual(['Room 2', 'Room 5']);
    expect([c.available, c.total]).toEqual([2, 6]);

    // Photo on Room 2; another authorised viewer (system-wide admin) sees description and photo.
    const ph = (await priya.post(`/api/rooms/${r2.id}/photos`).attach('file', png, 'room2.png')).body;
    const alex = await as('alex');
    const seen = (await alex.get(`/api/rooms/${r2.id}`)).body;
    expect(seen.room.description).toContain('near the entrance');
    expect(seen.photos.map((p: any) => p.id)).toEqual([ph.id]);
    expect((await alex.get(`/api/files/${ph.id}`)).status).toBe(200);

    // One tap: Room 2 filled → 1 of 6; undo → 2 of 6, and the same void carries on.
    const room2 = c.rooms.find((r: any) => r.label === 'Room 2');
    const fill = (await priya.patch(`/api/rooms/${r2.id}`).send({ version: room2.version, status: 'filled' })).body;
    expect((await counts(priya)).available).toBe(1);
    const undo = await priya.post(`/api/rooms/${r2.id}/undo`).send({ event_id: fill.event_id, version: fill.room.version });
    expect(undo.status).toBe(200);
    expect((await counts(priya)).available).toBe(2);
    expect(undo.body.room.void_started_at).toBe(room2.void_started_at);
    const voidsRows = (await pool.query('select outcome, ended_at from room_voids where room_id = $1', [r2.id])).rows;
    expect(voidsRows).toHaveLength(1);
    const events = (await pool.query(`select kind, from_value, to_value, undo_of from room_events where room_id = $1 and kind = 'status' order by id`, [r2.id])).rows;
    expect(events.map((e: any) => e.to_value.status)).toEqual(['available', 'filled', 'available']); // the undone change stays in the history
    expect(events[2].undo_of).not.toBeNull();

    // Temporarily unavailable is not available.
    const room5 = (await counts(priya)).rooms.find((r: any) => r.label === 'Room 5');
    await priya.patch(`/api/rooms/${r5.id}`).send({ version: room5.version, status: 'unavailable', reason: 'Repairs' });
    const v = (await priya.get('/api/voids?available=1')).body;
    expect(v.totals).toMatchObject({ rooms: 6, available: 1, filled: 4, unavailable: 1 });
    expect(v.rooms.map((r: any) => r.label)).toEqual(['Room 2']);

    // A second manager working from an old copy is told, not overwritten.
    const stale = await priya.patch(`/api/rooms/${r5.id}`).send({ version: room5.version, status: 'filled' });
    expect(stale.status).toBe(409);
    expect(stale.body.details.room.status).toBe('unavailable');

    // Fewer rooms: must say which to archive; history is kept.
    expect((await priya.post(`/api/properties/${prop(1)}/rooms/total`).send({ count: 5 })).status).toBe(400);
    expect((await priya.post(`/api/properties/${prop(1)}/rooms/total`).send({ count: 5, archive_ids: [r6.id] })).status).toBe(200);
    expect((await counts(priya)).total).toBe(5);
    expect((await pool.query(`select count(*)::int n from room_events where room_id = $1`, [r6.id])).rows[0].n).toBeGreaterThan(1);
    await priya.post(`/api/properties/${prop(1)}/rooms/total`).send({ count: 7 });
    expect((await counts(priya)).rooms.map((r: any) => r.label).slice(-2)).toEqual(['Room 6', 'Room 7']);

    // Another manager cannot see these rooms or photos, by list or direct link.
    const casey = await as('casey');
    expect((await casey.get(`/api/properties/${prop(1)}/rooms`)).status).toBe(404);
    expect((await casey.get(`/api/rooms/${r2.id}`)).status).toBe(404);
    expect((await casey.patch(`/api/rooms/${r2.id}`).send({ version: 1, status: 'filled' })).status).toBe(404);
    expect((await casey.get(`/api/files/${ph.id}`)).status).toBe(404);
    const cv = (await casey.get('/api/voids')).body;
    expect(cv.properties.map((p: any) => p.id)).toEqual([prop(2)]);
    expect(cv.rooms).toEqual([]);
    expect((await priya.get('/api/voids')).body.properties.map((p: any) => p.id)).toEqual([prop(1)]);
    expect((await (await as('sam')).get('/api/voids')).body.properties).toEqual([]); // no role, nothing

    // Senior overview: sees every property in the company, cannot change them. System admin sees all.
    await pool.query(`insert into role_grants (person_id, role_key, company_id, granted_by, reason) values ($1, 'voids_overview', $2, $3, 'test')`, [P.robin, C.VH, P.alex]);
    const robin = await as('robin');
    const rv = (await robin.get('/api/voids')).body.properties.map((p: any) => p.id);
    expect(rv).toEqual(expect.arrayContaining([prop(1), prop(2)]));
    expect((await robin.get(`/api/rooms/${r2.id}`)).status).toBe(200);
    expect((await robin.patch(`/api/rooms/${r2.id}`).send({ version: 99, status: 'filled' })).status).toBe(403);
    const all = (await alex.get('/api/voids')).body.properties.length;
    expect(all).toBe((await pool.query(`select count(*)::int n from properties where status <> 'offboarded'`)).rows[0].n);
    expect((await (await as('priya')).get('/api/me')).body.voids).toBe(true);
    expect((await (await as('sam')).get('/api/me')).body.voids).toBe(false);
  });
});
