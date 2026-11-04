// Learning platform stages 2–3: question types, marking, feedback, approval of completion, course-pack import.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

const QUESTIONS = [
  { id: 'q1', type: 'single', prompt: 'Who decides if a safeguarding enquiry is needed?', marks: 1, explanation: 'The local authority decides under section 42.', lesson_ref: 1,
    options: [{ id: 'a', text: 'The local authority', correct: true }, { id: 'b', text: 'The support worker', correct: false }] },
  { id: 'q2', type: 'matching', prompt: 'Match each term to its meaning', marks: 2,
    pairs: [{ id: 'p1', left: 'Licence', right: 'Permission to occupy' }, { id: 'p2', left: 'Tenancy', right: 'An interest in the property' }, { id: 'p3', left: 'Support plan', right: 'Agreed goals and help' }] },
  { id: 'q3', type: 'ordering', prompt: 'Put the referral steps in order', marks: 2,
    items: [{ id: 's1', text: 'Referral received' }, { id: 's2', text: 'Assessment' }, { id: 's3', text: 'Move in' }] },
  { id: 'q4', type: 'fill_blank', prompt: 'The Mental Capacity Act has ___ principles.', marks: 1, accepted: ['five', '5'], lesson_ref: 0 },
  { id: 'q5', type: 'file', prompt: 'Upload a support note you have written (anonymised).', marks: 2 },
  { id: 'q6', type: 'observation', prompt: 'Observed: completes a welfare check following the procedure.', marks: 2 },
];
async function course(extra: Record<string, unknown> = {}) {
  const morgan = await as('morgan');
  const c = (await morgan.post('/api/courses').send({ company_id: C.VH, title: 'Assessment test (fictional)' })).body;
  const r = await morgan.patch(`/api/courses/${c.id}`).send({ lessons: [{ title: 'Capacity', body: 'Five principles.' }, { title: 'Safeguarding', body: 'Section 42.' }],
    questions: QUESTIONS, pass_mark: 70, show_feedback: 'answers', ...extra });
  expect(r.status).toBe(200);
  expect((await morgan.post(`/api/courses/${c.id}/publish`)).status).toBe(200);
  return { morgan, c };
}

describe('question types and marking', () => {
  it('rejects badly built questions', async () => {
    const morgan = await as('morgan');
    const c = (await morgan.post('/api/courses').send({ company_id: C.VH, title: 'Broken (fictional)' })).body;
    for (const q of [{ id: 'x', type: 'matching', prompt: 'Match these', pairs: [{ id: 'a', left: 'A', right: 'B' }] },
      { id: 'x', type: 'fill_blank', prompt: 'Fill this in', accepted: [] }, { id: 'x', type: 'ordering', prompt: 'Order these', items: [] },
      { id: 'x', type: 'written', prompt: 'Explain', options: [{ id: 'a', text: 'A', correct: true }] }])
      expect((await morgan.patch(`/api/courses/${c.id}`).send({ questions: [q] })).status).toBe(400);
  });

  it('hides answers, marks automatic types, waits for a trainer on evidence and observation, then explains the result', async () => {
    const { morgan, c } = await course();
    const sam = await as('sam');
    const at = (await sam.post(`/api/courses/${c.id}/attempts`)).body;
    const text = JSON.stringify(at.questions);
    for (const secret of ['"correct"', 'accepted', 'explanation', 'lesson_ref']) expect(text).not.toContain(secret);
    const m = at.questions.find((q: any) => q.id === 'q2');
    expect(m.pairs.every((p: any) => !('right' in p))).toBe(true); // which right-hand text goes with which is never sent
    expect(m.rights.map((r: any) => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(at.questions.find((q: any) => q.id === 'q3').items).toHaveLength(3);

    // Evidence is uploaded, and the browser cannot overwrite it with its own value.
    const f = (await sam.post(`/api/attempts/${at.id}/files/q5`).attach('file', png, 'note.png')).body;
    expect((await sam.put(`/api/attempts/${at.id}/answers`).send({ answers: { q5: 'not-a-file' } })).status).toBe(200);
    const sub = (await sam.post(`/api/attempts/${at.id}/submit`).send({ answers: { q1: ['b'], q2: ['p1', 'p2', 'p3'], q3: ['s1', 's2', 's3'], q4: ' FIVE ', q5: 'x' } })).body;
    expect(sub.status).toBe('awaiting_marking');
    const stored = (await pool.query('select answers, auto_marks from quiz_attempts where id = $1', [at.id])).rows[0];
    expect(stored).toMatchObject({ auto_marks: 5, answers: { q5: f.id } }); // q1 wrong; matching 2 + ordering 2 + fill 1
    expect((await morgan.get(`/api/files/${f.id}`)).status).toBe(200); // the marker can open the evidence
    expect((await (await as('taylor')).get(`/api/files/${f.id}`)).status).toBe(404);

    expect((await morgan.post(`/api/attempts/${at.id}/mark`).send({ marks: { q5: 2 } })).status).toBe(400); // observation not marked
    const marked = (await morgan.post(`/api/attempts/${at.id}/mark`).send({ marks: { q5: 2, q6: 1 }, feedback: { q6: 'Did not record the time of the check.' } })).body;
    expect(marked).toMatchObject({ score: 8, max: 10, passed: true });
    const view = (await sam.get(`/api/attempts/${at.id}`)).body;
    expect(view.review.items.find((x: any) => x.id === 'q1')).toMatchObject({ right: false, explanation: 'The local authority decides under section 42.', answer: 'The local authority', lesson: 'Safeguarding' });
    expect(view.review.items.find((x: any) => x.id === 'q6')).toMatchObject({ marks: 1, of: 2, comment: 'Did not record the time of the check.' });
    expect(view.review.revisit).toEqual(['Safeguarding']);
  });

  it('a pass on a course that needs approval counts only once someone else approves it', async () => {
    const { morgan, c } = await course({ approval_required: true, questions: [QUESTIONS[0], QUESTIONS[3]], show_feedback: 'none' });
    const sam = await as('sam');
    const at = (await sam.post(`/api/courses/${c.id}/attempts`)).body;
    const sub = (await sam.post(`/api/attempts/${at.id}/submit`).send({ answers: { q1: ['a'], q4: '5' } })).body;
    expect(sub).toMatchObject({ status: 'awaiting_approval', passed: true });
    expect(sub.review).toBeUndefined();
    const records = async () => (await pool.query('select count(*)::int n from training_records where attempt_id = $1', [at.id])).rows[0].n;
    expect(await records()).toBe(0);
    expect((await morgan.get('/api/marking')).body.map((m: any) => m.status)).toContain('awaiting_approval');
    expect((await sam.post(`/api/attempts/${at.id}/approve`).send({ approve: true, note: 'Self' })).status).not.toBe(200);
    expect((await morgan.post(`/api/attempts/${at.id}/approve`).send({ approve: true, note: 'Observed on shift and checked the quiz.' })).status).toBe(200);
    expect(await records()).toBe(1);
  });
});

describe('course packs', () => {
  const pack = (titles: string[]) => ({ company_id: C.VH, pack: 'Starter library (test)', courses: titles.map((t) => ({ title: t, summary: 'S', category: 'fundamentals', difficulty: 'foundation', duration_minutes: 30,
    objectives: ['One'], lessons: [{ module: 'M', title: 'L', body: 'Text' }], questions: [QUESTIONS[0]], pass_mark: 80, shuffle_questions: true })) });

  it('adds courses as drafts waiting for review, never twice, and only for people who manage training', async () => {
    const morgan = await as('morgan');
    expect((await (await as('sam')).post('/api/courses/import').send(pack(['A (fictional)']))).status).toBe(403);
    expect((await morgan.post('/api/courses/import').send({ ...pack(['A (fictional)']), courses: [{ title: 'No lessons' }] })).status).toBe(400);
    const r = (await morgan.post('/api/courses/import').send(pack(['A (fictional)', 'B (fictional)']))).body;
    expect(r).toEqual({ added: ['A (fictional)', 'B (fictional)'], skipped: [] });
    expect((await morgan.post('/api/courses/import').send(pack(['B (fictional)', 'C (fictional)']))).body).toEqual({ added: ['C (fictional)'], skipped: ['B (fictional)'] });
    const rows = (await pool.query(`select status, review_status, imported_from, shuffle_questions from courses where title like '_ (fictional)' order by title`)).rows;
    expect(rows).toHaveLength(3);
    for (const x of rows) expect(x).toMatchObject({ status: 'draft', review_status: 'pending_review', imported_from: 'Starter library (test)', shuffle_questions: true });
    expect((await (await as('sam')).get('/api/courses')).body.filter((c: any) => c.title.endsWith('(fictional)') && c.title.length < 16)).toHaveLength(0); // drafts are hidden from staff
  });
});
