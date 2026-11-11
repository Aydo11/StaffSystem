// Migration 049: house info packs, routines, staff guides, policies recorded as read, and the shift panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, P, pool, prop, resetDb } from './helpers.ts';

beforeEach(resetDb);

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe('house info pack', () => {
  it('staff read it; only managers edit it and see the access codes', async () => {
    const sam = await as('sam'); const priya = await as('priya');
    const body = { sections: { water: 'Stopcock under the kitchen sink.', bins: 'Black bin Tuesday.' }, access: 'Key safe 1234' };
    expect((await sam.put(`/api/properties/${prop(1)}/info`).send(body)).status).toBe(403);
    expect((await priya.put(`/api/properties/${prop(1)}/info`).send(body)).status).toBe(200);
    const mine = (await sam.get(`/api/properties/${prop(1)}/info`)).body;
    expect(mine.sections.water).toContain('Stopcock');
    expect(mine.access).toBeUndefined();
    expect((await priya.get(`/api/properties/${prop(1)}/info`)).body.access).toBe('Key safe 1234');
    const log = await pool.query(`select detail::text d from audit_log where entity = 'property' and action = 'info_pack'`);
    expect(log.rows[0].d).not.toContain('1234'); // codes never go to the audit log

    const open = (await priya.post(`/api/properties/${prop(1)}/info/photos`).field('section', 'water').attach('file', png, 'stopcock.png')).body;
    const secret = (await priya.post(`/api/properties/${prop(1)}/info/photos`).field('section', 'access').attach('file', png, 'keysafe.png')).body;
    expect((await sam.get(`/api/files/${open.id}`)).status).toBe(200);
    expect((await sam.get(`/api/files/${secret.id}`)).status).toBe(404);
    expect((await sam.get(`/api/properties/${prop(1)}/info`)).body.photos.map((p: any) => p.id)).toEqual([open.id]);
  });
});

describe('routines', () => {
  it('make one task on the day they are due, for the owner', async () => {
    const priya = await as('priya');
    const today = (await pool.query(`select extract(isodow from (now() at time zone 'Europe/London'))::int d`)).rows[0].d;
    const r = await priya.post(`/api/properties/${prop(1)}/routines`).send({ title: 'Weekly fire alarm test', frequency: 'weekly', weekday: today, owner_id: P.sam, checklist: ['Alarm sounded'] });
    expect(r.status).toBe(201);
    await priya.post(`/api/properties/${prop(1)}/routines`).send({ title: 'Bins out', frequency: 'weekly', weekday: (today % 7) + 1 }); // tomorrow: no task yet
    const { runRoutines } = await import('../server/routes/houseinfo.ts');
    await runRoutines(); await runRoutines();
    const t = (await pool.query('select title, owner_id, checklist from tasks where routine_id is not null')).rows;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: 'Weekly fire alarm test', owner_id: P.sam, checklist: [{ text: 'Alarm sounded', done: false }] });
    expect((await (await as('sam')).post(`/api/properties/${prop(1)}/routines`).send({ title: 'x y z', frequency: 'daily' })).status).toBe(403);
    expect((await priya.post(`/api/properties/${prop(1)}/routines`).send({ title: 'No day', frequency: 'weekly' })).status).toBe(400);
  });
});

describe('guides', () => {
  it('staff see published guides; managers also see drafts and can write them', async () => {
    const sam = await as('sam'); const priya = await as('priya');
    const staffList = (await sam.get('/api/guides')).body;
    expect(staffList.guides.length).toBeGreaterThan(10);
    expect(staffList.guides.every((g: any) => g.status === 'published')).toBe(true);
    expect(staffList.can.manage).toBe(false);
    expect((await priya.get('/api/guides')).body.guides.some((g: any) => g.status === 'draft')).toBe(true);
    const g = await priya.post('/api/guides').send({ category: 'houses', title: 'Parking at Hagley Road', body: 'Park on the street.', status: 'draft' });
    expect(g.status).toBe(201);
    expect((await sam.get(`/api/guides/${g.body.id}`)).status).toBe(404);
    expect((await sam.post('/api/guides').send({ category: 'houses', title: 'Nope', body: 'Nope.', status: 'published' })).status).toBe(403);
  });
});

describe('shift panel and policies', () => {
  it('My Day lists alerts at my houses, and policies no longer ask to be acknowledged', async () => {
    const sam = await as('sam');
    await pool.query(`insert into repairs (company_id, property_id, title, urgency, status, reported_by) select company_id, id, 'Boiler not working', 'urgent', 'reported', $2 from properties where id = $1`, [prop(1), P.alex]);
    const d = (await sam.get('/api/my-day')).body;
    expect(d.alerts.some((x: any) => x.kind === 'repair' && x.title === 'Boiler not working')).toBe(true);
    expect((await sam.get('/api/inbox')).body.some((i: any) => i.kind === 'policy_ack')).toBe(false);
  });
});
