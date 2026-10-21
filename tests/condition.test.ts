// House mood ratings, complaints routed to the complaints lead, and repairs saved with a visit.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, P, pool, prop, resetDb, rid } from './helpers.ts';

beforeEach(resetDb);
const day = (h: string) => `${new Date(Date.now() - 3 * 86400e3).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })}T${h}`;
const manual = (extra: object, start = day('05:00')) => ({ property_id: prop(1), appointment_id: A.samVH, client_request_id: rid(), start_local: start, minutes: 30, work_category: 'inspection', summary: 'Weekly inspection of the property.', ...extra });

describe('house mood rating', () => {
  it('the latest rating of each aspect sets the score; nulls are not checked', async () => {
    const sam = await as('sam');
    expect((await sam.post('/api/visits/manual').send(manual({ rating: { kitchen: 5, bathroom: 1 } }))).status).toBe(201);
    let p = (await sam.get(`/api/properties/${prop(1)}`)).body;
    expect(p.condition).toMatchObject({ score: 60, aspects: { kitchen: 5, bathroom: 1 } });
    await sam.post('/api/visits/manual').send(manual({ rating: { bathroom: 3, garden: null, note: 'Bathroom sealant needs redoing.' } }, day('07:00')));
    p = (await sam.get(`/api/properties/${prop(1)}`)).body;
    expect(p.condition).toMatchObject({ score: 80, aspects: { kitchen: 5, bathroom: 3 }, latest_note: 'Bathroom sealant needs redoing.' });
    const list = (await sam.get('/api/properties')).body.find((x: any) => x.id === prop(1));
    expect(list.condition_score).toBe(80);
    expect((await sam.post('/api/visits/manual').send(manual({ rating: { kitchen: 6 } }, day('09:00')))).status).toBe(400);
    expect((await sam.post('/api/visits/manual').send(manual({ rating: {} }, day('09:00')))).status).toBe(400);
  });
});

describe('complaints and maintenance', () => {
  it('a complaint becomes a task for the complaints lead; completing it resolves the complaint', async () => {
    const sam = await as('sam');
    const r = await sam.post('/api/visits/manual').send(manual({
      complaint: { source: 'neighbour', category: 'noise', summary: 'Neighbour reported loud music late at night twice this week.' },
      repair: { title: 'Kitchen tap leaking', urgency: 'routine' },
    }));
    expect(r.status).toBe(201);
    const p = (await sam.get(`/api/properties/${prop(1)}`)).body;
    expect(p.complaints).toHaveLength(1);
    expect(p.complaints[0]).toMatchObject({ category: 'noise', task_status: 'not_started', handler_name: 'Robin' });
    expect(p.repairs.map((x: any) => x.title)).toContain('Kitchen tap leaking');
    const task = (await pool.query('select owner_id, priority from tasks where id = $1', [p.complaints[0].task_id])).rows[0];
    expect(task).toEqual({ owner_id: P.robin, priority: 'high' });
    expect((await pool.query(`select 1 from notifications where person_id = $1 and link = $2`, [P.robin, `/tasks/${p.complaints[0].task_id}`])).rowCount).toBe(1);
    await pool.query(`update tasks set status = 'completed', completed_at = now() where id = $1`, [p.complaints[0].task_id]);
    const after = (await sam.get('/api/properties')).body.find((x: any) => x.id === prop(1));
    expect(after.open_complaints).toBe(0);
  });
  it('any staff member who can see the property logs one from the property page; a bad repair rolls back the visit', async () => {
    const sam = await as('sam');
    expect((await sam.post(`/api/properties/${prop(1)}/complaints`).send({ source: 'resident', category: 'cleanliness', summary: 'Shared kitchen left dirty for several days.' })).status).toBe(201);
    expect((await sam.post(`/api/properties/${prop(1)}/complaints`).send({ source: 'resident', category: 'cleanliness', summary: 'short' })).status).toBe(400);
    const before = (await pool.query('select count(*)::int n from visits')).rows[0].n;
    expect((await sam.post('/api/visits/manual').send(manual({ repair: { title: 'Fix it', urgency: 'routine', description: 'The resident name is Bob' } }))).status).toBe(400);
    expect((await pool.query('select count(*)::int n from visits')).rows[0].n).toBe(before);
  });
});
