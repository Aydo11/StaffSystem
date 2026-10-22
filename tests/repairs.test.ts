// Repairs: photos, a task for the repairs manager, closing completes it, the property's history and the KPI.
import { beforeEach, describe, expect, it } from 'vitest';
import { computeKpis } from '../server/kpi.ts';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
beforeEach(resetDb);

describe('repairs workflow', () => {
  it('goes to the repairs manager as a task with photos, and closing it completes the task and logs it on the property', async () => {
    const alex = await as('alex'), sam = await as('sam');
    expect((await alex.post('/api/governance/leads').send({ company_id: C.VH, area: 'repairs', person_id: P.priya, role: 'lead' })).status).toBe(201);

    const r = await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Kitchen tap leaking', urgency: 'urgent' });
    expect(r.status).toBe(201);
    const task = (await pool.query('select owner_id, priority, due_on, status from tasks where id = $1', [r.body.task_id])).rows[0];
    expect(task).toMatchObject({ owner_id: P.priya, priority: 'high', status: 'not_started' });
    expect((await pool.query(`select 1 from notifications where person_id = $1 and link = $2`, [P.priya, `/estates/repairs/${r.body.id}`])).rowCount).toBe(1);

    expect((await sam.post(`/api/repairs/${r.body.id}/photos`).attach('file', png, 'tap.png')).status).toBe(201);
    expect((await sam.post(`/api/repairs/${r.body.id}/photos`).attach('file', Buffer.from('%PDF-1.4 x'), 'x.pdf')).status).toBe(400); // photos only
    expect((await (await as('taylor')).post(`/api/repairs/${r.body.id}/photos`).attach('file', png, 'x.png')).status).not.toBe(201);

    const priya = await as('priya');
    const detail = (await priya.get(`/api/repairs/${r.body.id}`)).body;
    expect(detail.repair.manager_name).toBeTruthy();
    expect(detail.files[0].is_image).toBe(true);
    await priya.post(`/api/repairs/${r.body.id}/status`).send({ status: 'triaged', note: 'Needs a plumber' });
    await priya.patch(`/api/repairs/${r.body.id}`).send({ assignee_id: P.sam });
    await priya.post(`/api/repairs/${r.body.id}/status`).send({ status: 'assigned', note: 'Sam to fix' });
    await sam.post(`/api/repairs/${r.body.id}/status`).send({ status: 'in_progress', note: 'Washer bought' });
    await sam.post(`/api/repairs/${r.body.id}/status`).send({ status: 'awaiting_verification', note: 'Washer replaced' });
    expect((await priya.post(`/api/repairs/${r.body.id}/status`).send({ status: 'closed', note: 'No drip after an hour' })).status).toBe(200);

    const done = (await pool.query('select status, completed_at from tasks where id = $1', [r.body.task_id])).rows[0];
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
    const hist = (await alex.get(`/api/properties/${prop(1)}`)).body.repair_history;
    expect(hist.find((h: any) => h.id === r.body.id)).toMatchObject({ on_time: true, days_to_fix: 0 });

    await pool.query('update repairs set due_on = completed_on where id = $1', [r.body.id]); // due this month, fixed on the day
    const month = new Date().toISOString().slice(0, 8) + '01';
    const k = (await computeKpis(pool, C.VH, null, month)).find((x) => x.key === 'repairs_on_time');
    expect(k).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('a repair reported from a visit returns its id so the form can add photos', async () => {
    const sam = await as('sam');
    const v = await sam.post('/api/visits/manual').send({ property_id: prop(1), appointment_id: '00000000-0000-4000-8000-000000000b01', start_local: `${new Date().toISOString().slice(0, 10)}T09:00`, minutes: 30, work_category: 'inspection', summary: 'Checked', client_request_id: crypto.randomUUID(), repair: { title: 'Broken fence panel', urgency: 'routine' } });
    expect(v.status).toBe(201);
    expect(v.body.visit.repair_id).toBeTruthy();
    expect((await sam.post(`/api/repairs/${v.body.visit.repair_id}/photos`).attach('file', png, 'fence.png')).status).toBe(201);
  });
});
