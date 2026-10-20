// Stage 5 acceptance tests: training, quizzes, policies and handbooks (spec §41 item 11).
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const FIRE = '00000000-0000-4000-8000-000000000f01', LONE = '00000000-0000-4000-8000-000000000f11', HANDBOOK = '00000000-0000-4000-8000-000000000f12';
const RIGHT = { q1: ['a'], q2: ['t'], q3: ['a', 'b'], q4: 'Photograph it, raise a task and tell the manager the same day.' };

describe('training matrix', () => {
  it('works out each person’s status from requirements and completions', async () => {
    const rows = (await (await as('morgan')).get(`/api/training/matrix?company=${C.VH}`)).body;
    expect(rows.find((r: any) => r.person_id === P.sam)).toMatchObject({ status: 'expiring', renew_on: '2026-11-03' });
    expect(rows.find((r: any) => r.person_id === P.casey)).toMatchObject({ status: 'due', due_on: '2026-11-09' }); // start 12 Oct + 28 days
    const sam = (await (await as('sam')).get('/api/inbox')).body;
    expect(sam.some((i: any) => i.kind === 'training_due')).toBe(true);
  });
  it('staff see only their own row', async () => {
    expect((await (await as('sam')).get(`/api/training/matrix?person=${P.casey}`)).body).toEqual([]);
  });
});

describe('11 · quizzes', () => {
  it('learners never receive the answer key, and opening a course does not complete it', async () => {
    const sam = await as('sam');
    const c = (await sam.get(`/api/courses/${FIRE}`)).body;
    expect(JSON.stringify(c.course.questions)).not.toContain('correct');
    await sam.put(`/api/courses/${FIRE}/progress`).send({ lesson_index: 2 });
    expect((await pool.query('select count(*)::int n from training_records where person_id = $1 and completed_on = current_date', [P.sam])).rows[0].n).toBe(0);
    expect((await sam.post(`/api/courses/${FIRE}/complete`).send({ declaration: true })).status).toBe(400); // this course needs its quiz
  });
  it('auto-marks choices, waits for a trainer to mark written answers, then records completion', async () => {
    const sam = await as('sam');
    const at = (await sam.post(`/api/courses/${FIRE}/attempts`)).body;
    expect(JSON.stringify(at.questions)).not.toContain('correct');
    const sub = (await sam.post(`/api/attempts/${at.id}/submit`).send({ answers: RIGHT })).body;
    expect(sub.status).toBe('awaiting_marking');
    expect((await sam.post(`/api/attempts/${at.id}/mark`).send({ marks: { q4: 2 } })).status).toBe(403); // not your own
    const m = (await (await as('morgan')).post(`/api/attempts/${at.id}/mark`).send({ marks: { q4: 2 } })).body;
    expect(m).toMatchObject({ passed: true, score: 6, max: 6 });
    const rec = (await pool.query(`select count(*)::int n from training_records where person_id = $1 and attempt_id = $2`, [P.sam, at.id])).rows[0].n;
    expect(rec).toBe(1);
  });
  it('enforces the attempt limit', async () => {
    const sam = await as('sam');
    for (let i = 0; i < 3; i++) {
      const at = (await sam.post(`/api/courses/${FIRE}/attempts`)).body;
      await sam.post(`/api/attempts/${at.id}/submit`).send({ answers: {} });
    }
    expect((await sam.post(`/api/courses/${FIRE}/attempts`)).status).toBe(409);
  });
  it('ignores answers sent after the time limit and marks the last answers saved in time', async () => {
    const sam = await as('sam');
    const at = (await sam.post(`/api/courses/${FIRE}/attempts`)).body;
    await sam.put(`/api/attempts/${at.id}/answers`).send({ answers: { q1: ['b'] } });
    await pool.query(`update quiz_attempts set deadline = now() - interval '5 minutes' where id = $1`, [at.id]);
    expect((await sam.put(`/api/attempts/${at.id}/answers`).send({ answers: RIGHT })).status).toBe(409);
    expect((await sam.post(`/api/attempts/${at.id}/submit`).send({ answers: RIGHT })).body.late).toBe(true);
    expect((await pool.query('select answers from quiz_attempts where id = $1', [at.id])).rows[0].answers).toEqual({ q1: ['b'] });
  });
  it('published versions are fixed; a new version keeps earlier attempts on the old one', async () => {
    const sam = await as('sam'), alex = await as('alex');
    const old = (await sam.post(`/api/courses/${FIRE}/attempts`)).body;
    expect((await alex.patch(`/api/courses/${FIRE}`).send({ title: 'Changed' })).status).toBe(403);
    const v2 = (await alex.post(`/api/courses/${FIRE}/new-version`)).body;
    expect((await alex.patch(`/api/courses/${v2.id}`).send({ title: 'Fire safety awareness v2 (fictional)' })).status).toBe(200);
    expect((await alex.post(`/api/courses/${v2.id}/publish`)).status).toBe(200);
    const rows = (await pool.query(`select version, status from courses where root_id = $1 order by version`, [FIRE])).rows;
    expect(rows).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'published' }]);
    expect((await pool.query('select course_id from quiz_attempts where id = $1', [old.id])).rows[0].course_id).toBe(FIRE);
  });
  it('a course without a quiz completes only after the last lesson and a declaration', async () => {
    const morgan = await as('morgan'), sam = await as('sam');
    const c = (await morgan.post('/api/courses').send({ company_id: C.VH, title: 'Key handling (fictional)' })).body;
    expect((await morgan.patch(`/api/courses/${c.id}`).send({ lessons: [{ title: 'Signing keys out', body: 'Always sign keys out.' }, { title: 'Returning keys', body: 'Return keys the same day.' }] })).status).toBe(200);
    expect((await morgan.patch(`/api/courses/${c.id}`).send({ lessons: [{ title: 'Photo', body: 'x', image_file_id: '00000000-0000-4000-8000-000000000999' }] })).status).toBe(400); // image without alt text
    expect((await morgan.post(`/api/courses/${c.id}/publish`)).status).toBe(200);
    expect((await sam.post(`/api/courses/${c.id}/complete`).send({ declaration: true })).status).toBe(400);
    await sam.put(`/api/courses/${c.id}/progress`).send({ lesson_index: 1 });
    expect((await sam.post(`/api/courses/${c.id}/complete`).send({ declaration: true })).status).toBe(201);
  });
});

describe('11 · policies and handbooks', () => {
  it('records supplied, opened and acknowledged separately', async () => {
    const sam = await as('sam');
    const lib = (await sam.get('/api/policies')).body;
    const lone = lib.published.find((p: any) => p.id === LONE);
    expect(lone.receipt).toMatchObject({ opened_at: null, acknowledged_at: null });
    await sam.get(`/api/policies/${LONE}?company=${C.VH}`);
    const r1 = (await pool.query('select opened_at, acknowledged_at from policy_receipts where policy_id = $1 and person_id = $2', [LONE, P.sam])).rows[0];
    expect(r1.opened_at).not.toBeNull();
    expect(r1.acknowledged_at).toBeNull();
    await sam.post(`/api/policies/${LONE}/acknowledge`).send({ company_id: C.VH });
    const ex = await (await as('priya')).post(`/api/policies/${LONE}/explained`).send({ company_id: C.VH, person_id: P.sam, note: 'Talked it through at supervision.' });
    expect(ex.status).toBe(200);
    const r2 = (await pool.query('select acknowledged_at, explained_at from policy_receipts where policy_id = $1 and person_id = $2', [LONE, P.sam])).rows[0];
    expect(r2.acknowledged_at).not.toBeNull();
    expect(r2.explained_at).not.toBeNull();
  });
  it('a draft needs someone else to approve it; staff never see drafts; approved versions stay fixed', async () => {
    const morgan = await as('morgan'), alex = await as('alex'), sam = await as('sam');
    const d = (await morgan.post('/api/policies').send({ company_id: C.VH, kind: 'policy', title: 'Key safe policy (fictional)' })).body;
    await morgan.patch(`/api/policies/${d.id}`).send({ chapters: [{ title: 'Rule', body: 'Codes are never written down.' }], effective_on: '2026-11-01', review_on: '2027-11-01', revision_summary: 'New' });
    expect((await sam.get(`/api/policies/${d.id}?company=${C.VH}`)).status).toBe(404);
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'company_admin', $2, 'test')`, [P.morgan, C.VH]);
    expect((await (await as('morgan')).post(`/api/policies/${d.id}/approve`).send({ company_id: C.VH })).status).toBe(403); // author
    const ok = await alex.post(`/api/policies/${d.id}/approve`).send({ company_id: C.VH });
    expect(ok.status).toBe(200);
    expect(ok.body.supplied).toBeGreaterThan(0);
    expect((await morgan.patch(`/api/policies/${d.id}`).send({ title: 'Changed' })).status).toBe(403);
    const v2 = (await morgan.post(`/api/policies/${d.id}/new-version`)).body;
    expect((await morgan.patch(`/api/policies/${v2.id}`).send({ revision_summary: 'Clarified wording' })).status).toBe(200);
    expect((await sam.get(`/api/policies/${d.id}?company=${C.VH}`)).body.policy.chapters[0].body).toMatch(/never written/);
  });
  it('a shared handbook reaches a company only after that company adopts it', async () => {
    const sam = await as('sam');
    const before = (await sam.get('/api/policies')).body.published.filter((p: any) => p.id === HANDBOOK).map((p: any) => p.company_code);
    expect(before).toEqual(['VH']);
    expect((await (await as('robin')).post(`/api/policies/${HANDBOOK}/approve`).send({ company_id: C.WHM, note: 'Adopted unchanged' })).status).toBe(200);
    const after = (await sam.get('/api/policies')).body.published.filter((p: any) => p.id === HANDBOOK).map((p: any) => p.company_code).sort();
    expect(after).toEqual(['VH', 'WHM']);
    const hits = (await sam.get('/api/policies/search?q=grievance')).body;
    expect(hits[0].chapters[0].title).toBe('Getting help');
  });
});

describe('training KPI', () => {
  it('reports required training that is up to date', async () => {
    const r = (await (await as('morgan')).get(`/api/kpis?company=${C.VH}&month=2026-10`)).body;
    const k = r[0].kpis.find((x: any) => x.key === 'training_current');
    expect(k).toMatchObject({ numerator: 1 });
    expect(k.denominator).toBeGreaterThan(1);
  });
});
