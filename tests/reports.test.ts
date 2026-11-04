// Phase 3: agent scorecards, monthly summaries, reminders, activity history, issue detection, health, bulk changes, preferences.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, prop } from './helpers.ts';
import { resetDb } from './helpers.ts';
import { safetyReminders } from '../server/routes/reports.ts';

beforeEach(resetDb);
const AGENT = 'Example Lettings Agent (fictional)'; // linked to VH-003 and VH-006
const repair = async (property: string, over: Record<string, unknown>) => {
  const f = { company_id: property <= prop(7) ? C.VH : C.WHM, property_id: property, title: 'Test repair', urgency: 'routine', status: 'reported', reported_by: P.sam, ...over };
  return (await pool.query(`insert into repairs (${Object.keys(f).join(', ')}) values (${Object.keys(f).map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(f))).rows[0].id as string;
};
const notes = async (who: string, like: string) => (await pool.query('select count(*)::int n from notifications where person_id = $1 and title like $2', [who, like])).rows[0].n;

describe('managing-agent scorecards', () => {
  it('scores each agent from recorded repairs, with configurable red/amber/green; agents see only their own card', async () => {
    // In October: one repair on time (3 days), one late (7 days, no cost recorded); one open and overdue.
    await repair(prop(3), { status: 'verified', reported_on: '2026-10-01', due_on: '2026-10-05', completed_on: '2026-10-04', cost: 120, verified_at: '2026-10-05T10:00:00Z' });
    await repair(prop(6), { status: 'completed', reported_on: '2026-10-10', due_on: '2026-10-12', completed_on: '2026-10-17' });
    await repair(prop(3), { reported_on: '2026-10-20', due_on: '2026-10-21' });
    const priya = await as('priya');
    const s = (await priya.get(`/api/scorecards?company=${C.VH}&from=2026-10-01&to=2026-10-31`)).body;
    const card = s.cards.find((c: any) => c.agent === AGENT);
    expect(card).toMatchObject({ properties: 2, monitored: 0, repairs_completed: 2 });
    expect(card.metrics.on_time_pct).toEqual({ value: 50, rag: 'red' });
    expect(card.metrics.avg_days).toEqual({ value: 5, rag: 'green' });
    expect(card.metrics.overdue).toEqual({ value: 2, rag: 'amber' }); // completed but not yet verified still counts, as on the repairs dashboard
    expect(card.metrics.inspection_rate).toEqual({ value: 0, rag: 'red' });
    expect(card.metrics.hazard_days).toEqual({ value: null, rag: 'none' }); // nothing recorded is missing data, not a pass
    expect(card.metrics.compliance_score).toEqual({ value: null, rag: 'none' });

    // Thresholds are per company; green must sit on the right side of amber; staff cannot change them.
    expect((await priya.put('/api/scorecards/settings').send({ company_id: C.VH, thresholds: { on_time_pct: { green: 40, amber: 60 } } })).status).toBe(400);
    expect((await (await as('sam')).put('/api/scorecards/settings').send({ company_id: C.VH, thresholds: { on_time_pct: { green: 50, amber: 30 } } })).status).toBe(403);
    expect((await priya.put('/api/scorecards/settings').send({ company_id: C.VH, thresholds: { on_time_pct: { green: 50, amber: 30 } } })).status).toBe(200);
    const again = (await priya.get(`/api/scorecards?company=${C.VH}&from=2026-10-01&to=2026-10-31`)).body.cards.find((c: any) => c.agent === AGENT);
    expect(again.metrics.on_time_pct.rag).toBe('green');

    const mine = (await (await as('agent')).get('/api/scorecards?from=2026-10-01&to=2026-10-31')).body.cards;
    expect(mine.map((c: any) => c.agent)).toEqual([AGENT]);
  });

  it('includes compliance only for monitored properties and people allowed to see it', async () => {
    await pool.query('update properties set compliance_enabled = true where id = $1', [prop(3)]);
    const priya = (await (await as('priya')).get(`/api/scorecards?company=${C.VH}`)).body.cards.find((c: any) => c.agent === AGENT);
    expect(priya.monitored).toBe(1);
    const sam = (await (await as('sam')).get(`/api/scorecards?company=${C.VH}`)).body.cards;
    for (const c of sam) expect(c.monitored).toBe(0);
  });
});

describe('monthly summary', () => {
  it('separates verified activity from what is open and from missing data', async () => {
    await repair(prop(3), { status: 'verified', reported_on: '2026-10-01', due_on: '2026-10-05', completed_on: '2026-10-04', cost: 120, verified_at: '2026-10-05T10:00:00Z' });
    await repair(prop(3), { status: 'completed', reported_on: '2026-10-10', due_on: '2026-10-12', completed_on: '2026-10-17' });
    const m = (await (await as('priya')).get(`/api/safety/monthly?company=${C.VH}&month=2026-10`)).body;
    expect(m).toMatchObject({ month: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    const p3 = m.properties.find((p: any) => p.id === prop(3));
    expect(p3.verified).toMatchObject({ repairs_completed: 2, repairs_on_time: 1, repairs_verified: 1, repair_spend: 120, inspections: 0 });
    expect(p3.verified.compliance_records).toBeUndefined(); // not monitored
    expect(p3.missing).toEqual(['No inspection recorded this month', '1 completed repair with no cost recorded', '1 completed repair not verified this month']);
    expect(m.totals.properties_without_inspection).toBe(m.properties.length);
  });
});

describe('reminders', () => {
  it('sends each reminder once: repairs due tomorrow, overdue actions, compliance deadlines on monitored properties only', async () => {
    const r = await repair(prop(1), { due_on: new Date(Date.now() + 86400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), assignee_id: P.sam });
    const priya = await as('priya');
    const risk = (await priya.post('/api/property-risks').send({ property_id: prop(1), title: 'Loose stair rail', likelihood: 2, impact: 3 })).body;
    await pool.query(`insert into improvement_actions (company_id, source_type, source_id, finding, action, owner_id, due_on) values ($1, 'risk', $2, 'Loose rail', 'Fix the rail', $3, current_date - 2)`, [C.VH, risk.id, P.sam]);
    // Compliance item due in 10 days on a monitored and an unmonitored property.
    for (const [n, on] of [[1, true], [2, false]] as const) {
      await pool.query('update properties set compliance_enabled = $2 where id = $1', [prop(n), on]);
      const req = (await pool.query(`insert into compliance_requirements (company_id, property_id, key, name, interval_days, reminder_days, responsible_id) values ($1,$2,'gas_safety','Gas safety',365,30,$3) returning id`, [C.VH, prop(n), P.priya])).rows[0].id;
      await pool.query(`insert into compliance_records (requirement_id, completed_on, next_due_on, outcome, recorded_by) values ($1, current_date - 355, current_date + 10, 'pass', $2)`, [req, P.priya]);
    }
    await safetyReminders();
    await safetyReminders();
    expect(await notes(P.sam, 'Repair due tomorrow%')).toBe(1);
    expect(await notes(P.sam, 'Overdue action%')).toBe(1);
    expect(await notes(P.priya, 'Compliance due%Alder%')).toBe(1);
    expect(await notes(P.priya, 'Compliance%Birch%')).toBe(0);
    expect((await pool.query('select due_reminded_at is not null as d from repairs where id = $1', [r])).rows[0].d).toBe(true);
  });

  it('tells the property manager when a risk is added as high or rated up to high', async () => {
    const alex = await as('alex');
    const low = (await alex.post('/api/property-risks').send({ property_id: prop(1), title: 'Trip hazard on path', likelihood: 2, impact: 2 })).body;
    expect(await notes(P.priya, 'High risk%')).toBe(0);
    await alex.post('/api/property-risks').send({ property_id: prop(1), title: 'Blocked fire exit', likelihood: 3, impact: 5 });
    expect(await notes(P.priya, 'High risk%')).toBe(1);
    expect((await alex.patch(`/api/property-risks/${low.id}`).send({ likelihood: 4, impact: 4, assessment_note: 'Path now cracked across' })).status).toBe(200);
    expect(await notes(P.priya, 'High risk%')).toBe(2);
  });
});

describe('property activity, issue detection and health', () => {
  it('lists recorded activity for one property, with compliance only for those allowed', async () => {
    const sam = await as('sam');
    expect((await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Dripping kitchen tap', urgency: 'routine' })).status).toBe(201);
    await pool.query('update properties set compliance_enabled = true where id = $1', [prop(1)]);
    const req = (await pool.query(`insert into compliance_requirements (company_id, property_id, key, name, interval_days) values ($1,$2,'eicr','Electrical safety',1825) returning id`, [C.VH, prop(1)])).rows[0].id;
    await pool.query(`insert into compliance_records (requirement_id, completed_on, next_due_on, outcome, recorded_by) values ($1, current_date, current_date + 1825, 'pass', $2)`, [req, P.priya]);
    const kinds = async (who: any) => (await who.get(`/api/properties/${prop(1)}/timeline`)).body.map((t: any) => t.kind);
    expect(await kinds(sam)).toContain('repair');
    expect(await kinds(sam)).not.toContain('compliance');
    expect(await kinds(await as('priya'))).toContain('compliance');
    expect((await (await as('taylor')).get(`/api/properties/${prop(1)}/timeline`)).status).toBe(404);
  });

  it('flags repeat categories and slow repairs, and scores health from open problems', async () => {
    for (const d of [5, 20, 40]) await repair(prop(1), { category: 'plumbing', reported_on: new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10), status: 'closed', completed_on: new Date(Date.now() - (d - 1) * 86400_000).toISOString().slice(0, 10) });
    const slow = await repair(prop(1), { reported_on: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), due_on: new Date(Date.now() - 25 * 86400_000).toISOString().slice(0, 10) });
    const priya = await as('priya');
    const i = (await priya.get(`/api/safety/insights?property=${prop(1)}`)).body;
    expect(i.repeat_categories).toEqual([expect.objectContaining({ category: 'plumbing', count: 3 })]);
    expect(i.slow_repairs.map((r: any) => r.id)).toEqual([slow]);
    const card = (await priya.get(`/api/safety/overview?property=${prop(1)}`)).body[0];
    // The seed's scheduled check on this property is overdue too.
    expect(card.health).toMatchObject({ score: 80, reasons: [{ label: '1 overdue repair', points: 10 }, { label: '1 overdue scheduled check', points: 10 }], missing: ['No inspection recorded in the last 45 days'] });
    expect(card.compliance_score).toBeUndefined();
  });
});

describe('bulk changes and preferences', () => {
  it('changes many repairs at once, each checked and audited; closed ones and others’ are skipped', async () => {
    const a = await repair(prop(1), {}), b = await repair(prop(2), {}), closed = await repair(prop(1), { status: 'closed' });
    const priya = await as('priya');
    const r = (await priya.post('/api/repairs/bulk').send({ ids: [a, b, closed], patch: { contractor: 'Example Plumbing (fictional)', assignee_id: P.sam } })).body;
    expect(r.updated).toBe(2);
    expect(r.skipped).toEqual([{ id: closed, reason: 'Repair is closed' }]);
    expect((await pool.query(`select count(*)::int n from audit_log where entity = 'repair' and action = 'update' and detail->>'bulk' = 'true'`)).rows[0].n).toBe(2);
    expect(await notes(P.sam, 'Repair assigned to you%')).toBe(2);
    const s = (await (await as('sam')).post('/api/repairs/bulk').send({ ids: [a], patch: { contractor: 'Nope' } })).body;
    expect(s).toMatchObject({ updated: 0, skipped: [{ id: a, reason: 'No permission' }] });
    expect((await priya.post('/api/repairs/bulk').send({ ids: [a], patch: { title: 'x' } })).status).toBe(400);
  });

  it('keeps dashboard settings per person', async () => {
    const sam = await as('sam');
    expect((await sam.put('/api/me/preferences/repairs.tiles').send({ value: { hidden: ['spend'] } })).status).toBe(200);
    expect((await sam.get('/api/me/preferences/repairs.tiles')).body.value).toEqual({ hidden: ['spend'] });
    expect((await (await as('priya')).get('/api/me/preferences/repairs.tiles')).body.value).toBeNull();
    expect((await sam.put('/api/me/preferences/Bad Key').send({ value: 1 })).status).toBe(400);
  });
});
