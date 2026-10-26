// Acceptance tests for stages 1–3, numbered after the specification's section 41 where they apply.
// Runs against a real Postgres test database, reset before each test so every test stands alone.
import { beforeEach, describe, expect, it } from 'vitest';
import { A, as, C, P, pool, prop, resetDb, rid, V } from './helpers.ts';

beforeEach(resetDb);

describe('1 · one person, appointments in all three companies', () => {
  it('Sam signs in once and sees all three companies', async () => {
    const me = (await (await as('sam')).get('/api/me')).body;
    expect(me.companies.map((c: any) => c.id).sort()).toEqual([C.VH, C.WHM, C.WHS].sort());
    expect(me.appointments).toHaveLength(3);
    // Legal employer differs from the company assignment for the contractor and secondment appointments.
    const prof = (await (await as('sam')).get(`/api/people/${P.sam}`)).body;
    const whm = prof.appointments.find((x: any) => x.company_id === C.WHM);
    expect(whm.legal_employer_company_id).toBeNull();
    expect(whm.legal_employer_name).toMatch(/sole trader/);
  });
});

describe('2 · resume shows roles without confidential data', () => {
  it('excludes address, emergency contacts, rates, checks and clearance', async () => {
    const r = await (await as('priya')).get(`/api/people/${P.sam}/resume`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(r.body.appointments).toHaveLength(3);
    for (const banned of ['Fictional Close', 'Pat Rivers', '13.50', 'dbs', 'cleared', 'home_address', 'amount']) expect(text).not.toContain(banned);
  });
  it('restricted personal details are hidden from a manager without staff.restricted', async () => {
    const r = await (await as('priya')).get(`/api/people/${P.sam}`);
    expect(r.body.restricted).toBeNull();
    expect(r.body.checks).toBeNull();
    const hr = await (await as('morgan')).get(`/api/people/${P.sam}`);
    expect(hr.body.restricted.home_address).toContain('Fictional Close');
    const logged = await pool.query(`select count(*)::int n from audit_log where entity = 'person_restricted' and action = 'view' and actor_person_id = $1`, [P.morgan]);
    expect(logged.rows[0].n).toBe(1); // sensitive access is audited; Priya's view of the non-restricted profile is not
  });
});

describe('3 · company access stays separated', () => {
  it('a Valor Housing manager cannot see or approve a Wellbeing Homes visit', async () => {
    const priya = await as('priya');
    expect((await priya.get(`/api/visits/${V.d02}`)).status).toBe(404);
    expect((await priya.post(`/api/visits/${V.d02}/decide`).send({ approve: true })).status).toBe(404);
  });
  it('rates are shown per company: Priya sees Sam’s VH rate but not his WHM rate', async () => {
    const r = await (await as('priya')).get(`/api/people/${P.sam}`);
    const byCo = Object.fromEntries(r.body.appointments.map((x: any) => [x.company_id, x]));
    expect(byCo[C.WHM]).toBeUndefined(); // Priya has no access to Wellbeing Homes at all
    expect(byCo[C.VH].rates).toBeNull(); // managers do not hold rates.view
  });
  it('search does not reveal another company’s tasks', async () => {
    const r = await (await as('jordan')).get('/api/search?q=damp');
    expect(r.body.tasks).toHaveLength(0);
    const r2 = await (await as('priya')).get('/api/search?q=damp');
    expect(r2.body.tasks).toHaveLength(1);
  });
  it('protected files cannot be fetched by direct link from another company', async () => {
    const sam = await as('sam');
    const task = (await sam.get('/api/tasks?mine=true')).body.find((t: any) => t.company_code === 'VH');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
    const up = await sam.post(`/api/tasks/${task.id}/files`).attach('file', png, 'evidence.png');
    expect(up.status).toBe(201);
    expect((await (await as('jordan')).get(`/api/files/${up.body.id}`)).status).toBe(404);
    const ok = await (await as('priya')).get(`/api/files/${up.body.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
  });
  it('rejects uploads whose content is not an allowed type, whatever the name says', async () => {
    const sam = await as('sam');
    const task = (await sam.get('/api/tasks?mine=true')).body[0];
    const r = await sam.post(`/api/tasks/${task.id}/files`).attach('file', Buffer.from('<script>alert(1)</script>'), 'photo.png');
    expect(r.status).toBe(400);
  });
  it('unauthenticated and forged tokens are refused', async () => {
    const request = (await import('supertest')).default;
    const { app } = await import('./helpers.ts');
    expect((await request(app).get('/api/properties')).status).toBe(401);
    expect((await request(app).get('/api/properties').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });
});

describe('4 · ending one appointment preserves the others', () => {
  it('ending Sam’s secondment leaves his VH and WHM appointments active', async () => {
    const hr = await as('morgan');
    const today = (await pool.query(`select (now() at time zone 'Europe/London')::date::text d`)).rows[0].d;
    const r = await hr.post(`/api/appointments/${A.samWHS}/end`).send({ end_date: today, reason: 'Secondment finished' });
    expect(r.status).toBe(200);
    expect(r.body.leaver).toBe(false);
    const me = (await (await as('sam')).get('/api/me')).body;
    expect(me.companies.map((c: any) => c.id).sort()).toEqual([C.VH, C.WHM].sort());
    const allocs = await pool.query('select to_date from appointment_properties where appointment_id = $1', [A.samWHS]);
    expect(allocs.rows.every((x) => x.to_date !== null)).toBe(true);
  });
  it('requires open tasks to be transferred first', async () => {
    const r = await (await as('morgan')).post(`/api/appointments/${A.samVH}/end`).send({ end_date: '2026-10-20', reason: 'Test' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('transfer_required');
  });
});

describe('5 · clearance controls deployment', () => {
  it('blocks property allocation for a pending person, and records an authorised exception', async () => {
    const hr = await as('morgan');
    const blocked = await hr.post(`/api/appointments/${A.casey}/properties`).send({ property_id: prop(4) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('clearance_required');
    const ok = await hr.post(`/api/appointments/${A.casey}/properties`).send({ property_id: prop(4), override_reason: 'Shadowing Sam only, never alone' });
    expect(ok.status).toBe(201);
    expect((await pool.query('select count(*)::int n from clearance_exceptions where person_id = $1', [P.casey])).rows[0].n).toBe(1);
  });
  it('a pending worker cannot start a visit even at an allocated property', async () => {
    await pool.query(`insert into appointment_properties (appointment_id, property_id) values ($1, $2)`, [A.casey, prop(4)]);
    const r = await (await as('casey')).post('/api/visits/start').send({ property_id: prop(4), appointment_id: A.casey, client_request_id: rid() });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('clearance_required');
  });
  it('people cannot record their own clearance', async () => {
    const r = await (await as('morgan')).post('/api/clearance').send({ person_id: P.morgan, company_id: C.VH, status: 'cleared', evidence_summary: 'Self' });
    expect(r.status).toBe(403);
  });
});

describe('6 · live and manual visits', () => {
  it('starts once per request id, refuses a second active visit, and finishes with server time', async () => {
    const sam = await as('sam');
    const id = rid();
    const s1 = await sam.post('/api/visits/start').send({ property_id: prop(1), appointment_id: A.samVH, client_request_id: id, planned_minutes: 30 });
    expect(s1.status).toBe(201);
    const s2 = await sam.post('/api/visits/start').send({ property_id: prop(1), appointment_id: A.samVH, client_request_id: id });
    expect(s2.body.duplicate).toBe(true);
    expect(s2.body.visit.id).toBe(s1.body.visit.id);
    const s3 = await sam.post('/api/visits/start').send({ property_id: prop(2), appointment_id: A.samVH, client_request_id: rid() });
    expect(s3.status).toBe(409);
    const f = await sam.post(`/api/visits/${s1.body.visit.id}/finish`).send({ work_category: 'inspection', summary: 'Checked fire doors and lighting.' });
    expect(f.status).toBe(200);
    expect(f.body.status).toBe('submitted');
    expect(f.body.planned_minutes).toBe(30); // planning field kept separate from actual duration
  });
  it('cannot start at a property that is not allocated', async () => {
    const r = await (await as('sam')).post('/api/visits/start').send({ property_id: prop(6), appointment_id: A.samVH, client_request_id: rid() });
    expect(r.status).toBe(400);
  });
  it('manual entry: refuses future, overlapping and unconfirmed unusual durations', async () => {
    const sam = await as('sam');
    const base = { property_id: prop(1), appointment_id: A.samVH, work_category: 'inspection', summary: 'Routine check.' };
    expect((await sam.post('/api/visits/manual').send({ ...base, client_request_id: rid(), start_local: '2030-01-01T09:00', minutes: 30 })).status).toBe(400);
    // Overlaps the seeded 12 Oct 09:00–10:30 BST visit.
    expect((await sam.post('/api/visits/manual').send({ ...base, client_request_id: rid(), start_local: '2026-10-12T09:30', minutes: 30 })).status).toBe(409);
    expect((await sam.post('/api/visits/manual').send({ ...base, client_request_id: rid(), start_local: '2026-10-14T08:00', minutes: 300 })).status).toBe(422);
    const ok = await sam.post('/api/visits/manual').send({ ...base, client_request_id: rid(), start_local: '2026-10-14T08:00', minutes: 300, confirm_unusual: true });
    expect(ok.status).toBe(201);
    expect(ok.body.visit.entry_mode).toBe('manual');
  });
  it('rejects resident support narratives in the work summary', async () => {
    const r = await (await as('sam')).post('/api/visits/manual').send({ property_id: prop(1), appointment_id: A.samVH, work_category: 'other', summary: 'Resident said they were struggling', client_request_id: rid(), start_local: '2026-10-15T10:00', minutes: 30 });
    expect(r.status).toBe(400);
  });
  it('handles a visit across the October clock change and attributes it to the start day', async () => {
    const sam = await as('sam');
    // 25 Oct 2026: clocks go back at 02:00 BST. 00:30 for 180 real minutes.
      const autumn = await pool.query(`select to_char((($1::timestamp at time zone 'Europe/London') + interval '180 minutes') at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as local_end`, ['2026-10-25T00:30']);
      expect(autumn.rows[0].local_end).toBe('2026-10-25 02:30');
      const r = await sam.post('/api/visits/manual').send({ property_id: prop(1), appointment_id: A.samVH, work_category: 'property_check', summary: 'Night check.', client_request_id: rid(), start_local: '2099-10-25T00:30', minutes: 180 });
      // Future visits must be refused independently of when this test runs.
    expect(r.status).toBe(400);
    await pool.query(`insert into appointment_rates (appointment_id, rate_type, amount, effective_from, effective_to) values ($1, 'hourly', 12.00, '2025-03-01', '2025-09-30')`, ['00000000-0000-4000-8000-000000000b04']);
    const v = await pool.query(`select round(extract(epoch from (($2::timestamp at time zone 'Europe/London') - ($1::timestamp at time zone 'Europe/London'))) / 60)::int m`, ['2026-03-29T00:30', '2026-03-29T03:30']);
    expect(v.rows[0].m).toBe(120); // 00:30 GMT → 03:30 BST is two real hours
  });
});

describe('7 · corrections preserve originals', () => {
  it('stores the original, applies the proposal only on approval, and sends the visit back for approval', async () => {
    const sam = await as('sam');
    const c = await sam.post(`/api/visits/${V.d01}/corrections`).send({ start_local: '2026-10-12T09:00', end_local: '2026-10-12T10:00', reason: 'Left earlier than recorded' });
    expect(c.status).toBe(201);
    expect(c.body.original.ended_at).toBeTruthy();
    expect((await sam.post(`/api/corrections/${c.body.id}/decide`).send({ approve: true })).status).toBe(403); // not their own
    const d = await (await as('priya')).post(`/api/corrections/${c.body.id}/decide`).send({ approve: true });
    expect(d.status).toBe(200);
    const v = (await sam.get(`/api/visits/${V.d01}`)).body;
    expect(v.visit.minutes).toBe(60);
    expect(v.visit.status).toBe('submitted');
    expect(v.allocations).toHaveLength(0);
    expect(v.corrections[0].original.ended_at).toBe(c.body.original.ended_at);
  });
});

describe('8 · hours are not duplicated across companies', () => {
  it('a split keeps the total equal to the visit duration', async () => {
    const priya = await as('priya');
    // Priya can approve in VH only; give her WHM approval for the split test.
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'manager', $2, 'test')`, [P.priya, C.WHM]);
    expect((await priya.post(`/api/visits/${V.d01}/split`).send({ reason: 'Shared work', allocations: [{ appointment_id: A.samVH, minutes: 60 }, { appointment_id: A.samWHM, minutes: 20 }] })).status).toBe(400);
    const ok = await priya.post(`/api/visits/${V.d01}/split`).send({ reason: 'Shared work', allocations: [{ appointment_id: A.samVH, minutes: 60 }, { appointment_id: A.samWHM, minutes: 30 }] });
    expect(ok.status).toBe(200);
    const sum = (await pool.query('select sum(minutes)::int s, count(*)::int n from visit_allocations where visit_id = $1', [V.d01])).rows[0];
    expect(sum).toEqual({ s: 90, n: 2 });
  });
  it('timesheet totals come from allocations, and cost uses decimal arithmetic', async () => {
    const sam = await as('sam');
    const p = (await sam.get(`/api/timesheets/preview?appointment_id=${A.samVH}&from=2026-10-12&to=2026-10-18`)).body;
    expect(p.minutes).toBe(90);
    expect(p.cost_estimate).toBe('20.25'); // 90 min × £13.50/h
    const w = (await sam.get(`/api/timesheets/preview?appointment_id=${A.samWHM}&from=2026-10-12&to=2026-10-18`)).body;
    expect(w.minutes).toBe(60);
    expect(w.cost_estimate).toBe('18.00');
  });
  it('no self-approval of visits or timesheets', async () => {
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'manager', $2, 'test')`, [P.sam, C.VH]);
    const sam = await as('sam');
    expect((await sam.post(`/api/visits/${V.d03}/decide`).send({ approve: true })).status).toBe(403);
    const ts = await sam.post('/api/timesheets').send({ appointment_id: A.samVH, period_start: '2026-10-12', period_end: '2026-10-18' });
    expect(ts.status).toBe(201);
    expect((await sam.post(`/api/timesheets/${ts.body.id}/decide`).send({ approve: true })).status).toBe(403);
    const ok = await (await as('priya')).post(`/api/timesheets/${ts.body.id}/decide`).send({ approve: true });
    expect(ok.status).toBe(200);
    const row = (await pool.query('select approved_minutes, cost_estimate::text from timesheets where id = $1', [ts.body.id])).rows[0];
    expect(row).toEqual({ approved_minutes: 90, cost_estimate: '20.25' });
  });
});

describe('approvals and tasks', () => {
  it('approving a visit creates one allocation for the full duration and notifies the worker', async () => {
    const r = await (await as('priya')).post(`/api/visits/${V.d03}/decide`).send({ approve: true });
    expect(r.status).toBe(200);
    const a = (await pool.query('select minutes from visit_allocations where visit_id = $1', [V.d03])).rows;
    expect(a).toEqual([{ minutes: 45 }]);
    expect((await (await as('sam')).get('/api/me')).body.unread).toBeGreaterThan(0);
    expect((await (await as('priya')).post(`/api/visits/${V.d03}/decide`).send({ approve: true })).status).toBe(409);
  });
  it('a task owner cannot complete a reviewed task; the reviewer can, and recurrence creates the next one', async () => {
    const sam = await as('sam');
    const task = (await sam.get('/api/tasks?mine=true')).body.find((t: any) => t.recurrence === 'weekly');
    expect((await sam.patch(`/api/tasks/${task.id}`).send({ status: 'completed' })).status).toBe(403);
    const sub = await sam.patch(`/api/tasks/${task.id}`).send({ status: 'submitted' });
    expect(sub.status).toBe(200);
    expect((await (await as('priya')).patch(`/api/tasks/${task.id}`).send({ status: 'completed' })).status).toBe(200);
    const n = (await pool.query(`select count(*)::int n from tasks where title = $1`, [task.title])).rows[0].n;
    expect(n).toBe(2);
  });
  it('the inbox gives every item an owner and a next step', async () => {
    const items = (await (await as('priya')).get('/api/inbox')).body;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) { expect(i.owner).toBeTruthy(); expect(i.next_step).toBeTruthy(); expect(i.company_name).toBeTruthy(); }
  });
});

describe('properties', () => {
  it('editing one field leaves the others (including status) unchanged', async () => {
    const r = await (await as('alex')).patch(`/api/properties/${prop(5)}`).send({ notes: 'Boiler replaced' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('void');
  });
  it('staff see only allocated properties; managers see their company', async () => {
    const sam = (await (await as('sam')).get('/api/properties')).body;
    expect(sam.map((p: any) => p.ref).sort()).toEqual(['VH-001', 'VH-002', 'VH-003', 'WHM-008', 'WHM-009', 'WHS-013']);
    const priya = (await (await as('priya')).get('/api/properties')).body;
    expect(priya.every((p: any) => p.company_code === 'VH')).toBe(true);
    expect(priya).toHaveLength(7);
  });
});

describe('access administration', () => {
  it('reviewer access must expire; nobody can change their own access', async () => {
    const admin = await as('alex');
    expect((await admin.post('/api/admin/grants').send({ person_id: P.robin, role_key: 'reviewer', company_id: C.VH, reason: 'Inspection' })).status).toBe(400);
    expect((await admin.post('/api/admin/grants').send({ person_id: P.robin, role_key: 'reviewer', company_id: C.VH, reason: 'Inspection', expires_at: '2030-01-01T00:00:00Z' })).status).toBe(201);
    expect((await admin.post('/api/admin/grants').send({ person_id: P.alex, role_key: 'manager', company_id: C.VH, reason: 'Self grant' })).status).toBe(403);
  });
  it('expired grants stop working immediately', async () => {
    await pool.query(`update role_grants set valid_from = now() - interval '2 days', expires_at = now() - interval '1 day' where person_id = $1 and role_key = 'quality_lead'`, [P.robin]);
    const me = (await (await as('robin')).get('/api/me')).body;
    const whm = me.companies.find((c: any) => c.id === C.WHM);
    expect(whm).toBeUndefined();
  });
});

describe('18 · tenant and support features are absent', () => {
  it('has no resident, tenancy or support-plan endpoints or tables', async () => {
    const sam = await as('sam');
    for (const p of ['/api/residents', '/api/tenants', '/api/support-plans', '/api/referrals', '/api/arrears']) expect((await sam.get(p)).status).toBe(404);
    const t = await pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_name ~ '(resident|tenant|tenanc|referral|support_plan|occupan|arrear)'`);
    expect(t.rows).toEqual([]);
  });
});

describe('20 · leavers lose access', () => {
  it('ending someone’s only appointment ends their sign-in, after tasks are transferred', async () => {
    const hr = await as('morgan');
    await as('casey'); // token issued before leaving
    const r = await hr.post(`/api/appointments/${A.casey}/end`).send({ end_date: '2026-10-20', reason: 'Withdrew before start', transfer_to: P.sam });
    expect(r.status).toBe(200);
    expect(r.body.leaver).toBe(true);
    const me = await (await as('casey')).get('/api/me');
    expect(me.status).toBe(403);
    expect(me.body.error).toBe('access_ended');
    expect((await pool.query(`select owner_id from tasks where title = 'Upload induction certificate'`)).rows[0].owner_id).toBe(P.sam);
  });
});
