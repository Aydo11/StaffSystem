// Complaints workspace: stages, resolution, actions, notes, escalation, reminders and confidential (HR) cases.
import { beforeEach, describe, expect, it } from 'vitest';
import { complaintReminders } from '../server/routes/complaints.ts';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

beforeEach(resetDb);
const log = async () => {
  const sam = await as('sam');
  expect((await sam.post(`/api/properties/${prop(1)}/complaints`).send({ source: 'resident', category: 'noise', summary: 'Loud music late at night again.' })).status).toBe(201);
  return (await pool.query('select id, task_id, ref from property_complaints order by created_at desc limit 1')).rows[0];
};

describe('complaints workspace', () => {
  it('the lead works the case; the person who logged it sees progress only', async () => {
    const c = await log();
    expect(c.ref).toMatch(/^CMP-\d{4}-\d{4}$/);
    const robin = await as('robin'), sam = await as('sam');
    const list = (await robin.get('/api/complaints')).body;
    expect(list.cases.find((x: any) => x.id === c.id)).toMatchObject({ stage: 'assigned', owner_name: 'Robin', party_only: false });
    expect((await sam.get('/api/complaints')).body.cases.find((x: any) => x.id === c.id).party_only).toBe(true);

    await robin.post(`/api/complaints/${c.id}/events`).send({ kind: 'advice', body: 'Speak to the resident about quiet hours.' });
    const party = (await sam.get(`/api/complaints/${c.id}`)).body;
    expect(party.role).toBe('party');
    expect(party.events.map((e: any) => e.kind)).not.toContain('advice');
    expect((await sam.patch(`/api/complaints/${c.id}`).send({ stage: 'in_progress' })).status).toBe(403);
    expect((await sam.post('/api/complaints').send({ company_id: C.VH, source: 'resident', category: 'noise', summary: 'Another complaint about noise.' })).status).toBe(403);

    expect((await robin.patch(`/api/complaints/${c.id}`).send({ stage: 'resolved' })).status).toBe(400);
    expect((await robin.patch(`/api/complaints/${c.id}`).send({ stage: 'resolved', resolution: 'Agreed quiet hours with the resident; no further reports.' })).status).toBe(200);
    expect((await pool.query('select status from tasks where id = $1', [c.task_id])).rows[0].status).toBe('completed');
    await robin.patch(`/api/complaints/${c.id}`).send({ stage: 'in_progress', comment: 'Noise reported again.' });
    expect((await pool.query('select status from tasks where id = $1', [c.task_id])).rows[0].status).toBe('in_progress');
    const d = (await robin.get(`/api/complaints/${c.id}`)).body;
    expect(d.case.resolved_at).toBeNull();
    expect(d.events.map((e: any) => e.kind)).toEqual(['created', 'assigned', 'advice', 'stage', 'updated', 'stage']);
  });

  it('follow-up actions become tasks; the action owner can see the case and tick it off', async () => {
    const c = await log();
    const robin = await as('robin'), sam = await as('sam');
    const x = (await robin.post(`/api/complaints/${c.id}/actions`).send({ title: 'Check the communal lounge after 10pm', owner_id: P.sam, due_on: '2030-01-01' })).body;
    expect((await pool.query('select owner_id from tasks where id = $1', [x.task_id])).rows[0].owner_id).toBe(P.sam);
    expect((await sam.get(`/api/complaints/${c.id}`)).body.role).toBe('team'); // owning an action lets her read the case
    expect((await sam.patch(`/api/complaints/${c.id}`).send({ stage: 'closed' })).status).toBe(403);
    expect((await sam.post(`/api/complaints/${c.id}/actions/${x.id}/done`)).status).toBe(200);
    expect((await pool.query('select status from tasks where id = $1', [x.task_id])).rows[0].status).toBe('completed');
    expect((await robin.get(`/api/complaints/${c.id}`)).body.actions[0].done_at).not.toBeNull();
  });

  it('escalation and overdue reminders reach senior staff once', async () => {
    const c = await log();
    const robin = await as('robin');
    expect((await robin.patch(`/api/complaints/${c.id}`).send({ escalated: true })).status).toBe(400);
    await robin.patch(`/api/complaints/${c.id}`).send({ escalated: true, escalation_reason: 'Resident threatening to go to the council.' });
    expect((await pool.query(`select 1 from notifications where person_id = $1 and title like 'Needs senior attention%'`, [P.alex])).rowCount).toBe(1);
    await robin.patch(`/api/complaints/${c.id}`).send({ escalated: false, due_on: '2026-01-05' });
    expect(await complaintReminders()).toBe(1);
    expect(await complaintReminders()).toBe(0); // once a day
    expect((await pool.query('select escalated from property_complaints where id = $1', [c.id])).rows[0].escalated).toBe(true);
    expect((await pool.query(`select 1 from notifications where person_id = $1 and title like 'Overdue complaint%'`, [P.robin])).rowCount).toBe(1);
  });

  it('confidential HR complaints open only for authorised staff', async () => {
    const morgan = await as('morgan'), priya = await as('priya'), robin = await as('robin'), alex = await as('alex');
    const r = await morgan.post('/api/complaints').send({ company_id: C.VH, source: 'staff', category: 'hr', title: 'Concern about shift allocation', summary: 'A staff member says shifts are being allocated unfairly.', confidential: true, owner_id: P.morgan, priority: 'high' });
    expect(r.status).toBe(201);
    expect((await pool.query('select title, property_id from tasks where id = $1', [r.body.task_id])).rows[0]).toEqual({ title: `Complaint ${r.body.ref} (confidential)`, property_id: null });
    expect((await priya.get(`/api/complaints/${r.body.id}`)).status).toBe(404); // manager + complaints deputy, not authorised
    expect((await robin.get('/api/complaints')).body.cases.some((x: any) => x.id === r.body.id)).toBe(false);
    expect((await alex.get(`/api/complaints/${r.body.id}`)).status).toBe(200);
    expect((await priya.post(`/api/complaints/${r.body.id}/access`).send({ person_id: P.priya })).status).toBe(404);
    expect((await morgan.post(`/api/complaints/${r.body.id}/access`).send({ person_id: P.priya })).status).toBe(201);
    expect((await priya.get(`/api/complaints/${r.body.id}`)).body.role).toBe('handler');
    expect((await pool.query(`select count(*)::int n from audit_log where entity_id = $1 and action = 'view'`, [r.body.id])).rows[0].n).toBeGreaterThan(0);
  });
});
