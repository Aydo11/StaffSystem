// Leave and cover, job descriptions, competence, onboarding and probation.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const vhProperty = async () => (await pool.query(`select id from properties where company_id = $1 order by ref limit 1`, [C.VH])).rows[0].id;

describe('leave and cover', () => {
  it('needs someone else to approve, blocks overlaps, keeps visits off leave days and finds cover', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const prop = await vhProperty();
    const planned = (await priya.post('/api/scheduled-visits').send({ appointment_id: A.samVH, property_id: prop, planned_start: '2026-11-10T10:00', planned_minutes: 60 })).body;
    const req = await sam.post('/api/leave').send({ company_id: C.VH, kind: 'annual', start_date: '2026-11-09', end_date: '2026-11-13' });
    expect(req.status).toBe(201);
    expect((await sam.post('/api/leave').send({ company_id: C.VH, kind: 'annual', start_date: '2026-11-12', end_date: '2026-11-14' })).status).toBe(409);
    expect((await sam.post(`/api/leave/${req.body.id}/decide`).send({ decision: 'approved' })).status).toBe(403);
    expect((await priya.post(`/api/leave/${req.body.id}/decide`).send({ decision: 'rejected' })).status).toBe(400); // a rejection needs a reason
    expect((await priya.post(`/api/leave/${req.body.id}/decide`).send({ decision: 'approved' })).status).toBe(200);

    expect((await priya.post('/api/scheduled-visits').send({ appointment_id: A.samVH, property_id: prop, planned_start: '2026-11-11T10:00', planned_minutes: 60 })).status).toBe(409);
    const cover = (await priya.get(`/api/leave/${req.body.id}/cover`)).body.visits;
    expect(cover.map((v: any) => v.id)).toEqual([planned.id]);
    expect(cover[0].candidates.map((c: any) => c.person_id)).not.toContain(P.sam);
    // Cover follows the company's clearance rule: uncleared colleagues are refused, cleared ones accepted.
    const uncleared = cover[0].candidates.find((c: any) => c.clearance === 'none');
    expect((await priya.post(`/api/scheduled-visits/${planned.id}/reassign`).send({ person_id: uncleared.person_id })).body.error).toBe('clearance_required');
    await pool.query(`insert into clearance_decisions (person_id, company_id, status, evidence_summary, decided_by, decided_at, review_date) values ($1, $2, 'cleared', 'Checks complete', $3, now(), '2027-10-01')`, [uncleared.person_id, C.VH, P.morgan]);
    const to = uncleared.person_id;
    expect((await priya.post(`/api/scheduled-visits/${planned.id}/reassign`).send({ person_id: to })).status).toBe(200);
    expect((await pool.query('select person_id from scheduled_visits where id = $1', [planned.id])).rows[0].person_id).toBe(to);

    const week = (await priya.get('/api/workload?week_start=2026-11-09')).body.find((r: any) => r.appointment_id === A.samVH);
    expect(week.leave_days).toBe(5);
  });
});

describe('job descriptions', () => {
  it('ties acknowledgement to the exact published version; a new version needs a new acknowledgement', async () => {
    const morgan = await as('morgan'), sam = await as('sam');
    const v1 = (await morgan.post('/api/job-descriptions').send({ company_id: C.VH, title: 'Property support worker', duties: 'Visit properties and record checks.' })).body;
    expect((await morgan.put(`/api/appointments/${A.samVH}/job-description`).send({ root_id: v1.root_id })).status).toBe(400); // drafts cannot be assigned
    await morgan.post(`/api/job-descriptions/${v1.id}/publish`);
    expect((await morgan.patch(`/api/job-descriptions/${v1.id}`).send({ duties: 'Changed after publishing' })).status).toBe(409);
    await morgan.put(`/api/appointments/${A.samVH}/job-description`).send({ root_id: v1.root_id });
    expect((await sam.get('/api/inbox')).body.some((i: any) => i.kind === 'jd_acknowledge')).toBe(true);
    expect((await sam.post(`/api/job-descriptions/${v1.id}/acknowledge`)).status).toBe(200);
    expect((await sam.get('/api/inbox')).body.some((i: any) => i.kind === 'jd_acknowledge')).toBe(false);

    const v2 = (await morgan.post(`/api/job-descriptions/${v1.id}/new-version`)).body;
    expect(v2.version).toBe(2);
    await morgan.post(`/api/job-descriptions/${v2.id}/publish`);
    expect((await sam.post(`/api/job-descriptions/${v1.id}/acknowledge`)).status).toBe(409); // old version is retired
    const dev = (await sam.get(`/api/people/${P.sam}/development`)).body.appointments.find((x: any) => x.id === A.samVH);
    expect(dev.job_description).toMatchObject({ version: 2, acknowledged_at: null });
  });
});

describe('competence', () => {
  it('needs an assessor who is not the person, with rubric notes and evidence', async () => {
    const morgan = await as('morgan'), priya = await as('priya');
    const k = (await morgan.post('/api/competencies').send({ company_id: C.VH, name: 'Fire safety walk-round', rubric: 'Developing: needs prompts. Competent: completes unaided. Verified: can coach others.' })).body;
    const body = { competency_id: k.id, level: 'competent', assessed_on: '2026-10-15', rubric_notes: 'Completed unaided', evidence: 'Observed a full walk-round at a property.' };
    expect((await priya.post(`/api/people/${P.priya}/competency-assessments`).send(body)).status).toBe(403);
    expect((await priya.post(`/api/people/${P.sam}/competency-assessments`).send({ ...body, evidence: '' })).status).toBe(400);
    expect((await priya.post(`/api/people/${P.sam}/competency-assessments`).send(body)).status).toBe(201);
    const dev = (await (await as('sam')).get(`/api/people/${P.sam}/development`)).body;
    expect(dev.competence).toHaveLength(1);
    expect(dev.competence[0]).toMatchObject({ level: 'competent', competency_name: 'Fire safety walk-round' });
  });
});

describe('onboarding and probation', () => {
  it('starts a checklist with probation reviews; interim reviews record progress and final ones a decision', async () => {
    const priya = await as('priya');
    expect((await priya.post(`/api/appointments/${A.samVH}/onboarding`).send({})).status).toBe(201);
    expect((await priya.post(`/api/appointments/${A.samVH}/onboarding`).send({})).status).toBe(409);
    const ap = (await (await as('sam')).get(`/api/people/${P.sam}/development`)).body.appointments.find((x: any) => x.id === A.samVH);
    expect(ap.onboarding.items).toHaveLength(10);
    expect(ap.probation.map((r: any) => r.kind)).toEqual(['interim', 'final']);
    expect((await priya.patch(`/api/onboarding-items/${ap.onboarding.items[0].id}`).send({ done: true })).body.done_at).toBeTruthy();
    const [interim, final] = ap.probation;
    expect((await priya.post(`/api/probation-reviews/${interim.id}/complete`).send({ outcome: 'passed', notes: 'Going well' })).status).toBe(400);
    expect((await priya.post(`/api/probation-reviews/${interim.id}/complete`).send({ outcome: 'on_track', notes: 'Going well' })).status).toBe(200);
    expect((await priya.post(`/api/probation-reviews/${final.id}/complete`).send({ outcome: 'extended', notes: 'More time on keys' })).status).toBe(400);
    expect((await priya.post(`/api/probation-reviews/${final.id}/complete`).send({ outcome: 'extended', notes: 'More time on keys', extend_to: '2027-12-01' })).status).toBe(200);
    expect((await pool.query(`select count(*)::int n from probation_reviews where appointment_id = $1 and kind = 'extension'`, [A.samVH])).rows[0].n).toBe(1);
  });
});
