// Correcting roles in place, and taking someone off the Hub in one step.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);

describe('correcting and removing', () => {
  it('a role manager can correct the dates of a role, including an ended one', async () => {
    const alex = await as('alex');
    const bad = await alex.patch(`/api/appointments/${A.samVH}`).send({ start_date: '2026-03-01', end_date: '2026-02-01' });
    expect(bad.status).toBe(400);
    const r = await alex.patch(`/api/appointments/${A.samVH}`).send({ start_date: '2025-01-06', end_date: '2025-06-30' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ended');
    const back = await alex.patch(`/api/appointments/${A.samVH}`).send({ end_date: null });
    expect(back.body.status).toBe('active');
    expect((await pool.query('select status from people where id = $1', [P.sam])).rows[0].status).toBe('active');
  });

  it('removing a person ends every role, unassigns their tasks and signs them out', async () => {
    const alex = await as('alex');
    await pool.query(`insert into tasks (company_id, title, owner_id, created_by) values ($1, 'Fictional open task', $2, $3)`, [C.VH, P.sam, P.alex]);
    expect((await (await as('sam')).post(`/api/people/${P.alex}/remove`).send({ end_date: '2026-01-01', reason: 'Not allowed' })).status).toBe(403);
    const today = (await pool.query(`select (now() at time zone 'Europe/London')::date::text d`)).rows[0].d;
    const r = await alex.post(`/api/people/${P.sam}/remove`).send({ end_date: today, reason: 'Left the company' });
    expect(r.status).toBe(200);
    expect(r.body.rolesEnded).toBeGreaterThan(0);
    expect(r.body.unassignedTasks).toBeGreaterThan(0);
    expect((await pool.query(`select count(*)::int n from appointments where person_id = $1 and status <> 'ended'`, [P.sam])).rows[0].n).toBe(0);
    expect((await pool.query('select status from people where id = $1', [P.sam])).rows[0].status).toBe('left');
    expect((await pool.query('select count(*)::int n from sessions where person_id = $1', [P.sam])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int n from tasks where owner_id = $1 and status <> 'completed'`, [P.sam])).rows[0].n).toBe(0);
  });
});
