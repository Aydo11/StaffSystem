// Migration 048: the Oct–Nov 2026 complaints and repairs register, matched to Hub properties and staff by name.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { C, pool, resetDb } from './helpers.ts';

const sql = readFileSync(new URL('../db/migrations/048_registers_oct_nov_2026.sql', import.meta.url), 'utf8');

beforeEach(resetDb);

describe('register import (migration 048)', () => {
  it('adds every case once, at the right property, with the named staff', async () => {
    const prop = async (ref: string) => (await pool.query(`insert into properties (company_id, ref, name, address_line1, city, postcode, status)
      values ($1, $2, $2, 'x', 'Birmingham', 'B1 1AA', 'active') returning id`, [C.VH, ref])).rows[0].id;
    const sha = await prop('VH-SHA005'); await prop('VH-ARTHUR-6');
    const person = async (full: string, pref: string | null = null) => (await pool.query(`insert into people (email, full_name, preferred_name, staff_ref, status)
      values ($1, $2, $3, $1, 'active') returning id`, [`${full.replace(/\W/g, '')}@x.test`, full, pref])).rows[0].id;
    const yvan = await person('Yvan Ruronono'); const bash = await person('Bash Chowdhury'); const phil = await person('Phillip Smith', 'Phil');
    await pool.query(sql); await pool.query(sql); // the second run adds nothing

    const c = (await pool.query(`select count(*)::int n, count(*) filter (where stage = 'closed' and resolution is not null)::int closed,
      count(*) filter (where escalated)::int s2 from property_complaints where company_id = $1`, [C.VH])).rows[0];
    expect(c).toEqual({ n: 21, closed: 21, s2: 3 });
    const one = (await pool.query(`select c.owner_id, c.raised_by, c.title, c.summary from property_complaints c join properties p on p.id = c.property_id where p.ref = 'VH-ARTHUR-6'`)).rows[0];
    expect(one).toMatchObject({ owner_id: yvan, raised_by: bash, title: 'Cleaning rota unclear' }); // "Yvan Ruronona" and "Bash C" in the register
    expect(one.summary).toContain('Received by Bash C');
    expect((await pool.query(`select owner_id from property_complaints where title = 'Unclear recycling arrangements'`)).rows[0].owner_id).toBe(phil);
    expect((await pool.query('select count(*)::int n from property_complaints where property_id = $1', [sha])).rows[0].n).toBe(2); // Shakespear + Shakespeare

    const r = (await pool.query(`select title, assignee_id, status, completed_on::text, work_description from repairs where property_id = $1 order by reported_on`, [sha])).rows;
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Bedroom curtain track bracket loose', assignee_id: yvan, status: 'closed', completed_on: '2026-10-29' });
    expect((await pool.query(`select count(*)::int n from repair_updates u join repairs r on r.id = u.repair_id where r.property_id = $1`, [sha])).rows[0].n).toBe(8);
  });
});
