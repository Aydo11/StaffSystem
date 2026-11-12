// Certificates for Hub courses: a trainer gives one; the person and training viewers can open it.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);

describe('certificates', () => {
  it('a trainer gives a certificate that counts as a completion and can be opened', async () => {
    const course = (await pool.query(`select root_id, title from courses where status = 'published' and (company_id is null or company_id = $1) limit 1`, [C.VH])).rows[0];
    const morgan = await as('morgan'); // HR: training.manage
    expect((await (await as('sam')).post('/api/training/certificates').send({ company_id: C.VH, person_id: P.casey, course_root_id: course.root_id, completed_on: '2026-01-05' })).status).toBe(403);
    expect((await morgan.post('/api/training/certificates').send({ company_id: C.VH, person_id: P.sam, course_root_id: course.root_id, completed_on: '2999-01-01' })).status).toBe(400);
    const r = await morgan.post('/api/training/certificates').send({ company_id: C.VH, person_id: P.sam, course_root_id: course.root_id, completed_on: '2026-01-05' });
    expect(r.status).toBe(201);
    const cert = (await (await as('sam')).get(`/api/training/certificates/${r.body.id}`)).body;
    expect(cert).toMatchObject({ title: course.title, completed_on: '2026-01-05', issued_by_name: expect.any(String) });
    expect(cert.company.name).toBeTruthy();
    expect((await (await as('casey')).get(`/api/training/certificates/${r.body.id}`)).status).toBe(404); // colleague without training.view_all
  });
});
