// Phase 1: the fuller repairs workflow, suggested priority, targets, dashboard figures, and selective property compliance.
import { beforeEach, describe, expect, it } from 'vitest';
import { suggestUrgency } from '../server/repairPriority.ts';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

beforeEach(resetDb);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

describe('suggested priority', () => {
  it('reads safety words', () => {
    expect(suggestUrgency('Smell of gas in the kitchen').urgency).toBe('emergency');
    expect(suggestUrgency('Fire door does not close').urgency).toBe('urgent');
    expect(suggestUrgency('Kitchen tap leaking').urgency).toBe('urgent');
    expect(suggestUrgency('Repaint the hallway').urgency).toBe('planned');
    expect(suggestUrgency('Wardrobe handle loose').urgency).toBe('routine');
  });
  it('is raised for staff, and lowering it needs a repairs manager and a reason', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const r = await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Smell of gas in the kitchen', urgency: 'routine', category: 'heating', location: 'Kitchen' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ urgency: 'emergency', suggested_urgency: 'emergency', category: 'heating', location: 'Kitchen' });
    expect(r.body.due_on).toBe(addDays(today(), 1));
    expect((await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Door sticks', urgency: 'routine', contractor: 'Acme' })).status).toBe(403);
    expect((await priya.post('/api/repairs').send({ property_id: prop(1), title: 'Tap leaking slowly', urgency: 'planned' })).status).toBe(400);
    const ok = await priya.post('/api/repairs').send({ property_id: prop(1), title: 'Tap leaking slowly', urgency: 'planned', urgency_reason: 'Drip into a bowl, part on order' });
    expect(ok.body).toMatchObject({ urgency: 'planned', urgency_reason: 'Drip into a bowl, part on order' });
    expect((await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Door sticks', urgency: 'routine', reported_on: addDays(today(), 2) })).status).toBe(400);
  });
  it('uses the company target days', async () => {
    const priya = await as('priya'), sam = await as('sam');
    expect((await sam.put('/api/repairs/sla').send({ company_id: C.VH, targets: [{ urgency: 'routine', target_days: 10, escalate_after_days: 2 }] })).status).toBe(403);
    expect((await priya.put('/api/repairs/sla').send({ company_id: C.VH, targets: [{ urgency: 'routine', target_days: 10, escalate_after_days: 2 }] })).status).toBe(200);
    const r = await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Wardrobe handle loose', urgency: 'routine' });
    expect(r.body.due_on).toBe(addDays(today(), 10));
  });
});

describe('repairs workflow', () => {
  it('completion needs evidence, verification is by someone else, closed is locked and reopening needs a reason', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const r = (await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Wardrobe handle loose', urgency: 'routine', category: 'furniture' })).body;
    const move = (who: any, status: string, extra: object = {}) => who.post(`/api/repairs/${r.id}/status`).send({ status, note: 'Moving it on', ...extra });
    expect((await move(sam, 'under_review')).status).toBe(403);
    expect((await move(priya, 'under_review')).status).toBe(200);
    expect((await move(priya, 'assigned')).status).toBe(400); // nobody assigned yet
    await priya.patch(`/api/repairs/${r.id}`).send({ assignee_id: P.sam });
    expect((await move(priya, 'assigned')).status).toBe(200);
    expect((await move(sam, 'awaiting_parts')).status).toBe(200);
    expect((await move(sam, 'completed')).status).toBe(400); // no work description
    expect((await move(sam, 'completed', { work_description: 'Fixed', completed_on: addDays(today(), 3) })).status).toBe(400);
    expect((await move(sam, 'completed', { work_description: 'New handle fitted', cost: 12.5, contractor_attended: false, resident_confirmed: true })).status).toBe(200);
    expect((await move(sam, 'verified')).status).toBe(403);
    expect((await move(priya, 'verified')).status).toBe(200);
    expect((await move(priya, 'closed')).status).toBe(200);

    expect((await priya.patch(`/api/repairs/${r.id}`).send({ cost: 1 })).status).toBe(409);
    expect((await sam.post(`/api/repairs/${r.id}/updates`).field('body', 'Later note')).status).toBe(409);
    expect((await sam.post(`/api/repairs/${r.id}/status`).send({ status: 'reopened', note: 'Handle loose again' })).status).toBe(403);
    expect((await priya.post(`/api/repairs/${r.id}/status`).send({ status: 'reopened', note: 'no' })).status).toBe(400);
    expect((await priya.post(`/api/repairs/${r.id}/status`).send({ status: 'reopened', note: 'Handle loose again' })).status).toBe(200);

    const row = (await pool.query('select status, completed_on, verified_at, closed_at, cost from repairs where id = $1', [r.id])).rows[0];
    expect(row).toMatchObject({ status: 'reopened', completed_on: null, verified_at: null, closed_at: null, cost: '12.50' });
    expect((await pool.query('select status from tasks where id = $1', [r.task_id])).rows[0].status).toBe('in_progress');
    const hist = (await priya.get(`/api/repairs/${r.id}`)).body.updates.filter((u: any) => u.status_to).map((u: any) => u.status_to);
    expect(hist).toEqual(['under_review', 'assigned', 'awaiting_parts', 'completed', 'verified', 'closed', 'reopened']);
    // Field changes are audited with before and after.
    const a = (await pool.query(`select detail from audit_log where entity = 'repair' and entity_id = $1 and action = 'update'`, [r.id])).rows[0].detail;
    expect(a.assignee_id).toEqual({ from: null, to: P.sam });
  });
  it('cancelling needs a repairs manager and a reason, and completes the task', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const r = (await sam.post('/api/repairs').send({ property_id: prop(1), title: 'Wardrobe handle loose', urgency: 'routine' })).body;
    expect((await sam.post(`/api/repairs/${r.id}/status`).send({ status: 'cancelled', note: 'Duplicate report' })).status).toBe(403);
    expect((await priya.post(`/api/repairs/${r.id}/status`).send({ status: 'cancelled', note: 'Duplicate report of the same handle' })).status).toBe(200);
    expect((await pool.query('select status from tasks where id = $1', [r.task_id])).rows[0].status).toBe('completed');
  });
});

describe('repairs dashboard figures', () => {
  it('counts from the records', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const mk = async (title: string, urgency: string, category: string) => (await sam.post('/api/repairs').send({ property_id: prop(2), title, urgency, category })).body;
    const a = await mk('Smell of gas by the boiler', 'emergency', 'heating');
    const b = await mk('Radiator cold', 'routine', 'heating'); // repeat heating at the same property
    const c = await mk('Wardrobe handle loose', 'routine', 'furniture');
    const d = await mk('Shelf wobbly', 'routine', 'furniture');
    await pool.query(`update repairs set due_on = $2 where id = $1`, [c.id, addDays(today(), -1)]); // overdue
    // b done within target with a cost; d done late without a cost.
    await pool.query(`update repairs set status = 'completed', completed_on = $2, cost = 80 where id = $1`, [b.id, today()]);
    await pool.query(`update repairs set status = 'closed', reported_on = $2, due_on = $3, completed_on = $4, closed_at = now() where id = $1`, [d.id, addDays(today(), -4), addDays(today(), -2), today()]);
    const s = (await priya.get(`/api/repairs/summary?property=${prop(2)}`)).body;
    expect(s).toMatchObject({ open: 3, emergency: 1, overdue: 1, completed: 2, within_target: 1, repeat: 2, spend_missing: 1 });
    expect(Number(s.spend)).toBe(80);
    expect(Number(s.avg_days)).toBe(2);
    expect(s.by_category).toMatchObject({ heating: 2, furniture: 1 });
    expect(a.id).toBeTruthy();
    // A member of staff who cannot see the property gets nothing from it.
    const taylor = (await (await as('taylor')).get(`/api/repairs/summary?property=${prop(2)}`)).body;
    expect(taylor.open).toBe(0);
  });
});

describe('selective property compliance', () => {
  it('is off for every property and nothing is reported until an administrator turns it on', async () => {
    expect((await pool.query('select count(*)::int n from properties where compliance_enabled')).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from compliance_records')).rows[0].n).toBe(0);
    const alex = await as('alex'), priya = await as('priya');
    expect((await alex.get('/api/compliance/dashboard')).body).toMatchObject({ properties: 0, score: null, overdue: 0 });
    // Managers see nothing while it is off and cannot turn it on.
    expect((await priya.get('/api/compliance/properties')).body).toEqual([]);
    expect((await priya.get(`/api/compliance/properties/${prop(1)}`)).status).toBe(404);
    expect((await priya.patch(`/api/compliance/properties/${prop(1)}`).send({ enabled: true })).status).toBe(403);
    // Administrators see every property, all off.
    const all = (await alex.get(`/api/compliance/properties?company=${C.VH}`)).body;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p: any) => !p.compliance_enabled && p.score === null)).toBe(true);
  });

  it('turns on per property, records evidence, scores, and keeps everything when turned off', async () => {
    const alex = await as('alex'), priya = await as('priya'), sam = await as('sam');
    expect((await alex.patch(`/api/compliance/properties/${prop(1)}`).send({ enabled: true, classification: 'windrush' })).status).toBe(200);
    const d = (await priya.get(`/api/compliance/properties/${prop(1)}`)).body;
    expect(d.requirements).toHaveLength(12);
    expect(d.requirements.every((r: any) => r.state === 'never_done')).toBe(true);
    expect(d.can).toEqual({ manage: false, record: true });
    expect((await sam.get(`/api/compliance/properties/${prop(1)}`)).status).toBe(404);

    const gas = d.requirements.find((r: any) => r.key === 'gas');
    const eicr = d.requirements.find((r: any) => r.key === 'eicr');
    const epc = d.requirements.find((r: any) => r.key === 'epc');
    expect((await priya.post(`/api/compliance/requirements/${gas.id}/records`).field('completed_on', addDays(today(), 1)).field('outcome', 'pass')).status).toBe(400);
    const rec = await priya.post(`/api/compliance/requirements/${gas.id}/records`).field('completed_on', addDays(today(), -10)).field('outcome', 'pass').attach('file', Buffer.from('%PDF-1.4 cert'), 'cp12.pdf');
    expect(rec.status).toBe(201);
    expect(rec.body.record.next_due_on).toBe(addDays(today(), 355));
    expect((await priya.post(`/api/compliance/requirements/${eicr.id}/records`).field('completed_on', today()).field('outcome', 'fail').field('findings', 'C2 defects')).status).toBe(400);
    const fail = await priya.post(`/api/compliance/requirements/${eicr.id}/records`).field('completed_on', today()).field('outcome', 'fail').field('findings', 'C2 defects on two circuits').field('corrective_action', 'Electrician to remedy C2s');
    expect(fail.body.action.id).toBeTruthy();
    // Not applicable: administrators only, with a reason; it leaves the score.
    expect((await priya.patch(`/api/compliance/requirements/${epc.id}`).send({ not_applicable: true, na_reason: 'Exempt' })).status).toBe(403);
    expect((await alex.patch(`/api/compliance/requirements/${epc.id}`).send({ not_applicable: true })).status).toBe(400);
    expect((await alex.patch(`/api/compliance/requirements/${epc.id}`).send({ not_applicable: true, na_reason: 'Listed building, exempt' })).status).toBe(200);

    // Verification by someone other than the recorder.
    expect((await priya.post(`/api/compliance/records/${rec.body.record.id}/verify`)).status).toBe(403);
    expect((await alex.post(`/api/compliance/records/${rec.body.record.id}/verify`)).status).toBe(200);

    const dash = (await alex.get('/api/compliance/dashboard')).body;
    expect(dash).toMatchObject({ properties: 1, compliant_properties: 0, applicable: 11, compliant: 1, score: 9, failed: 1, never_done: 9, outstanding_actions: 1, unverified: 1 });
    expect(dash.by_agent[0]).toMatchObject({ agent: 'No managing agent', properties: 1 });

    // Off again: hidden from managers and from the dashboard, but nothing is deleted.
    expect((await alex.patch(`/api/compliance/properties/${prop(1)}`).send({ enabled: false })).status).toBe(200);
    expect((await priya.get(`/api/compliance/properties/${prop(1)}`)).status).toBe(404);
    expect((await alex.get('/api/compliance/dashboard')).body.properties).toBe(0);
    expect((await pool.query('select count(*)::int n from compliance_records')).rows[0].n).toBe(2);
    expect((await alex.post(`/api/compliance/requirements/${gas.id}/records`).field('completed_on', today()).field('outcome', 'pass')).status).toBe(409);
    // On again: the same checklist, no duplicates, history intact.
    await alex.patch(`/api/compliance/properties/${prop(1)}`).send({ enabled: true });
    const again = (await alex.get(`/api/compliance/properties/${prop(1)}`)).body;
    expect(again.requirements).toHaveLength(12);
    expect(again.records).toHaveLength(2);
    expect(again.history.filter((h: any) => ['enable', 'disable'].includes(h.action)).map((h: any) => h.action)).toEqual(['enable', 'disable', 'enable']);
  });

  it('bulk turns on only the chosen properties and only for administrators', async () => {
    const alex = await as('alex'), priya = await as('priya');
    expect((await priya.post('/api/compliance/properties/bulk').send({ property_ids: [prop(2)], enabled: true })).status).toBe(403);
    const f = await alex.post('/api/compliance/frameworks').send({ company_id: C.VH, name: 'Windrush contract', items: [{ key: 'gas', name: 'Gas safety', interval_days: 365 }, { key: 'fra', name: 'Fire risk assessment', interval_days: 365 }] });
    expect(f.status).toBe(201);
    expect((await alex.post('/api/compliance/properties/bulk').send({ property_ids: [prop(2), prop(3)], enabled: true, classification: 'windrush', framework_id: f.body.id })).body.updated).toBe(2);
    expect((await pool.query('select count(*)::int n from properties where compliance_enabled')).rows[0].n).toBe(2);
    expect((await pool.query('select count(*)::int n from compliance_requirements where property_id = $1', [prop(2)])).rows[0].n).toBe(2);
    const dash = (await alex.get('/api/compliance/dashboard?classification=windrush')).body;
    expect(dash.properties).toBe(2);
    expect(dash.by_agent.map((g: any) => g.agent).sort()).toEqual(['Example Lettings Agent (fictional)', 'No managing agent']);
    expect((await alex.get('/api/compliance/dashboard?agent=No%20managing%20agent')).body.properties).toBe(1);
  });
});
