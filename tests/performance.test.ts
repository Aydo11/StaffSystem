// Stage 4 acceptance tests: KPIs, reviews, supervision, recognition, help requests.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, resetDb, V } from './helpers.ts';

beforeEach(resetDb);
const REVIEW = '00000000-0000-4000-8000-000000000e01', DRAFT = '00000000-0000-4000-8000-000000000e02';
const kpi = (body: any[], key: string, code = 'VH') => body.find((c) => c.company_code === code).kpis.find((k: any) => k.key === key);

describe('9 · approved records update KPIs', () => {
  it('approving a visit raises approved hours; planned/recorded/submitted are shown separately', async () => {
    const priya = await as('priya');
    const before = kpi((await priya.get(`/api/kpis?company=${C.VH}&month=2026-10`)).body, 'approved_hours');
    expect(before.hours).toMatchObject({ approved: 90, submitted: 45 });
    await priya.post(`/api/visits/${V.d03}/decide`).send({ approve: true });
    const after = kpi((await priya.get(`/api/kpis?company=${C.VH}&month=2026-10`)).body, 'approved_hours');
    expect(after.hours).toMatchObject({ approved: 135, submitted: 0 });
    expect(after.status).toBe('info'); // hours have no target: more time is not better work
  });
  it('says when there is not enough data instead of showing a misleading percentage', async () => {
    const k = kpi((await (await as('priya')).get(`/api/kpis?company=${C.VH}&month=2026-10`)).body, 'on_time_starts');
    expect(k.status).toBe('insufficient');
    expect(k.value).toBeNull();
  });
  it('past months keep the definition that was in force', async () => {
    const alex = await as('alex');
    expect((await alex.post('/api/kpi-definitions').send({ key: 'clearance', company_id: C.VH, title: 'Staff cleared for deployment', purpose: 'Changed target', target: 50, min_data: 1, limitations: 'Test version', effective_from: '2026-10-01' })).status).toBe(201);
    const oct = kpi((await alex.get(`/api/kpis?company=${C.VH}&month=2026-10`)).body, 'clearance');
    const sep = kpi((await alex.get(`/api/kpis?company=${C.VH}&month=2026-09`)).body, 'clearance');
    expect([oct.target, oct.definition.version]).toEqual([50, 1]); // first VH-specific version
    expect([sep.target, sep.definition.company_id]).toEqual([100, null]); // group default still applies to September
  });
  it('staff see their own KPIs only; supervision counts toward the person', async () => {
    const sam = await as('sam');
    expect((await sam.get(`/api/kpis?person=${P.priya}&month=2026-10`)).status).toBe(403);
    const mine = (await sam.get('/api/kpis?person=me&month=2026-10')).body;
    expect(mine.map((c: any) => c.company_code).sort()).toEqual(['VH', 'WHM', 'WHS']);
    expect(kpi(mine, 'supervision_on_time')).toMatchObject({ value: 100, status: 'met' });
    expect(kpi(mine, 'coaching_hours').value).toBe(0.5);
  });
  it('a below-target measure gives advice with source, limitation and next step', async () => {
    const r = (await (await as('morgan')).get(`/api/kpis?company=${C.VH}&month=2026-10`)).body;
    const advice = r.find((c: any) => c.company_code === 'VH').advice.find((a: any) => a.key === 'clearance');
    expect(advice.finding).toMatch(/against a target of 100%/);
    expect(advice.source).toMatch(/definition version 1/);
    expect(advice.limitation).toBeTruthy();
    expect(advice.next_step).toBeTruthy();
  });
});

describe('10 · staff act on feedback and request support', () => {
  it('keeps incomplete and future reviews in draft and validates the period before saving', async () => {
    const manager = await as('priya');
    const body = { company_id: C.VH, person_id: P.sam, kind: 'periodic', period_start: '2000-01-01', period_end: '2000-01-31' };
    expect((await manager.post('/api/reviews').send({ ...body, period_end: '1999-12-31' })).status).toBe(400);
    const created = await manager.post('/api/reviews').send(body);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const incomplete = await manager.post(`/api/reviews/${id}/publish`);
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.details.fields).toHaveProperty('objectives');
    expect((await pool.query('select status,published_at from reviews where id=$1', [id])).rows[0]).toEqual({status:'draft',published_at:null});
    await manager.patch(`/api/reviews/${id}`).send({ objectives: 'Agreed objectives.', achievements: 'Reviewed work examples.', development: 'Development actions discussed.', feedback: 'Feedback recorded.' });
    expect((await manager.post(`/api/reviews/${id}/publish`)).status).toBe(200);
    const future = await manager.post('/api/reviews').send({ ...body, period_start: '2099-01-01', period_end: '2099-01-31', objectives: 'Plan', achievements: 'Pending', development: 'Plan', feedback: 'Pending' });
    expect((await manager.post(`/api/reviews/${future.body.id}/publish`)).status).toBe(400);
  });
  it('a manager cannot read or acknowledge their own draft review', async () => {
    const created = await (await as('alex')).post('/api/reviews').send({ company_id: C.VH, person_id: P.priya, kind: 'periodic', period_start: '2000-01-01', period_end: '2000-01-31' });
    expect(created.status).toBe(201);
    const subject = await as('priya');
    expect((await subject.get(`/api/reviews/${created.body.id}`)).status).toBe(404);
    expect((await subject.post(`/api/reviews/${created.body.id}/respond`).send({ acknowledge: true })).status).toBe(404);
    expect((await pool.query('select acknowledged_at from reviews where id=$1', [created.body.id])).rows[0].acknowledged_at).toBeNull();
  });
  it('a supervision needs session content and cannot be completed before it happens', async () => {
    const manager = await as('priya');
    const created = await manager.post('/api/supervisions').send({ company_id: C.VH, person_id: P.sam, kind: 'supervision', held_on: '2099-01-01', minutes: 90 });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await manager.post(`/api/supervisions/${id}/complete`)).status).toBe(400);
    await manager.patch(`/api/supervisions/${id}`).send({ agenda: 'Caseload and support.', shared_notes: 'Discussion and agreed outcomes recorded.' });
    expect((await manager.post(`/api/supervisions/${id}/complete`)).status).toBe(400);
    await manager.patch(`/api/supervisions/${id}`).send({ held_on: '2000-01-01' });
    expect((await manager.post(`/api/supervisions/${id}/complete`)).status).toBe(200);
  });
  it('drafts are hidden from the person; published reviews can be answered and acknowledged without agreeing', async () => {
    expect((await (await as('casey')).get(`/api/reviews/${DRAFT}`)).status).toBe(404);
    const sam = await as('sam');
    expect((await sam.get(`/api/reviews/${REVIEW}`)).body.can.respond).toBe(true);
    expect((await sam.post(`/api/reviews/${REVIEW}/respond`).send({ staff_response: 'I disagree about the photos; the camera was broken.', acknowledge: true })).status).toBe(200);
    const row = (await pool.query('select staff_response, acknowledged_at from reviews where id = $1', [REVIEW])).rows[0];
    expect(row.staff_response).toMatch(/disagree/);
    expect(row.acknowledged_at).not.toBeNull();
    expect((await (await as('priya')).patch(`/api/reviews/${REVIEW}`).send({ feedback: 'rewritten' })).status).toBe(403); // published is kept as shared
  });
  it('turning a review point into an action creates a task for the person, linked to the review', async () => {
    const r = await (await as('priya')).post(`/api/reviews/${REVIEW}/actions`).send({ title: 'Take wide-angle evidence photos', due_on: '2026-11-30' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ owner_id: P.sam, reviewer_id: P.priya, review_id: REVIEW });
  });
  it('Request Help creates a task for the person’s manager in that company', async () => {
    const r = await (await as('sam')).post('/api/help-requests').send({ company_id: C.WHM, message: 'I need a ladder to reach the extractor fan.' });
    expect(r.status).toBe(201);
    expect((await pool.query('select owner_id, priority from tasks where id = $1', [r.body.id])).rows[0]).toEqual({ owner_id: P.jordan, priority: 'high' });
  });
  it('restricted supervision notes are hidden from the person and from other companies', async () => {
    const id = (await pool.query(`select id from supervisions where kind = 'supervision' limit 1`)).rows[0].id;
    const sam = (await (await as('sam')).get(`/api/supervisions/${id}`)).body;
    expect(sam.supervision.shared_notes).toBeTruthy();
    expect(sam.supervision.restricted_notes).toBeUndefined();
    expect((await (await as('morgan')).get(`/api/supervisions/${id}`)).body.supervision.restricted_notes).toMatch(/overtime/);
    expect((await (await as('jordan')).get(`/api/supervisions/${id}`)).status).toBe(404);
    expect((await (await as('sam')).patch(`/api/supervisions/${id}`).send({ shared_notes: 'changed' })).status).toBe(400); // reflection only
    expect((await (await as('sam')).patch(`/api/supervisions/${id}`).send({ staff_reflection: 'Useful session.' })).status).toBe(200);
  });
  it('recognition cannot be self-proposed and needs a manager decision', async () => {
    const sam = await as('sam');
    expect((await sam.post('/api/recognitions').send({ company_id: C.VH, person_id: P.sam, category: 'quality', note: 'Me again' })).status).toBe(403);
    const r = await sam.post('/api/recognitions').send({ company_id: C.VH, person_id: P.casey, category: 'teamwork', note: 'Helped me carry tools all week.' });
    expect(r.status).toBe(201);
    expect((await (await as('casey')).get('/api/recognitions')).body.some((x: any) => x.id === r.body.id)).toBe(false); // not shown until approved
    expect((await (await as('priya')).post(`/api/recognitions/${r.body.id}/decide`).send({ approve: true })).status).toBe(200);
    expect((await (await as('casey')).get('/api/recognitions')).body.some((x: any) => x.id === r.body.id)).toBe(true);
  });
});
