// CSV import, personal data export and anonymisation.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const peopleMap = { email: 'Email', full_name: 'Name', job_title: 'Role', relationship: 'Type', start_date: 'Start' };
const csv = 'Name,Email,Role,Type,Start\n"Jo Bloggs (fictional)",jo@example.test,Cleaner,employee,2026-11-01\nSam again,sam.rivers@example.test,Cleaner,employee,2026-11-01\nBad Row,not-an-email,Cleaner,employee,2026-11-01\nJo twice,JO@example.test,Cleaner,employee,2026-11-01\n';

describe('CSV import', () => {
  it('previews with validation and duplicate detection, then creates only clean rows and never overwrites', async () => {
    const morgan = await as('morgan');
    const prev = (await morgan.post('/api/admin/import/preview').send({ entity: 'people', company_id: C.VH, csv, mapping: peopleMap })).body;
    expect(prev.summary).toEqual({ total: 4, valid: 1, invalid: 1, duplicates: 2 });
    expect(prev.rows[1].duplicate).toMatch(/Already has a profile/);
    const done = (await morgan.post('/api/admin/import/commit').send({ entity: 'people', company_id: C.VH, csv, mapping: peopleMap })).body;
    expect(done).toEqual({ created: 1, skipped_duplicates: 2, invalid: 1 });
    expect((await pool.query(`select full_name from people where email = 'sam.rivers@example.test'`)).rows[0].full_name).toBe('Sam Rivers (fictional)');
    expect((await pool.query(`select count(*)::int n from appointments a join people p on p.id = a.person_id where p.email = 'jo@example.test'`)).rows[0].n).toBe(1);
  });
  it('needs the right permission in that company', async () => {
    const r = await (await as('priya')).post('/api/admin/import/preview').send({ entity: 'properties', company_id: C.VH, csv: 'Ref\nX', mapping: { ref: 'Ref' } });
    expect(r.status).toBe(403);
  });
});

describe('personal data', () => {
  it('a person can export their own data; colleagues without HR rights cannot', async () => {
    const mine = await (await as('sam')).get(`/api/people/${P.sam}/export`);
    expect(mine.status).toBe(200);
    const body = JSON.parse(mine.text);
    expect(body.profile.email).toBe('sam.rivers@example.test');
    expect(body.personal_details[0].home_address).toContain('Fictional Close');
    expect(JSON.stringify(body.supervisions)).not.toContain('overtime'); // restricted management notes are not personal data of the employee's own making; they are excluded
    expect((await (await as('priya')).get(`/api/people/${P.sam}/export`)).status).toBe(404);
  });
  it('anonymises a leaver but keeps business records', async () => {
    const alex = await as('alex');
    expect((await alex.post(`/api/people/${P.sam}/anonymise`).send({ confirm_name: 'Sam Rivers (fictional)' })).status).toBe(400); // not a leaver
    await pool.query(`update appointments set end_date = '2026-10-01', status = 'ended' where person_id = $1`, [P.sam]);
    await pool.query(`update people set status = 'left' where id = $1`, [P.sam]);
    expect((await alex.post(`/api/people/${P.sam}/anonymise`).send({ confirm_name: 'wrong' })).status).toBe(400);
    expect((await alex.post(`/api/people/${P.sam}/anonymise`).send({ confirm_name: 'Sam Rivers (fictional)' })).status).toBe(200);
    const p = (await pool.query('select full_name, email from people where id = $1', [P.sam])).rows[0];
    expect(p.full_name).toBe('Former staff member VWH-0002');
    expect((await pool.query('select count(*)::int n from person_restricted where person_id = $1', [P.sam])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from visits where person_id = $1', [P.sam])).rows[0].n).toBeGreaterThan(0);
  });
});
