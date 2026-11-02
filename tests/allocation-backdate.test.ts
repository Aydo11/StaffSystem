// Allocations can start on an earlier day (owner request), but never before the role itself started.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);

describe('backdated allocation', () => {
  it('can start on an earlier day, but not before the role started', async () => {
    const alex = await as('alex');
    const role = (await pool.query('select start_date::text s from appointments where id = $1', [A.samVH])).rows[0].s;
    const prop = (await pool.query(`select p.id from properties p where p.company_id = $1 and not exists (select 1 from appointment_properties x where x.property_id = p.id and x.appointment_id = $2) limit 1`, [C.VH, A.samVH])).rows[0].id;
    await pool.query(`insert into clearance_decisions (person_id, company_id, status, evidence_summary, decided_by) values ($1, $2, 'cleared', 'Fictional', $3)`, [P.sam, C.VH, P.alex]);
    expect((await alex.post(`/api/appointments/${A.samVH}/properties`).send({ property_id: prop, from_date: '2000-01-01' })).status).toBe(400);
    const r = await alex.post(`/api/appointments/${A.samVH}/properties`).send({ property_id: prop, from_date: role });
    expect(r.status).toBe(201);
    expect(r.body.from_date).toBe(role);
  });
});
