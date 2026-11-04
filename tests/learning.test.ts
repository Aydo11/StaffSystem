// Learning platform stage 1: course details, lesson progress and time, notes and bookmarks, the learner dashboard.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const FIRE = '00000000-0000-4000-8000-000000000f01';
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

async function course(details: Record<string, unknown> = {}) {
  const morgan = await as('morgan');
  const c = (await morgan.post('/api/courses').send({ company_id: C.VH, title: 'Record keeping basics (fictional)' })).body;
  const lessons = [
    { module: 'Writing notes', title: 'Facts not opinions', body: `## Why it matters\n${words(400)}`, key_points: ['Write what you saw'],
      checks: [{ prompt: 'Which is a fact?', options: [{ text: 'He seemed fine', correct: false, feedback: 'An opinion' }, { text: 'He attended at 10:00', correct: true }] }] },
    { module: 'Writing notes', title: 'Correcting a note', body: 'Never delete; add a dated correction.' },
    { module: 'Sharing', title: 'Who may read notes', body: 'Only people who need to know.' },
  ];
  expect((await morgan.patch(`/api/courses/${c.id}`).send({ lessons, category: 'fundamentals', difficulty: 'foundation', duration_minutes: 40,
    roles: ['support_worker'], objectives: ['Write factual notes'], source_refs: [{ label: 'UK GDPR (ICO guide)', url: 'https://ico.org.uk/' }], ...details })).status).toBe(200);
  return { morgan, c };
}

describe('course details and review', () => {
  it('content pending a specialist review cannot be published until someone approves it', async () => {
    const { morgan, c } = await course();
    await pool.query(`update courses set review_status = 'pending_review' where id = $1`, [c.id]);
    expect((await morgan.post(`/api/courses/${c.id}/publish`)).status).toBe(409);
    expect((await (await as('sam')).post(`/api/courses/${c.id}/approve-content`).send({ note: 'Checked by me' })).status).toBe(404); // a draft is hidden from staff
    expect((await morgan.post(`/api/courses/${c.id}/approve-content`).send({ note: 'x' })).status).toBe(400);
    expect((await morgan.post(`/api/courses/${c.id}/approve-content`).send({ note: 'Checked against the ICO guide by the DPO' })).status).toBe(200);
    expect((await morgan.post(`/api/courses/${c.id}/publish`)).status).toBe(200);
    const list = (await (await as('sam')).get('/api/courses')).body.find((x: any) => x.id === c.id);
    expect(list).toMatchObject({ category: 'fundamentals', difficulty: 'foundation', duration_minutes: 40, module_count: 2, my_lessons_done: 0, mandatory: false });
    // A new version carries the details over.
    const v2 = (await morgan.post(`/api/courses/${c.id}/new-version`)).body;
    expect((await pool.query('select category, roles, objectives from courses where id = $1', [v2.id])).rows[0]).toMatchObject({ category: 'fundamentals', roles: ['support_worker'] });
  });
});

describe('lesson progress', () => {
  it('a lesson is done only after enough time on it, and time counts only from beats', async () => {
    const { morgan, c } = await course();
    await morgan.post(`/api/courses/${c.id}/publish`);
    const sam = await as('sam');
    expect((await sam.put(`/api/courses/${c.id}/lessons/0`).send({ action: 'open' })).status).toBe(200);
    expect((await sam.put(`/api/courses/${c.id}/lessons/0`).send({ action: 'complete' })).status).toBe(409); // 400 words need ~24 s
    expect((await sam.put(`/api/courses/${c.id}/lessons/0`).send({ action: 'beat' })).body.seconds).toBe(0); // too soon after opening
    await pool.query(`update lesson_progress set opened_at = now() - interval '40 seconds', last_beat_at = now() - interval '40 seconds' where course_id = $1`, [c.id]);
    expect((await sam.put(`/api/courses/${c.id}/lessons/0`).send({ action: 'beat' })).body.seconds).toBe(30); // capped at 30 s a beat
    const done = (await sam.put(`/api/courses/${c.id}/lessons/0`).send({ action: 'complete' })).body;
    expect(done.completed_at).toBeTruthy();
    expect((await sam.put(`/api/courses/${c.id}/lessons/9`).send({ action: 'open' })).status).toBe(400);
    const d = (await sam.get(`/api/courses/${c.id}`)).body;
    expect(d.lessons).toHaveLength(1);
    expect(d.min_seconds[0]).toBe(25);
    expect(d.course.lessons[0].checks[0].options[1].correct).toBe(true); // practice checks show their answers
  });

  it('notes and bookmarks belong to the learner only', async () => {
    const { morgan, c } = await course();
    await morgan.post(`/api/courses/${c.id}/publish`);
    const sam = await as('sam');
    const n = (await sam.post(`/api/courses/${c.id}/notes`).send({ lesson_index: 1, body: 'Ask about the correction template' })).body;
    await sam.put(`/api/courses/${c.id}/bookmarks/2`).send({ on: true });
    expect((await sam.get(`/api/courses/${c.id}`)).body).toMatchObject({ notes: [{ body: 'Ask about the correction template' }], bookmarks: [2] });
    expect((await morgan.get(`/api/courses/${c.id}`)).body).toMatchObject({ notes: [], bookmarks: [] });
    expect((await morgan.del(`/api/learning-notes/${n.id}`)).status).toBe(404);
    expect((await sam.del(`/api/learning-notes/${n.id}`)).status).toBe(200);
  });
});

describe('learner dashboard', () => {
  it('shows assigned training, courses in progress and recommendations from real records', async () => {
    const { morgan, c } = await course();
    await morgan.post(`/api/courses/${c.id}/publish`);
    await pool.query(`update appointments set job_role_key = 'support_worker' where person_id = $1`, [P.sam]);
    const sam = await as('sam');
    let me = (await sam.get('/api/learning/me')).body;
    expect(me.kpis).toMatchObject({ completed: 1, in_progress: 0, assigned: me.matrix.length });
    expect(me.recommended.map((r: any) => r.id)).toContain(c.id); // suits the support worker role
    await sam.put(`/api/courses/${c.id}/lessons/1`).send({ action: 'open' });
    await pool.query(`update lesson_progress set opened_at = now() - interval '1 minute' where course_id = $1`, [c.id]);
    await sam.put(`/api/courses/${c.id}/lessons/1`).send({ action: 'complete' });
    me = (await sam.get('/api/learning/me')).body;
    expect(me.kpis.in_progress).toBe(1);
    expect(me.continuing[0]).toMatchObject({ id: c.id, done: 1, lessons: 3, modules: 2, modules_done: 0 });
    expect(me.recommended.map((r: any) => r.id)).not.toContain(c.id);
    expect(me.matrix.find((m: any) => m.course_id === FIRE)).toBeTruthy();
  });
});
