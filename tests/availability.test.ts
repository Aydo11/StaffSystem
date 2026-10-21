// Support work approves itself; working hours and the CPD roadmap on profiles.
import { beforeEach, describe, expect, it } from 'vitest';
import { cpdRoadmap } from '../server/routes/people.ts';
import { A, as, P, pool, prop, resetDb, rid } from './helpers.ts';

beforeEach(resetDb);
// Two days ago, 10:00 UK time, as the manual form sends it.
const twoDaysAgo = () => `${new Date(Date.now() - 2 * 86400e3).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })}T10:00`;
const manual = (work_category: string, start_local = twoDaysAgo()) => ({ property_id: prop(1), appointment_id: A.samVH, client_request_id: rid(), start_local, minutes: 60, work_category, summary: 'Weekly support session at the property.' });

describe('support work', () => {
  it('is approved automatically with the full time allocated; other work still waits for review', async () => {
    // Relative test dates can coincide with the fixed historic seed visits (19 October, for example).
    // This scenario checks approval, not overlap; isolate its worker's time first.
    await pool.query(`update visits set status='cancelled' where person_id=$1`, [P.sam]);
    const sam = await as('sam');
    const s = await sam.post('/api/visits/manual').send(manual('support_work'));
    expect(s.status).toBe(201);
    expect(s.body.visit.status).toBe('approved');
    expect((await pool.query('select minutes from visit_allocations where visit_id = $1', [s.body.visit.id])).rows).toEqual([{ minutes: 60 }]);
    const o = await sam.post('/api/visits/manual').send(manual('inspection', twoDaysAgo().replace('T10', 'T13')));
    expect(o.body.visit.status).toBe('submitted');
  });
});

describe('working hours and availability', () => {
  it('the person sets their hours; colleagues see them; bad times and other people are refused', async () => {
    const sam = await as('sam');
    expect((await sam.put(`/api/people/${P.sam}/working-hours`).send({ mon: ['09:00', '17:00'], tue: ['17:00', '09:00'] })).status).toBe(400);
    expect((await sam.put(`/api/people/${P.sam}/working-hours`).send({ mon: ['09:00', '17:00'], fri: ['08:30', '12:00'] })).status).toBe(200);
    const o = (await (await as('priya')).get(`/api/people/${P.sam}/overview`)).body;
    expect(o.working_hours).toEqual({ mon: ['09:00', '17:00'], fri: ['08:30', '12:00'] });
    expect(['available', 'off', 'away', 'on_visit']).toContain(o.availability.status);
    expect((await (await as('taylor')).put(`/api/people/${P.sam}/working-hours`).send({})).status).toBe(403);
  });
});

describe('CPD roadmap', () => {
  it('ticks a step only once evidenced, and keeps unmatched training as other learning', () => {
    const r = (title: string, extra: object = {}) => ({ id: rid(), title, source: 'external', completed_on: '2026-01-01', certificate_file_id: null, verified_at: null, ...extra });
    const out = cpdRoadmap([r('Safeguarding Adults Level 2'), r('Emergency First Aid at Work', { verified_at: '2026-01-02' }), r('Hub course: Fire Safety', { source: 'course' }), r('Customer service', { verified_at: '2026-01-02' })]);
    const st = Object.fromEntries(out.steps.map((s) => [s.key, s.status]));
    expect(st).toMatchObject({ safeguarding: 'awaiting', first_aid: 'done', fire_safety: 'done', health_safety: 'todo' });
    expect(out.other.map((x) => x.title)).toEqual(['Customer service']);
  });
  it('is shown to the person and training viewers only', async () => {
    const sam = await as('sam');
    await sam.post('/api/training/records').send({ title: 'Safeguarding Adults Level 2', completed_on: '2026-09-01' });
    expect((await sam.get(`/api/people/${P.sam}/overview`)).body.cpd.steps[0]).toMatchObject({ key: 'safeguarding', status: 'awaiting' });
    expect((await (await as('priya')).get(`/api/people/${P.sam}/overview`)).body.cpd).not.toBeNull(); // manager: training.view_all
    expect((await (await as('taylor')).get(`/api/people/${P.sam}/overview`)).body.cpd ?? null).toBeNull();
  });
});

