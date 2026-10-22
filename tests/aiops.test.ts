// AI in operations: leave handovers share out tasks (AI-matched when on, rules otherwise) and the daily report.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAiCaller } from '../server/routes/ai.ts';
import { as, C, P, pool, resetDb } from './helpers.ts';

let reply: (prompt: string) => any = () => null;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-not-used';
  setAiCaller(async ({ prompt }) => ({ output: reply(prompt), input_tokens: 500, output_tokens: 100 }));
});
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });
beforeEach(async () => { await resetDb(); reply = () => null; });

const samTasks = async () => (await pool.query(`select id, title, owner_id from tasks where company_id = $1 and title in ('Test fire alarm call point','Photograph damp patch in hallway') order by title`, [C.VH])).rows;
async function leaveForSam(note?: string) {
  await pool.query(`update tasks set due_on = current_date + 1 where company_id = $1 and owner_id = $2`, [C.VH, P.sam]);
  const r = await (await as('sam')).post('/api/leave').send({ company_id: C.VH, kind: 'annual', start_date: new Date().toISOString().slice(0, 10), end_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), handover_note: note });
  expect(r.status).toBe(201);
  return (await as('alex')).post(`/api/leave/${r.body.id}/decide`).send({ decision: 'approved' });
}

describe('leave handover', () => {
  it('without AI, approving leave hands each open task to a working colleague and tells them', async () => {
    const before = await samTasks();
    expect(before.every((t) => t.owner_id === P.sam)).toBe(true);
    const r = await leaveForSam('Fire alarm test is weekly.');
    expect(r.status).toBe(200);
    expect(r.body.handover.length).toBeGreaterThanOrEqual(2);
    const after = await samTasks();
    expect(after.every((t) => t.owner_id && t.owner_id !== P.sam)).toBe(true);
    expect(r.body.handover.every((h: any) => !h.by_ai)).toBe(true);
    const to = after[0].owner_id;
    expect((await pool.query(`select 1 from notifications where person_id = $1 and title like 'You are covering%'`, [to])).rowCount).toBeGreaterThan(0);
    expect((await pool.query(`select body from task_comments where task_id = $1`, [after[0].id])).rows[0].body).toMatch(/Handed over from/);
    expect((await (await as('sam')).get('/api/leave')).body.mine[0].handed_over).toBe(r.body.handover.length);
  });

  it('with AI on, follows Claude’s choice when it names an available colleague, and falls back when it does not', async () => {
    await pool.query(`update ai_settings set enabled = true where company_id = $1`, [C.VH]);
    const [damp, fire] = await samTasks();
    let prompt = '';
    reply = (p) => { prompt = p; return { assignments: [{ task_id: fire.id, person_id: P.priya, reason: 'The note says Priya covers fire safety.' }, { task_id: damp.id, person_id: P.sam, reason: 'Not allowed: on leave' }] }; };
    const r = await leaveForSam('Priya covers fire safety.');
    expect(prompt).toContain('Priya covers fire safety.');
    expect(prompt).toContain('<source id="colleagues"');
    const byTask = Object.fromEntries(r.body.handover.map((h: any) => [h.task_id, h]));
    expect(byTask[fire.id]).toMatchObject({ to: P.priya, by_ai: true });
    expect(byTask[damp.id].by_ai).toBe(false);
    expect(byTask[damp.id].to).not.toBe(P.sam);
    expect((await pool.query(`select status from ai_runs where task = 'leave_handover'`)).rows[0].status).toBe('accepted');
  });
});

describe('daily report and new assistant tasks', () => {
  it('makes one report a day with the figures, adds Claude’s summary when on, and tells managers', async () => {
    const priya = await as('priya');
    let r = await priya.post(`/api/ai/reports/${C.VH}/run`).send({});
    expect(r.status).toBe(201);
    expect(r.body.figures.open_tasks).toBeGreaterThan(0);
    expect(r.body.summary).toBeNull();
    await pool.query(`update ai_settings set enabled = true where company_id = $1`, [C.VH]);
    reply = () => ({ headline: '2 overdue tasks need owners today', priorities: ['Chase overdue tasks'], risks: [], going_well: ['Visits are being logged'] });
    r = await priya.post(`/api/ai/reports/${C.VH}/run`).send({});
    expect(r.body.summary.headline).toMatch(/overdue/);
    expect((await pool.query(`select count(*)::int n from ai_reports where company_id = $1`, [C.VH])).rows[0].n).toBe(1);
    expect((await pool.query(`select 1 from notifications where person_id = $1 and title like 'Daily report:%'`, [P.priya])).rowCount).toBeGreaterThan(0);
    expect((await priya.get('/api/ai/reports')).body.some((x: any) => x.company_id === C.VH)).toBe(true);
    expect((await (await as('sam')).post(`/api/ai/reports/${C.VH}/run`).send({})).status).toBe(403);
  });

  it('answers questions about the figures and audits a property from its records', async () => {
    await pool.query(`update ai_settings set enabled = true where company_id = $1`, [C.VH]);
    let prompt = '';
    reply = (p) => { prompt = p; return { answer: 'ok', key_figures: [], suggested_actions: [], overall: 'ok', findings: [], priorities: [], citations: [], missing_evidence: [] }; };
    const priya = await as('priya');
    expect((await priya.post('/api/ai/runs').send({ task: 'analytics_question', company_id: C.VH, input: { question: 'Which areas need attention?' } })).status).toBe(201);
    expect(prompt).toContain('overdue tasks:');
    const prop = (await pool.query(`select id from properties where company_id = $1 limit 1`, [C.VH])).rows[0].id;
    expect((await priya.post('/api/ai/runs').send({ task: 'property_audit', company_id: C.VH, input: { property_id: prop } })).status).toBe(201);
    expect(prompt).toContain('<source id="repairs"');
  });
});
