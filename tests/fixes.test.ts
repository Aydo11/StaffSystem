// Regression tests for audit findings 1–3, 5, 8 and 10.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, P, pool, resetDb, V } from './helpers.ts';

beforeEach(resetDb);
const PRIYA_VH = '00000000-0000-4000-8000-000000000b04';

describe('audit 1 · future-dated leaving dates', () => {
  it('sets the company roles to expire after the last day, and refuses sign-in once nothing is left', async () => {
    const r = await (await as('morgan')).post(`/api/appointments/${PRIYA_VH}/end`).send({ end_date: '2026-10-31', reason: 'Leaving', transfer_to: P.morgan });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ leaver: false, accessEndsOn: '2026-10-31' });
    const g = (await pool.query(`select expires_at from role_grants where person_id = $1 and role_key = 'manager'`, [P.priya])).rows[0];
    expect(g.expires_at.toISOString()).toBe('2026-11-01T00:00:00.000Z'); // midnight London (GMT on 1 Nov)
    expect((await (await as('priya')).get('/api/me')).status).toBe(200); // still working until then
    // Time passes: the appointment ends and the grant expires.
    await pool.query(`update appointments set start_date = '2026-01-01', end_date = current_date - 1 where id = $1`, [PRIYA_VH]);
    await pool.query(`update role_grants set valid_from = now() - interval '2 days', expires_at = now() - interval '1 second' where person_id = $1`, [P.priya]);
    const me = await (await as('priya')).get('/api/me');
    expect(me.status).toBe(403);
    expect(me.body.error).toBe('no_access');
  });
});

describe('audit 2 · corrections and timesheets stay in step', () => {
  it('blocks a correction inside an approved timesheet until an approver returns the timesheet', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const ts = (await sam.post('/api/timesheets').send({ appointment_id: A.samVH, period_start: '2026-10-12', period_end: '2026-10-18' })).body;
    await priya.post(`/api/timesheets/${ts.id}/decide`).send({ approve: true });
    const blocked = await sam.post(`/api/visits/${V.d01}/corrections`).send({ start_local: '2026-10-12T09:00', end_local: '2026-10-12T10:00', reason: 'Left earlier' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/approved timesheet/);
    expect((await priya.post(`/api/timesheets/${ts.id}/decide`).send({ approve: false, note: 'Returning so the 12 Oct visit can be corrected' })).status).toBe(200);
    const audit = (await pool.query(`select detail from audit_log where entity = 'timesheet' and action = 'reject'`)).rows[0].detail;
    expect(audit).toMatchObject({ previous_status: 'approved', previous_approved_minutes: 90, previous_cost_estimate: '20.25' });
    expect((await sam.post(`/api/visits/${V.d01}/corrections`).send({ start_local: '2026-10-12T09:00', end_local: '2026-10-12T10:00', reason: 'Left earlier' })).status).toBe(201);
  });
  it('also blocks moving a visit into a week that already has a submitted timesheet', async () => {
    const sam = await as('sam');
    expect((await sam.post('/api/timesheets').send({ appointment_id: A.samVH, period_start: '2026-10-12', period_end: '2026-10-18' })).status).toBe(201);
    const r = await sam.post(`/api/visits/${V.d03}/corrections`).send({ start_local: '2026-10-13T09:00', end_local: '2026-10-13T09:45', reason: 'Wrong day entered' });
    expect(r.status).toBe(409);
  });
});

describe('audit 3 · replacing a photo', () => {
  it('leaves exactly one stored photo, and it can be read', async () => {
    const sam = await as('sam');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
    expect((await sam.post(`/api/people/${P.sam}/photo`).attach('file', png, 'a.png')).status).toBe(201);
    expect((await sam.post(`/api/people/${P.sam}/photo`).attach('file', png, 'b.png')).status).toBe(201);
    const n = (await pool.query(`select count(*)::int n from files where entity_type = 'person_photo' and entity_id = $1`, [P.sam])).rows[0].n;
    expect(n).toBe(1);
    expect((await sam.get(`/api/people/${P.sam}/photo`)).status).toBe(200);
    expect((await sam.del(`/api/people/${P.sam}/photo`)).status).toBe(200);
    expect((await pool.query(`select count(*)::int n from file_blobs`)).rows[0].n).toBe(0);
  });
});

describe('audit 5, 8, 10', () => {
  it('the database refuses a second live visit overlapping the first (two simultaneous requests cannot both win)', async () => {
    const copy = `insert into visits (person_id, appointment_id, company_id, property_id, entry_mode, status, started_at, ended_at, work_category, summary)
                  select person_id, appointment_id, company_id, property_id, entry_mode, 'submitted', started_at + interval '10 minutes', ended_at, work_category, summary from visits where id = $1`;
    await expect(pool.query(copy, [V.d01])).rejects.toMatchObject({ code: '23P01' });
    await pool.query(`update visits set status = 'cancelled' where id = $1`, [V.d01]);
    await expect(pool.query(copy, [V.d01])).resolves.toBeTruthy(); // cancelled visits do not block
  });
  it('only a manager can reopen a completed task, so a recurring task cannot spawn its next copy twice', async () => {
    const t = (await (await as('priya')).post('/api/tasks').send({ company_id: '00000000-0000-4000-8000-0000000000c1', title: 'Weekly fire check', owner_id: P.sam, due_on: '2026-10-21', recurrence: 'weekly' })).body;
    const sam = await as('sam');
    expect((await sam.patch(`/api/tasks/${t.id}`).send({ status: 'completed' })).status).toBe(200);
    expect((await sam.patch(`/api/tasks/${t.id}`).send({ status: 'in_progress' })).status).toBe(403);
    expect((await pool.query(`select count(*)::int n from tasks where title = 'Weekly fire check'`)).rows[0].n).toBe(2);
  });
  it('keys can only be issued to current staff of the property’s company', async () => {
    const alex = await as('alex');
    const prop = (await pool.query(`select id from properties where company_id = '00000000-0000-4000-8000-0000000000c1' limit 1`)).rows[0].id;
    const key = (await alex.post(`/api/properties/${prop}/keys`).send({ label: 'Front door' })).body;
    expect((await alex.post(`/api/keys/${key.id}/issue`).send({ holder_person_id: P.agent })).status).toBe(400);
    expect((await alex.post(`/api/keys/${key.id}/issue`).send({ holder_person_id: P.sam })).status).toBe(200);
  });
});
