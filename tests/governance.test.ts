// Stage 6 acceptance tests: governance, audits, improvement, concerns, property safety, agents, quality summaries (spec §41 items 12, 13, 17).
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

beforeEach(resetDb);
const MEETING = '00000000-0000-4000-8000-000000000f21', ACTION = '00000000-0000-4000-8000-000000000f42', AUDIT = '00000000-0000-4000-8000-000000000f41';
const AGENT = '00000000-0000-4000-8000-000000000f61', REPAIR = '00000000-0000-4000-8000-000000000f62', FIRE_TEST = '00000000-0000-4000-8000-000000000f51';

describe('12 · meetings produce tracked decisions', () => {
  it('records which company each decision in a joint meeting affects, and keeps approved minutes', async () => {
    const robin = await as('robin');
    expect((await robin.post('/api/decisions').send({ meeting_id: MEETING, company_id: C.WHS, title: 'Wrong company', rationale: 'Test', authoriser_id: P.robin, decided_on: '2026-10-01' })).status).toBe(400);
    expect((await robin.post('/api/decisions').send({ meeting_id: MEETING, company_id: C.WHM, title: 'Adopt monthly sampling at Wellbeing Homes', rationale: 'Same issue seen', authoriser_id: P.robin, decided_on: '2026-10-01' })).status).toBe(201);
    expect((await robin.patch(`/api/meetings/${MEETING}`).send({ minutes: 'Rewritten' })).status).toBe(409);
    await robin.post(`/api/meetings/${MEETING}/amend`);
    await robin.patch(`/api/meetings/${MEETING}`).send({ minutes: 'Fire door checks reviewed. Agreed monthly sampling for Valor Housing and Wellbeing Homes.' });
    expect((await robin.post(`/api/meetings/${MEETING}/approve-minutes`).send({})).status).toBe(400); // amendment needs a reason
    expect((await robin.post(`/api/meetings/${MEETING}/approve-minutes`).send({ amendment_reason: 'Added the Wellbeing Homes decision' })).status).toBe(200);
    const v = (await robin.get(`/api/meetings/${MEETING}`)).body;
    expect(v.versions.map((x: any) => x.version)).toEqual([2, 1]);
    expect(v.decisions.map((d: any) => d.company_code).sort()).toEqual(['VH', 'WHM']);
  });
  it('a Valor Housing manager sees only Valor Housing decisions from a joint meeting', async () => {
    const v = (await (await as('priya')).get(`/api/meetings/${MEETING}`)).body;
    await (await as('robin')).post('/api/decisions').send({ meeting_id: MEETING, company_id: C.WHM, title: 'WHM only', rationale: 'Test', authoriser_id: P.robin, decided_on: '2026-10-01' });
    const after = (await (await as('priya')).get(`/api/meetings/${MEETING}`)).body;
    expect(after.decisions.length).toBe(v.decisions.length);
  });
});

describe('13 · audits lead to verified improvement', () => {
  it('evidence alone never closes a significant action; verification and an effectiveness review are needed', async () => {
    const morgan = await as('morgan'), robin = await as('robin');
    expect((await morgan.post(`/api/actions/${ACTION}/evidence`).field('note', 'Reference received and onboarding checklist updated.')).status).toBe(200);
    expect((await robin.post(`/api/actions/${ACTION}/close`)).status).toBe(409);
    expect((await morgan.post(`/api/actions/${ACTION}/verify`).send({ accept: true, note: 'Mine' })).status).toBe(403); // the owner cannot verify
    expect((await robin.post(`/api/actions/${ACTION}/verify`).send({ accept: true, note: 'Checked the file and the checklist.' })).status).toBe(200);
    expect((await robin.post(`/api/actions/${ACTION}/close`)).status).toBe(409); // still needs the effectiveness review
    expect((await robin.post(`/api/actions/${ACTION}/review`).send({ effectiveness: 'effective', recurred: false, note: 'No starters since without both references.' })).status).toBe(200);
    expect((await robin.post(`/api/actions/${ACTION}/close`)).status).toBe(200);
  });
  it('a recurrence reopens the action', async () => {
    const morgan = await as('morgan'), robin = await as('robin');
    await morgan.post(`/api/actions/${ACTION}/evidence`).field('note', 'Done');
    await robin.post(`/api/actions/${ACTION}/verify`).send({ accept: true, note: 'Seen' });
    await robin.post(`/api/actions/${ACTION}/review`).send({ effectiveness: 'not_effective', recurred: true, note: 'It happened again in November.' });
    expect((await pool.query('select status from improvement_actions where id = $1', [ACTION])).rows[0].status).toBe('reopened');
  });
  it('an audit cannot be completed with unanswered rubric items, and a failed safety check opens an action', async () => {
    const robin = await as('robin'), priya = await as('priya');
    const a = (await robin.post('/api/audits').send({ company_id: C.VH, area: 'training', title: 'Training audit', planned_on: '2026-10-20', rubric: [{ criterion: 'Matrix current' }] })).body;
    expect((await robin.patch(`/api/audits/${a.id}`).send({ status: 'completed' })).status).toBe(400);
    const r = await priya.post(`/api/safety/requirements/${FIRE_TEST}/checks`).field('done_on', '2026-10-19').field('result', 'fail').field('findings', 'Call point 2 did not trigger the panel.');
    expect(r.status).toBe(201);
    expect((await pool.query('select significance from improvement_actions where id = $1', [r.body.action.id])).rows[0].significance).toBe('significant');
    void AUDIT;
  });
});

describe('employee concerns', () => {
  it('a concern about your manager is hidden from that manager even if they hold HR rights', async () => {
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'hr_admin', $2, 'test')`, [P.priya, C.VH]);
    const c = (await (await as('sam')).post('/api/cases').send({ company_id: C.VH, kind: 'concern_about_manager', summary: 'My manager changes my rota without telling me.' })).body;
    expect((await (await as('priya')).get(`/api/cases/${c.id}`)).status).toBe(404);
    expect((await (await as('priya')).get('/api/cases')).body.some((x: any) => x.id === c.id)).toBe(false);
    const morgan = (await (await as('morgan')).get(`/api/cases/${c.id}`)).body;
    expect(morgan.role).toBe('handler');
    expect(morgan.implicated.map((p: any) => p.id)).toEqual([P.priya]);
    expect((await (await as('morgan')).patch(`/api/cases/${c.id}`).send({ investigator_id: P.priya })).status).toBe(400);
    expect((await pool.query(`select count(*)::int n from audit_log where entity = 'case' and action = 'view'`)).rows[0].n).toBe(1);
  });
  it('the person who raised it sees shared updates only', async () => {
    const sam = await as('sam'), morgan = await as('morgan');
    const c = (await sam.post('/api/cases').send({ company_id: C.VH, kind: 'grievance', summary: 'Repeatedly given the late visits.' })).body;
    await morgan.post(`/api/cases/${c.id}/updates`).send({ body: 'Internal note: check the rota history.', shared: false });
    await morgan.post(`/api/cases/${c.id}/updates`).send({ body: 'We have received your grievance and will meet you on Friday.', shared: true });
    const mine = (await sam.get(`/api/cases/${c.id}`)).body;
    expect(mine.updates.map((u: any) => u.body)).toEqual(['We have received your grievance and will meet you on Friday.']);
  });
  it('contract changes need someone other than the proposer to approve, and the employee records agreement', async () => {
    const morgan = await as('morgan');
    const cc = (await morgan.post('/api/contract-changes').send({ appointment_id: '00000000-0000-4000-8000-000000000b01', summary: 'Hours from 24 to 30 per week', effective_on: '2026-12-01' })).body;
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'company_admin', $2, 'test')`, [P.morgan, C.VH]);
    expect((await (await as('morgan')).post(`/api/contract-changes/${cc.id}/approve`)).status).toBe(403);
    expect((await (await as('alex')).post(`/api/contract-changes/${cc.id}/approve`)).status).toBe(200);
    expect((await (await as('sam')).post(`/api/contract-changes/${cc.id}/agreement`).send({ agreement: 'agreed' })).status).toBe(400); // not yet communicated
    await morgan.post(`/api/contract-changes/${cc.id}/communicate`).send({ communicated_on: '2026-10-20' });
    expect((await (await as('sam')).post(`/api/contract-changes/${cc.id}/agreement`).send({ agreement: 'not_agreed', employee_response: 'I can only do 26 hours.' })).status).toBe(200);
  });
});

describe('managing agents', () => {
  it('an agent user sees only their own properties and repairs, and nothing else in the Hub', async () => {
    const agent = await as('agent');
    const portal = (await agent.get('/api/agent-portal')).body;
    expect(portal.properties.map((p: any) => p.ref).sort()).toEqual(['VH-003', 'VH-006']);
    expect((await agent.get('/api/properties')).body).toEqual([]);
    expect((await agent.get('/api/people')).body.map((p: any) => p.id)).toEqual([P.agent]); // only their own profile
    expect((await agent.get('/api/handover')).body).toEqual([]);
    expect((await agent.get(`/api/properties/${prop(1)}`)).status).toBe(404);
    expect((await agent.post('/api/repairs').send({ property_id: prop(1), title: 'Not ours', urgency: 'routine' })).status).toBe(404);
  });
  it('repairs follow the workflow and someone else verifies the work', async () => {
    const agent = await as('agent'), priya = await as('priya');
    expect((await agent.post(`/api/repairs/${REPAIR}/status`).send({ status: 'closed', note: 'Done' })).status).toBe(409);
    expect((await agent.post(`/api/repairs/${REPAIR}/status`).send({ status: 'in_progress', note: 'Engineer booked' })).status).toBe(200);
    expect((await agent.post(`/api/repairs/${REPAIR}/status`).send({ status: 'awaiting_verification', note: 'Pressure valve replaced' })).status).toBe(200);
    expect((await agent.post(`/api/repairs/${REPAIR}/status`).send({ status: 'closed', note: 'Self-verify' })).status).toBe(403);
    expect((await priya.post(`/api/repairs/${REPAIR}/status`).send({ status: 'closed', note: 'Checked boiler pressure holds overnight.' })).status).toBe(200);
  });
  it('rejects resident details in repair reports', async () => {
    const r = await (await as('sam')).post('/api/repairs').send({ property_id: prop(1), title: 'Leak in Room B', description: 'Resident name is on the door', urgency: 'routine' });
    expect(r.status).toBe(400);
  });
});

describe('17 · external quality summaries contain no resident case data', () => {
  it('suppresses small counts for viewers and has no resident fields', async () => {
    const viewer = (await (await as('alex')).get('/api/quality-summaries')).body;
    expect(viewer[0].value).toBe('3.00'); // managers of quality see the figure
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason, expires_at) values ($1, 'reviewer', $2, 'test', now() + interval '30 days')`, [P.casey, C.VH]);
    await pool.query(`insert into role_permissions values ('reviewer', 'quality.view') on conflict do nothing`);
    const restricted = (await (await as('casey')).get('/api/quality-summaries')).body;
    expect(restricted[0]).toMatchObject({ value: null, suppressed: 'fewer than 5' });
    const cols = (await pool.query(`select column_name from information_schema.columns where table_name = 'quality_summaries'`)).rows.map((r) => r.column_name);
    expect(cols.some((c) => /resident|tenant|name|person|case/.test(c))).toBe(false);
  });
  it('refuses themes that include names', async () => {
    const r = await (await as('robin')).post('/api/quality-summaries').send({ company_id: C.VH, measure: 'complaint_themes', period_start: '2026-09-01', period_end: '2026-09-30', theme: 'Noise complaints about Mr Smith', definition: 'Themes from complaints', source: 'Support system' });
    expect(r.status).toBe(400);
  });
});

describe('management pack', () => {
  it('uses plain status labels per section, separately for each company, with no overall percentage', async () => {
    const r = (await (await as('alex')).get('/api/packs?month=2026-10')).body;
    expect(r.map((c: any) => c.company_code).sort()).toEqual(['VH', 'WHM', 'WHS']);
    const vh = r.find((c: any) => c.company_code === 'VH');
    for (const s of vh.sections) expect(['evidence_missing', 'awaiting_review', 'action_required', 'verified', 'not_applicable']).toContain(s.status);
    expect(vh.sections.find((s: any) => s.key === 'clearance').status).toBe('action_required');
    expect(JSON.stringify(vh)).not.toMatch(/overall|compliance_percent/);
    expect((await (await as('sam')).get('/api/packs?month=2026-10')).status).toBe(403);
  });
});
