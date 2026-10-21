import { Router } from 'express';
import { z } from 'zod';
import { adviceFor, computeKpis } from '../kpi.ts';
import { enqueue } from '../outbox.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, myCompanies, need, scope } from '../perm.ts';

export const performance = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-10');
const monthLabel = (m: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));

// Who may see KPIs: anyone for themself; performance.view_all for others or the whole company.
function kpiCompanies(a: Access, personId: string | null, company: unknown) {
  return personId === a.personId ? scope(a, null, company) : scope(a, 'performance.view_all', company);
}

performance.get('/kpis', async (req, res) => {
  const a = req.access;
  const m = parse(month, req.query.month);
  const personId = req.query.person === 'me' ? a.personId : req.query.person ? parse(uuid, req.query.person) : null;
  const cos = kpiCompanies(a, personId, req.query.company);
  if (!cos.length) throw forbidden();
  const companies = await q('select id, name, code from companies where id = any($1::uuid[]) order by name', [cos]);
  const out: object[] = [];
  for (const c of companies) {
    // A person's KPIs only for companies where they hold (or held) an appointment.
    if (personId && !(await one('select 1 from appointments where person_id = $1 and company_id = $2', [personId, c.id]))) continue;
    const kpis = await computeKpis(pool, c.id, personId, `${m}-01`);
    out.push({ company_id: c.id, company_name: c.name, company_code: c.code, kpis, advice: adviceFor(kpis, monthLabel(m), `${c.name}, ${personId ? 'one person' : 'whole company'}`) });
  }
  res.json(out);
});

// Every current person in one company, with their own KPIs for the month (managers with performance.view_all).
// shortcut: one KPI query per person; fine for teams of tens, cache or batch the SQL if a company reaches hundreds.
performance.get('/kpis/team', async (req, res) => {
  const company = parse(uuid, req.query.company);
  need(req.access, 'performance.view_all', company);
  const m = parse(month, req.query.month);
  const people = await q(`select distinct on (p.id) p.id, coalesce(p.preferred_name, p.full_name) as name, p.photo_path is not null as has_photo, a.job_title
                            from appointments a join people p on p.id = a.person_id where a.company_id = $1 and ${ACTIVE_APPT('a')} order by p.id, a.start_date desc`, [company]);
  const rows: any[] = [];
  for (const p of people) rows.push({ ...p, kpis: (await computeKpis(pool, company, p.id, `${m}-01`)).map(({ key, title, unit, value, status, numerator, denominator }) => ({ key, title, unit, value, status, numerator, denominator })) });
  res.json(rows.sort((x, y) => x.name.localeCompare(y.name)));
});

performance.get('/kpis/series', async (req, res) => {
  const a = req.access;
  const company = parse(uuid, req.query.company);
  const key = parse(z.string(), req.query.key);
  const end = parse(month, req.query.month);
  const personId = req.query.person === 'me' ? a.personId : req.query.person ? parse(uuid, req.query.person) : null;
  if (!kpiCompanies(a, personId, company).length) throw forbidden();
  const points: object[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${end}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const mm = d.toISOString().slice(0, 7);
    const k = (await computeKpis(pool, company, personId, `${mm}-01`)).find((x) => x.key === key);
    if (!k) throw notFound();
    points.push({ month: mm, label: monthLabel(mm), value: k.value, numerator: k.numerator, denominator: k.denominator, target: k.target, status: k.status, version: k.definition.version });
  }
  res.json(points);
});

// ── KPI definitions: history is kept; a change is a new version from a chosen date ──
performance.get('/kpi-definitions', async (req, res) => {
  const cos = scope(req.access, null, req.query.company);
  res.json(await q(`select d.*, c.code as company_code, ${name('p')} as created_by_name from kpi_definitions d left join companies c on c.id = d.company_id left join people p on p.id = d.created_by
                     where d.company_id is null or d.company_id = any($1::uuid[]) order by d.key, d.effective_from desc, d.version desc`, [cos]));
});
performance.post('/kpi-definitions', async (req, res) => {
  const b = parse(z.object({
    key: z.string(), company_id: uuid.nullable(), title: text(120).min(3), purpose: text(500).min(5), target: z.coerce.number().min(0).max(100).nullable(),
    min_data: z.coerce.number().int().min(0).max(1000), limitations: text(1000).min(5), next_step: text(500).nullable().optional(), effective_from: isoDate,
  }), req.body);
  if (b.company_id) need(req.access, 'performance.manage', b.company_id);
  else if (!req.access.superAdmin) throw forbidden('Only a super administrator can change the default for all companies.');
  const row = await tx(async (db) => {
    const base = await one(`select * from kpi_definitions where key = $1 order by (company_id is not distinct from $2) desc, effective_from desc, version desc limit 1`, [b.key, b.company_id], db);
    if (!base) throw bad('Unknown KPI.');
    if (base.unit === 'hours' && b.target !== null) throw bad('Hour totals have no target: more hours do not mean better work.', { fields: { target: 'Leave blank' } });
    const version = (await one<{ v: number }>(`select coalesce(max(version), 0) + 1 v from kpi_definitions where key = $1 and company_id is not distinct from $2`, [b.key, b.company_id], db))!.v;
    const r = await one(`insert into kpi_definitions (key, version, company_id, title, purpose, formula, sources, unit, direction, target, min_data, applies_to, owner, limitations, next_step, effective_from, created_by)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
      [b.key, version, b.company_id, b.title, b.purpose, base.formula, base.sources, base.unit, base.direction, b.target, b.min_data, base.applies_to, base.owner, b.limitations, b.next_step ?? base.next_step, b.effective_from, req.person.id], db);
    await audit(db, req.person.id, b.company_id, 'kpi_definition', r.id, 'new_version', { key: b.key, version, target: b.target });
    return r;
  });
  res.status(201).json(row);
});

// ── Follow-up actions are ordinary tasks for the person, reviewed by the author ──
async function addAction(db: Db, a: Access, rec: { company_id: string; person_id: string; reviewer: string }, link: { review_id?: string; supervision_id?: string }, b: { title: string; due_on?: string | null }) {
  const t = await one(`insert into tasks (company_id, title, owner_id, reviewer_id, created_by, due_on, review_id, supervision_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [rec.company_id, b.title, rec.person_id, rec.reviewer, a.personId, b.due_on ?? null, link.review_id ?? null, link.supervision_id ?? null], db);
  await audit(db, a.personId, rec.company_id, 'task', t.id, 'create_action', link);
  if (rec.person_id !== a.personId) await notify(db, rec.person_id, rec.company_id, `New development action: ${b.title}`, `/tasks/${t.id}`);
  return t;
}
const actionBody = z.object({ title: text(200).min(3), due_on: isoDate.nullable().optional() });
const actionsSql = `select t.id, t.title, t.status, t.due_on, t.completed_at from tasks t where t.%s = $1 order by t.created_at`;

async function hasAppointment(personId: string, companyId: string) {
  return !!(await one('select 1 from appointments where person_id = $1 and company_id = $2', [personId, companyId]));
}

// ── Reviews ──
// The person sees their own reviews only once published. Drafts stay with the author and reviews.manage holders.
async function loadReview(a: Access, id: string) {
  const r = await one(`select r.*, ${name('p')} as person_name, ${name('au')} as author_name, c.name as company_name, c.code as company_code
                         from reviews r join people p on p.id = r.person_id join people au on au.id = r.author_id join companies c on c.id = r.company_id where r.id = $1`, [id]);
  if (!r) throw notFound();
  const manage = r.author_id === a.personId || can(a, 'reviews.manage', r.company_id);
  const own = r.person_id === a.personId && r.status === 'published';
  if (!manage && !own) throw notFound();
  return { r, manage: manage && r.person_id !== a.personId };
}

performance.get('/reviews', async (req, res) => {
  const a = req.access;
  res.json(await q(`select r.id, r.kind, r.period_start, r.period_end, r.status, r.published_at, r.acknowledged_at, r.person_id, ${name('p')} as person_name, ${name('au')} as author_name, c.name as company_name, c.code as company_code
                      from reviews r join people p on p.id = r.person_id join people au on au.id = r.author_id join companies c on c.id = r.company_id
                     where ((r.person_id = $1 and r.status = 'published') or r.author_id = $1 or (r.company_id = any($2::uuid[]) and r.person_id <> $1))
                       and ($3::uuid is null or r.company_id = $3) order by r.period_end desc`,
    [a.personId, companiesWith(a, 'reviews.manage'), req.query.company ? parse(uuid, req.query.company) : null]));
});
performance.get('/reviews/:id', async (req, res) => {
  const { r, manage } = await loadReview(req.access, idParam(req.params.id));
  res.json({ review: r, actions: await q(actionsSql.replace('%s', 'review_id'), [r.id]), can: { edit: manage && r.status === 'draft', publish: manage && r.status === 'draft', addAction: manage, respond: r.person_id === req.person.id } });
});
const reviewFields = z.object({ objectives: text(4000).nullable(), achievements: text(4000).nullable(), development: text(4000).nullable(), feedback: text(4000).nullable() }).partial();
performance.post('/reviews', async (req, res) => {
  const b = parse(reviewFields.extend({ company_id: uuid, person_id: uuid, kind: z.enum(['probation', 'periodic', 'annual']), period_start: isoDate, period_end: isoDate }), req.body);
  need(req.access, 'reviews.manage', b.company_id);
  if (b.person_id === req.person.id) throw forbidden('You cannot review yourself.');
  if (!(await hasAppointment(b.person_id, b.company_id))) throw bad('This person has no role in this company.');
  const r = await one(`insert into reviews (company_id, person_id, author_id, kind, period_start, period_end, objectives, achievements, development, feedback) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [b.company_id, b.person_id, req.person.id, b.kind, b.period_start, b.period_end, b.objectives ?? null, b.achievements ?? null, b.development ?? null, b.feedback ?? null]);
  await audit(pool, req.person.id, b.company_id, 'review', r.id, 'create', { person_id: b.person_id, kind: b.kind });
  res.status(201).json(r);
});
performance.patch('/reviews/:id', async (req, res) => {
  const { r, manage } = await loadReview(req.access, idParam(req.params.id));
  if (!manage || r.status !== 'draft') throw forbidden('Only a draft can be edited. Published reviews are kept as they were shared.');
  const b = parse(reviewFields.strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  res.json(await one(`update reviews set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [r.id, ...keys.map((k) => (b as any)[k])]));
});
performance.post('/reviews/:id/publish', async (req, res) => {
  const { r, manage } = await loadReview(req.access, idParam(req.params.id));
  if (!manage || r.status !== 'draft') throw forbidden();
  await tx(async (db) => {
    await q(`update reviews set status = 'published', published_at = now(), updated_at = now() where id = $1`, [r.id], db);
    await audit(db, req.person.id, r.company_id, 'review', r.id, 'publish', {});
    await notify(db, r.person_id, r.company_id, `Your ${r.kind} review is ready to read`, '/performance?tab=reviews');
    await enqueue(db, { person_id: r.person_id, company_id: r.company_id, category: 'feedback_ready', dedup: `review:${r.id}`, subject: 'Your review is ready', body: 'Feedback is ready for you to read in the Valor & Wellbeing Hub.', link: '/performance?tab=reviews' });
  });
  res.json({ ok: true });
});
performance.post('/reviews/:id/respond', async (req, res) => {
  const { r } = await loadReview(req.access, idParam(req.params.id));
  if (r.person_id !== req.person.id) throw forbidden();
  const b = parse(z.object({ staff_response: text(4000).nullable().optional(), acknowledge: z.boolean().optional() }), req.body);
  await q(`update reviews set staff_response = coalesce($2, staff_response), acknowledged_at = case when $3 then coalesce(acknowledged_at, now()) else acknowledged_at end, updated_at = now() where id = $1`,
    [r.id, b.staff_response ?? null, !!b.acknowledge]);
  await audit(pool, req.person.id, r.company_id, 'review', r.id, b.acknowledge ? 'acknowledge' : 'respond', {});
  await notify(pool, r.author_id, r.company_id, `${r.person_name} ${b.acknowledge ? 'acknowledged' : 'responded to'} their review`, '/performance?tab=reviews');
  res.json({ ok: true });
});
performance.post('/reviews/:id/actions', async (req, res) => {
  const { r, manage } = await loadReview(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(actionBody, req.body);
  res.status(201).json(await tx((db) => addAction(db, req.access, { company_id: r.company_id, person_id: r.person_id, reviewer: req.person.id }, { review_id: r.id }, b)));
});

// ── Supervision, coaching, mentoring ──
// Restricted notes: the supervisor and supervision.restricted holders in that company only — never the person supervised.
async function loadSupervision(a: Access, id: string) {
  const s = await one(`select s.*, ${name('p')} as person_name, ${name('sv')} as supervisor_name, c.name as company_name, c.code as company_code
                         from supervisions s join people p on p.id = s.person_id join people sv on sv.id = s.supervisor_id join companies c on c.id = s.company_id where s.id = $1`, [id]);
  if (!s) throw notFound();
  const isSupervisor = s.supervisor_id === a.personId;
  const manage = isSupervisor || can(a, 'supervision.manage', s.company_id);
  const own = s.person_id === a.personId && s.status === 'completed';
  if ((!manage || s.person_id === a.personId) && !own) throw notFound();
  const restricted = s.person_id !== a.personId && (isSupervisor || can(a, 'supervision.restricted', s.company_id));
  return { s: restricted ? s : { ...s, restricted_notes: undefined }, manage: manage && s.person_id !== a.personId, restricted };
}

performance.get('/supervisions', async (req, res) => {
  const a = req.access;
  res.json(await q(`select s.id, s.kind, s.held_on, s.minutes, s.status, s.next_due, s.person_id, ${name('p')} as person_name, ${name('sv')} as supervisor_name, c.name as company_name, c.code as company_code
                      from supervisions s join people p on p.id = s.person_id join people sv on sv.id = s.supervisor_id join companies c on c.id = s.company_id
                     where ((s.person_id = $1 and s.status = 'completed') or s.supervisor_id = $1 or (s.company_id = any($2::uuid[]) and s.person_id <> $1))
                       and ($3::uuid is null or s.company_id = $3) order by s.held_on desc limit 300`,
    [a.personId, companiesWith(a, 'supervision.manage'), req.query.company ? parse(uuid, req.query.company) : null]));
});
performance.get('/supervisions/due', async (req, res) => {
  const cs = scope(req.access, 'supervision.manage', req.query.company);
  res.json(await q(`select a.person_id, ${name('p')} as person_name, a.job_title, c.name as company_name, c.code as company_code, c.id as company_id, last.held_on as last_held, last.next_due,
                           coalesce(last.next_due, last.held_on + 56) as due_on
                      from appointments a join people p on p.id = a.person_id join companies c on c.id = a.company_id
                      left join lateral (select held_on, next_due from supervisions s where s.person_id = a.person_id and s.company_id = a.company_id and s.status = 'completed' order by held_on desc limit 1) last on true
                     where a.company_id = any($1::uuid[]) and ${ACTIVE_APPT('a')} and a.person_id <> $2
                     order by due_on nulls first, p.full_name`, [cs, req.person.id]));
});
performance.get('/supervisions/:id', async (req, res) => {
  const { s, manage, restricted } = await loadSupervision(req.access, idParam(req.params.id));
  res.json({ supervision: s, actions: await q(actionsSql.replace('%s', 'supervision_id'), [s.id]), can: { edit: manage && s.status === 'draft', complete: manage && s.status === 'draft', addAction: manage, reflect: s.person_id === req.person.id, restricted } });
});
const supFields = z.object({ held_on: isoDate, minutes: z.coerce.number().int().min(5).max(480), agenda: text(4000).nullable(), shared_notes: text(8000).nullable(), restricted_notes: text(8000).nullable(), support_agreed: text(4000).nullable(), next_due: isoDate.nullable() }).partial();
performance.post('/supervisions', async (req, res) => {
  const b = parse(supFields.extend({ company_id: uuid, person_id: uuid, kind: z.enum(['supervision', 'coaching', 'mentoring']), held_on: isoDate, minutes: z.coerce.number().int().min(5).max(480) }), req.body);
  need(req.access, 'supervision.manage', b.company_id);
  if (b.person_id === req.person.id) throw forbidden('You cannot record your own supervision.');
  if (!(await hasAppointment(b.person_id, b.company_id))) throw bad('This person has no role in this company.');
  const s = await one(`insert into supervisions (company_id, person_id, supervisor_id, kind, held_on, minutes, agenda, shared_notes, restricted_notes, support_agreed, next_due) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [b.company_id, b.person_id, req.person.id, b.kind, b.held_on, b.minutes, b.agenda ?? null, b.shared_notes ?? null, b.restricted_notes ?? null, b.support_agreed ?? null, b.next_due ?? null]);
  await audit(pool, req.person.id, b.company_id, 'supervision', s.id, 'create', { person_id: b.person_id, kind: b.kind });
  res.status(201).json(s);
});
performance.patch('/supervisions/:id', async (req, res) => {
  const { s, manage } = await loadSupervision(req.access, idParam(req.params.id));
  if (s.person_id === req.person.id) {
    // The person supervised adds their own reflection, nothing else.
    const { staff_reflection } = parse(z.object({ staff_reflection: text(4000) }).strict(), req.body);
    await q('update supervisions set staff_reflection = $2, updated_at = now() where id = $1', [s.id, staff_reflection]);
    return res.json({ ok: true });
  }
  if (!manage || s.status !== 'draft') throw forbidden('Only a draft can be edited by the supervisor.');
  const b = parse(supFields.strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  await q(`update supervisions set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [s.id, ...keys.map((k) => (b as any)[k])]);
  res.json({ ok: true });
});
performance.post('/supervisions/:id/complete', async (req, res) => {
  const { s, manage } = await loadSupervision(req.access, idParam(req.params.id));
  if (!manage || s.status !== 'draft') throw forbidden();
  await tx(async (db) => {
    await q(`update supervisions set status = 'completed', updated_at = now() where id = $1`, [s.id], db);
    await audit(db, req.person.id, s.company_id, 'supervision', s.id, 'complete', {});
    await notify(db, s.person_id, s.company_id, `Notes from your ${s.kind} are ready. You can add your reflection.`, '/performance?tab=supervision');
  });
  res.json({ ok: true });
});
performance.post('/supervisions/:id/actions', async (req, res) => {
  const { s, manage } = await loadSupervision(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(actionBody, req.body);
  res.status(201).json(await tx((db) => addAction(db, req.access, { company_id: s.company_id, person_id: s.person_id, reviewer: req.person.id }, { supervision_id: s.id }, b)));
});

// ── Recognition: anyone may propose; a manager decides. No self-proposals or self-approval. ──
performance.get('/recognitions', async (req, res) => {
  const a = req.access;
  res.json(await q(`select r.*, ${name('p')} as person_name, ${name('pb')} as proposed_by_name, c.name as company_name, c.code as company_code
                      from recognitions r join people p on p.id = r.person_id join people pb on pb.id = r.proposed_by join companies c on c.id = r.company_id
                     where r.company_id = any($1::uuid[]) and (r.status = 'approved' or r.proposed_by = $2 or (r.company_id = any($3::uuid[]) and r.person_id <> $2))
                       and ($4::uuid is null or r.company_id = $4) order by r.created_at desc limit 200`,
    [myCompanies(a), a.personId, companiesWith(a, 'reviews.manage'), req.query.company ? parse(uuid, req.query.company) : null]));
});
performance.post('/recognitions', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, person_id: uuid, category: z.enum(['learning', 'quality', 'teamwork', 'improvement']), note: text(1000).min(5) }), req.body);
  if (!req.access.perms.has(b.company_id)) throw forbidden();
  if (b.person_id === req.person.id) throw forbidden('You cannot propose recognition for yourself.');
  if (!(await hasAppointment(b.person_id, b.company_id))) throw bad('This person has no role in this company.');
  res.status(201).json(await one('insert into recognitions (company_id, person_id, category, note, proposed_by) values ($1,$2,$3,$4,$5) returning *', [b.company_id, b.person_id, b.category, b.note, req.person.id]));
});
performance.post('/recognitions/:id/decide', async (req, res) => {
  const r = await one('select * from recognitions where id = $1', [idParam(req.params.id)]);
  if (!r || !req.access.perms.has(r.company_id)) throw notFound();
  need(req.access, 'reviews.manage', r.company_id);
  if (r.person_id === req.person.id) throw forbidden('You cannot decide recognition for yourself.');
  const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
  const done = await one(`update recognitions set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = 'proposed' returning id`, [r.id, approve ? 'approved' : 'declined', req.person.id]);
  if (!done) throw bad('Already decided.');
  if (approve) await notify(pool, r.person_id, r.company_id, 'You have been recognised by a colleague', '/performance?tab=recognition', r.note);
  res.json({ ok: true });
});

// ── Request Help: a task for the person's manager in that company ──
performance.post('/help-requests', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, message: text(2000).min(5) }), req.body);
  const ap = await one(`select a.manager_person_id from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')} and a.manager_person_id is not null limit 1`, [req.person.id, b.company_id]);
  if (!ap) throw bad('No manager is recorded for your role in this company. Please contact HR.');
  const t = await tx(async (db) => {
    const row = await one(`insert into tasks (company_id, title, description, owner_id, created_by, due_on, priority) values ($1, $2, $3, $4, $5, ${LONDON_TODAY} + 2, 'high') returning id`,
      [b.company_id, `Help requested by ${req.person.preferred_name ?? req.person.full_name}`, b.message, ap.manager_person_id, req.person.id], db);
    await notify(db, ap.manager_person_id, b.company_id, `${req.person.preferred_name ?? req.person.full_name} asked for help`, `/tasks/${row.id}`);
    await audit(db, req.person.id, b.company_id, 'task', row.id, 'help_request', {});
    return row;
  });
  res.status(201).json(t);
});
