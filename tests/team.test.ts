// Staff assignments: support managers manage only the staff assigned to them (migration 046, routes/team.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, C, P, pool, resetDb, V } from './helpers.ts';

beforeEach(async () => {
  await resetDb();
  // Casey becomes a support manager in VH; Sam (a support worker there) has a visit waiting for review (seed d03).
  await pool.query(`update appointments set job_role_key = 'support_manager' where id = $1`, [A.casey]);
});

describe('staff assignments', () => {
  it('only people who can assign may assign, and only support staff to a manager or support manager', async () => {
    const priya = await as('priya'); // manager in VH
    expect((await (await as('sam')).post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.sam] })).status).toBe(403);
    expect((await (await as('jordan')).post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.sam] })).status).toBe(403); // manager elsewhere
    expect((await priya.post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.sam, person_ids: [P.casey] })).status).toBe(400); // Sam is not a manager
    expect((await priya.post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.priya] })).status).toBe(400); // a manager is not support staff
    expect((await priya.post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.sam, P.sam] })).body).toEqual({ added: [P.sam] });
    expect((await priya.post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.sam] })).body).toEqual({ added: [] }); // never twice
    const board = (await priya.get('/api/team')).body;
    expect(board.managers.find((m: any) => m.id === P.casey).staff.map((s: any) => s.id)).toEqual([P.sam]);
    expect(board.staff.some((s: any) => s.id === P.priya)).toBe(false);
    // Maintenance and cleaning staff can be assigned too.
    await pool.query(`update appointments set job_role_key = 'maintenance_operative' where id = $1`, [A.samVH]);
    expect((await priya.get('/api/team')).body.staff.some((s: any) => s.id === P.sam)).toBe(true);
  });

  it('a support manager sees and approves their assigned staff’s work, and loses it when the assignment ends', async () => {
    const casey = await as('casey');
    expect((await casey.get(`/api/visits/${V.d03}`)).status).toBe(404);
    const priya = await as('priya');
    await priya.post('/api/staff-assignments').send({ company_id: C.VH, manager_id: P.casey, person_ids: [P.sam] });
    const c2 = await as('casey');
    const me = (await c2.get('/api/me')).body;
    expect(me.team[C.VH]).toEqual([P.sam]);
    const v = (await c2.get(`/api/visits/${V.d03}`)).body;
    expect(v.can.decide).toBe(true);
    expect((await c2.get('/api/inbox')).body.some((i: any) => i.kind === 'visit_review' && i.link === `/visits/${V.d03}`)).toBe(true);
    const team = (await c2.get('/api/team')).body;
    expect(team.members.map((m: any) => m.id)).toEqual([P.sam]);
    expect(team.members[0].visits_to_review).toBeGreaterThan(0);
    expect(team.canAssign).toEqual([]); // support managers do not assign
    expect((await c2.post(`/api/visits/${V.d03}/decide`).send({ approve: true })).status).toBe(200);

    const id = (await pool.query('select id from staff_assignments where manager_id = $1', [P.casey])).rows[0].id;
    expect((await c2.post(`/api/staff-assignments/${id}/end`)).status).toBe(404); // cannot remove themselves from the board
    expect((await priya.post(`/api/staff-assignments/${id}/end`)).status).toBe(200);
    expect((await c2.get(`/api/visits/${V.d03}`)).status).toBe(404); // access is reloaded on every request
    const fresh = await pool.query('select count(*)::int n from staff_assignments where ended_at is null');
    expect(fresh.rows[0].n).toBe(0);
  });
});

describe('qualifications', () => {
  it('are added without a verification step', async () => {
    const sam = await as('sam');
    expect((await sam.post(`/api/people/${P.sam}/qualifications`).send({ title: 'Level 3 Diploma in Adult Care (fictional)' })).status).toBe(201);
    const q = (await pool.query(`select id from qualifications where title like 'Level 3 Diploma%'`)).rows[0];
    expect((await (await as('priya')).post(`/api/qualifications/${q.id}/verify`)).status).toBe(404);
  });
});

describe('clearance exemption', () => {
  it('directors and administrators do not need deployment clearance', async () => {
    const morgan = await as('morgan'); // HR in every company
    expect((await morgan.get(`/api/people/${P.alex}`)).body.clearanceExempt).toContain(C.VH); // super administrator
    expect((await morgan.get(`/api/people/${P.sam}`)).body.clearanceExempt).toEqual([]);
    await pool.query(`update appointments set job_role_key = 'director' where id = $1`, [A.samVH]);
    expect((await morgan.get(`/api/people/${P.sam}`)).body.clearanceExempt).toEqual([C.VH]); // director in VH only
    const r = await pool.query('select clearance_exempt($1, $2) as vh, clearance_exempt($1, $3) as whm', [P.sam, C.VH, C.WHM]);
    expect(r.rows[0]).toEqual({ vh: true, whm: false });
  });
});
