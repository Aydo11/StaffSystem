// Phase 2: inspections from templates, the property risk register and safety actions.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, P, pool, prop, resetDb } from './helpers.ts';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
beforeEach(resetDb);

const weekly = async () => (await (await as('sam')).get(`/api/inspection-templates?company=${C.VH}`)).body.find((t: any) => t.kind === 'weekly');

describe('inspections', () => {
  it('ship with templates only, and no inspections, risks or actions', async () => {
    expect((await pool.query('select count(*)::int n from inspection_templates')).rows[0].n).toBe(0);
    await (await as('sam')).get(`/api/inspection-templates?company=${C.VH}`);
    expect((await pool.query(`select count(distinct kind)::int n from inspection_templates where company_id = $1`, [C.VH])).rows[0].n).toBe(8);
    expect((await pool.query('select count(*)::int n from inspections')).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from risks where property_id is not null')).rows[0].n).toBe(0);
  });

  it('every question is answered; a failed item opens an action or a repair', async () => {
    const sam = await as('sam'), priya = await as('priya');
    const t = await weekly();
    const all = (over: Record<string, object> = {}) => t.items.map((q: any) => ({ key: q.key, result: 'pass', ...(over[q.key] ?? {}) }));
    const send = (items: any[], who = sam) => who.post('/api/inspections').send({ property_id: prop(1), template_id: t.id, location: 'Ground floor', items });
    expect((await send(all().slice(1))).status).toBe(400); // one unanswered
    expect((await send(all({ escape_routes: { result: 'fail', comment: 'Bikes in hallway' } }))).status).toBe(400); // no severity / follow-up
    expect((await send(all(), await as('taylor'))).status).toBe(404); // cannot see the property

    const r = await send(all({
      escape_routes: { result: 'fail', comment: 'Bikes blocking the hallway', severity: 'high', follow_up: 'action', owner_id: P.sam },
      security: { result: 'fail', comment: 'Back door lock broken', severity: 'medium', follow_up: 'repair' },
      bins: { result: 'na' },
    }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ passed: t.items.length - 3, failed: 2, not_applicable: 1 });
    const action = r.body.items.find((i: any) => i.key === 'escape_routes');
    const repair = r.body.items.find((i: any) => i.key === 'security');
    const x = (await pool.query('select source_type, significance, owner_id, status from improvement_actions where id = $1', [action.action_id])).rows[0];
    expect(x).toMatchObject({ source_type: 'inspection', significance: 'significant', owner_id: P.sam, status: 'open' });
    // "lock broken" suggests urgent, which is above the medium (routine) severity, so the repair is raised to urgent.
    expect((await pool.query('select urgency, location from repairs where id = $1', [repair.repair_id])).rows[0]).toMatchObject({ urgency: 'urgent', location: 'Ground floor' });

    expect((await sam.post(`/api/inspection-items/${action.id}/photos`).attach('file', png, 'hall.png')).status).toBe(201);
    const d = (await priya.get(`/api/inspections/${r.body.id}`)).body;
    expect(d.items[0].result).toBe('fail');
    expect(d.items.find((i: any) => i.key === 'escape_routes').photos).toHaveLength(1);
    // The safety manager can verify the action (they are not its owner); the owner cannot.
    await sam.post(`/api/actions/${action.action_id}/evidence`).field('note', 'Bikes moved to the shed');
    expect((await sam.post(`/api/actions/${action.action_id}/verify`).send({ accept: true, note: 'Mine' })).status).toBe(403);
    expect((await priya.post(`/api/actions/${action.action_id}/verify`).send({ accept: true, note: 'Hallway clear on visit' })).status).toBe(200);
    const list = (await priya.get(`/api/safety/actions?property=${prop(1)}`)).body;
    expect(list.find((a: any) => a.id === action.action_id).status).toBe('verified');
  });
});

describe('property risk register', () => {
  it('managers add risks with references; a risk closes only once its actions are verified, and not by its owner', async () => {
    const sam = await as('sam'), priya = await as('priya'), alex = await as('alex');
    const body = { property_id: prop(1), location: 'Kitchen', category: 'fire', title: 'Overloaded extension leads', likelihood: 3, impact: 5, controls: 'Weekly check', owner_id: P.priya, review_on: '2026-12-01' };
    expect((await sam.post('/api/property-risks').send(body)).status).toBe(403);
    const r = (await priya.post('/api/property-risks').send(body)).body;
    expect(r).toMatchObject({ ref: 'R-0001', status: 'open' });
    expect((await priya.post('/api/property-risks').send({ ...body, title: 'Loose stair carpet' })).body.ref).toBe('R-0002');

    expect((await priya.patch(`/api/property-risks/${r.id}`).send({ likelihood: 4 })).status).toBe(400); // a rating change needs a reason
    expect((await priya.patch(`/api/property-risks/${r.id}`).send({ likelihood: 4, assessment_note: 'Seen again on the weekly check' })).status).toBe(200);

    const x = (await priya.post('/api/actions').send({ company_id: C.VH, source_type: 'risk', source_id: r.id, finding: 'Extension leads daisy-chained', action: 'Fit extra sockets', owner_id: P.sam })).body;
    expect((await alex.post(`/api/property-risks/${r.id}/close`).send({ note: 'All checked' })).status).toBe(409); // action not verified
    expect((await priya.post(`/api/property-risks/${r.id}/close`).send({ note: 'All checked' })).status).toBe(403); // the owner cannot close it
    await sam.post(`/api/actions/${x.id}/evidence`).field('note', 'Electrician fitted two double sockets');
    await priya.post(`/api/actions/${x.id}/verify`).send({ accept: true, note: 'Saw the new sockets' });
    expect((await alex.post(`/api/property-risks/${r.id}/close`).send({ note: 'Sockets fitted, leads removed' })).status).toBe(200);

    const d = (await priya.get(`/api/property-risks/${r.id}`)).body;
    expect(d.risk).toMatchObject({ status: 'closed', score: 20, closure_note: 'Sockets fitted, leads removed' });
    expect(d.assessments).toHaveLength(2);
    // The governance register cannot close a risk with unverified actions either.
    const r2 = (await priya.get(`/api/property-risks?property=${prop(1)}`)).body.find((x: any) => x.ref === 'R-0002');
    await priya.post('/api/actions').send({ company_id: C.VH, source_type: 'risk', source_id: r2.id, finding: 'Loose carpet', action: 'Re-fit carpet' });
    expect((await alex.patch(`/api/risks/${r2.id}`).send({ status: 'closed' })).status).toBe(409);
  });

  it('the overview shows each property with its risks and inspections, and compliance only where it is on', async () => {
    const priya = await as('priya');
    await priya.post('/api/property-risks').send({ property_id: prop(1), title: 'Trip hazard at the back step', likelihood: 4, impact: 4 });
    const rows = (await priya.get('/api/safety/overview')).body;
    const p1 = rows.find((p: any) => p.id === prop(1));
    expect(p1).toMatchObject({ open_risks: 1, high_risks: 1, last_inspection: null });
    expect('compliance_score' in p1).toBe(false);
    await (await as('alex')).patch(`/api/compliance/properties/${prop(1)}`).send({ enabled: true });
    expect((await priya.get('/api/safety/overview')).body.find((p: any) => p.id === prop(1)).compliance_score).toBe(0);
  });
});
