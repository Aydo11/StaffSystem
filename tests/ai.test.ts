// Stage 8 acceptance test: the AI assistant respects permissions and requires review (spec §41 item 16).
// The model call is replaced by a fake, so no API key or network is used.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAiCaller } from '../server/routes/ai.ts';
import { as, C, P, pool, resetDb } from './helpers.ts';

let lastPrompt = '';
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-not-used';
  setAiCaller(async ({ prompt }) => { lastPrompt = prompt; return { output: { answer: 'Set an expected finish time.', citations: [{ source_id: 'x', note: 'Before a visit' }], missing_evidence: [] }, input_tokens: 1000, output_tokens: 200 }; });
});
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });
beforeEach(async () => { await resetDb(); lastPrompt = ''; });
const enable = (company: string, extra = '') => pool.query(`update ai_settings set enabled = true ${extra} where company_id = $1`, [company]);
const ask = (who: Awaited<ReturnType<typeof as>>, company = C.VH) => who.post('/api/ai/runs').send({ task: 'policy_question', company_id: company, input: { question: 'What do I do before a lone visit?' } });

describe('16 · AI respects permissions and requires review', () => {
  it('is off by default, and the manual route is named when it is unavailable', async () => {
    const r = await ask(await as('priya'));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/by hand/);
  });
  it('only permitted roles can use it; task permissions still apply', async () => {
    await enable(C.VH);
    expect((await ask(await as('sam'))).status).toBe(403); // staff are not in the default allowed roles
    expect((await ask(await as('priya'))).status).toBe(201);
    const brief = await (await as('casey')).post('/api/ai/runs').send({ task: 'management_briefing', company_id: C.VH, input: { month: '2026-10' } });
    expect(brief.status).toBe(403);
  });
  it('uses only sources from the chosen company, marked as data', async () => {
    await enable(C.VH);
    await (await as('priya')).post('/api/ai/runs').send({ task: 'policy_question', company_id: C.VH, input: { question: 'What do I do before a lone visit?' } });
    expect(lastPrompt).toContain('Lone working policy');
    expect(lastPrompt).toMatch(/<source id="[^"]+" type="policy"/);
    // Wellbeing Homes has not adopted any policy, so a WHM question has nothing to use and the assistant refuses to guess.
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'manager', $2, 'test')`, [P.priya, C.WHM]);
    await enable(C.WHM);
    const whm = await ask(await as('priya'), C.WHM);
    expect(whm.status).toBe(400);
  });
  it('restricted supervision notes are never sent to the model', async () => {
    await enable(C.VH);
    const r = await (await as('priya')).post('/api/ai/runs').send({ task: 'supervision_prep', company_id: C.VH, input: { person_id: P.sam } });
    expect(r.status).toBe(201);
    expect(lastPrompt).toContain('Wants more inspection experience');
    expect(lastPrompt).not.toContain('overtime pattern');
  });
  it('every result is a draft a person must review, and usage limits stop further runs', async () => {
    await enable(C.VH, ', monthly_token_limit = 1200');
    const priya = await as('priya');
    const r = (await ask(priya)).body;
    expect(r.status).toBe('draft');
    expect((await priya.post(`/api/ai/runs/${r.id}/review`).send({ status: 'accepted' })).status).toBe(200);
    expect((await priya.post(`/api/ai/runs/${r.id}/review`).send({ status: 'dismissed' })).status).toBe(409);
    expect((await ask(priya)).status).toBe(409); // the 1,200-token monthly limit has been reached
    expect((await pool.query(`select count(*)::int n from audit_log where entity = 'ai_run'`)).rows[0].n).toBe(2);
  });
  it('a model failure is reported plainly and recorded', async () => {
    await enable(C.VH);
    setAiCaller(async () => ({ output: null, input_tokens: 0, output_tokens: 0, refused: true }));
    const r = await ask(await as('priya'));
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/declined.*by hand/);
    expect((await pool.query(`select status from ai_runs`)).rows[0].status).toBe('failed');
  });
});
