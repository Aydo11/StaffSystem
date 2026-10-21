// Job descriptions (versioned, acknowledged per exact version), competence, onboarding and probation (§12, §14).
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, can, companiesWith, need, scope } from '../perm.ts';

export const development = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// ── Job descriptions ──
const jdFields = {
  title: text(120).min(2), purpose: text(2000).nullable().optional(), duties: text(8000).min(3), boundaries: text(4000).nullable().optional(),
  standards: text(4000).nullable().optional(), reports_to: text(200).nullable().optional(),
  required_training: text(2000).nullable().optional(), required_qualifications: text(2000).nullable().optional(),
};
const JD_KEYS = Object.keys(jdFields);

development.get('/job-descriptions', async (req, res) => {
  // Latest version of each job description, plus whether a newer draft exists.
  res.json(await q(`select distinct on (j.root_id) j.*, c.name as company_name, c.code as company_code,
                           (select id from job_descriptions x where x.root_id = j.root_id and x.status = 'published') as published_id,
                           (select count(*)::int from appointments a where a.job_description_root_id = j.root_id and ${ACTIVE_APPT('a')}) as people
                      from job_descriptions j join companies c on c.id = j.company_id
                     where j.company_id = any($1::uuid[]) and j.status <> 'retired' order by j.root_id, j.version desc`, [scope(req.access, 'jobs.manage', req.query.company)]));
});

async function loadJd(a: Express.Request['access'], id: string, db: Db = pool) {
  const j = await one(`select j.*, c.name as company_name, ${name('pb')} as published_by_name from job_descriptions j join companies c on c.id = j.company_id left join people pb on pb.id = j.published_by where j.id = $1`, [id], db);
  // Readable by managers of job descriptions, staff viewers of the company, and anyone whose appointment uses it.
  const mine = j && (await one(`select 1 from appointments a where a.person_id = $1 and a.job_description_root_id = $2`, [a.personId, j.root_id], db));
  if (!j || !(can(a, 'jobs.manage', j.company_id) || can(a, 'staff.view', j.company_id) || (mine && j.status !== 'draft'))) throw notFound();
  return j;
}
development.get('/job-descriptions/:id', async (req, res) => {
  const j = await loadJd(req.access, idParam(req.params.id));
  const mine = await one(`select (select acknowledged_at from jd_acknowledgements k where k.job_description_id = $3 and k.person_id = $1) as acknowledged_at
                            from appointments a where a.person_id = $1 and a.job_description_root_id = $2 and ${ACTIVE_APPT('a')} limit 1`, [req.person.id, j.root_id, j.id]);
  res.json({ ...j, versions: await q('select id, version, status, published_at from job_descriptions where root_id = $1 order by version desc', [j.root_id]),
    can: { manage: can(req.access, 'jobs.manage', j.company_id), acknowledge: !!mine && j.status === 'published' && !mine.acknowledged_at }, acknowledged_at: mine?.acknowledged_at ?? null });
});
development.post('/job-descriptions', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, ...jdFields }), req.body);
  need(req.access, 'jobs.manage', b.company_id);
  const row = await one(`insert into job_descriptions (root_id, version, company_id, ${JD_KEYS.join(', ')}, created_by)
                         values (gen_random_uuid(), 1, $1, ${JD_KEYS.map((_, i) => `$${i + 2}`).join(', ')}, $${JD_KEYS.length + 2}) returning *`,
    [b.company_id, ...JD_KEYS.map((k) => (b as any)[k] ?? null), req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'job_description', row.id, 'create', { title: b.title });
  res.status(201).json(row);
});
development.patch('/job-descriptions/:id', async (req, res) => {
  const j = await loadJd(req.access, idParam(req.params.id));
  need(req.access, 'jobs.manage', j.company_id);
  if (j.status !== 'draft') throw conflict('Published versions cannot be changed. Start a new version instead, so acknowledgements stay tied to what people read.');
  const b = parse(z.object(jdFields).partial().strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) return res.json(j);
  const row = await one(`update job_descriptions set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [j.id, ...keys.map((k) => (b as any)[k])]);
  res.json(row);
});
development.post('/job-descriptions/:id/new-version', async (req, res) => {
  const j = await loadJd(req.access, idParam(req.params.id));
  need(req.access, 'jobs.manage', j.company_id);
  if (await one(`select 1 from job_descriptions where root_id = $1 and status = 'draft'`, [j.root_id])) throw conflict('A draft of this job description already exists. Edit that one.');
  const row = await one(`insert into job_descriptions (root_id, version, company_id, ${JD_KEYS.join(', ')}, created_by)
                         select root_id, (select max(version) + 1 from job_descriptions where root_id = $1), company_id, ${JD_KEYS.join(', ')}, $3 from job_descriptions where id = $2 returning *`, [j.root_id, j.id, req.person.id]);
  res.status(201).json(row);
});
development.post('/job-descriptions/:id/publish', async (req, res) => {
  const j = await loadJd(req.access, idParam(req.params.id));
  need(req.access, 'jobs.manage', j.company_id);
  if (j.status !== 'draft') throw conflict('Only a draft can be published.');
  await tx(async (db) => {
    await q(`update job_descriptions set status = 'retired' where root_id = $1 and status = 'published'`, [j.root_id], db);
    await q(`update job_descriptions set status = 'published', published_by = $2, published_at = now() where id = $1`, [j.id, req.person.id], db);
    // Everyone working to it must read and acknowledge the new version.
    for (const p of await q<{ person_id: string }>(`select distinct person_id from appointments a where a.job_description_root_id = $1 and ${ACTIVE_APPT('a')}`, [j.root_id], db))
      await notify(db, p.person_id, j.company_id, `Please read and acknowledge your job description: ${j.title} (version ${j.version})`, `/job-descriptions/${j.id}`);
    await audit(db, req.person.id, j.company_id, 'job_description', j.id, 'publish', { version: j.version });
  });
  res.json({ ok: true });
});
development.post('/job-descriptions/:id/acknowledge', async (req, res) => {
  const j = await loadJd(req.access, idParam(req.params.id));
  if (j.status !== 'published') throw conflict('Only the current published version can be acknowledged.');
  if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.job_description_root_id = $2 and ${ACTIVE_APPT('a')}`, [req.person.id, j.root_id]))) throw forbidden('This is not the job description for any of your current appointments.');
  await q('insert into jd_acknowledgements (job_description_id, person_id) values ($1,$2) on conflict do nothing', [j.id, req.person.id]);
  await audit(pool, req.person.id, j.company_id, 'job_description', j.id, 'acknowledge', { version: j.version });
  res.json({ ok: true });
});
development.put('/appointments/:id/job-description', async (req, res) => {
  const ap = await one('select * from appointments where id = $1', [idParam(req.params.id)]);
  if (!ap || !req.access.perms.has(ap.company_id)) throw notFound();
  need(req.access, 'appointments.manage', ap.company_id);
  const { root_id } = parse(z.object({ root_id: uuid.nullable() }), req.body);
  if (root_id && !(await one(`select 1 from job_descriptions where root_id = $1 and company_id = $2 and status = 'published'`, [root_id, ap.company_id])))
    throw bad('Choose a published job description from the same company.', { fields: { root_id: 'Not available' } });
  await q('update appointments set job_description_root_id = $2 where id = $1', [ap.id, root_id]);
  if (root_id) await notify(pool, ap.person_id, ap.company_id, 'Please read and acknowledge your job description', '/profile?tab=development');
  await audit(pool, req.person.id, ap.company_id, 'appointment', ap.id, 'job_description', { root_id });
  res.json({ ok: true });
});

// ── Competencies ──
development.get('/competencies', async (req, res) => {
  res.json(await q(`select k.*, c.code as company_code, c.name as company_name from competencies k join companies c on c.id = k.company_id
                     where k.company_id = any($1::uuid[]) order by c.name, k.active desc, k.name`, [scope(req.access, null, req.query.company)]));
});
const compFields = { name: text(120).min(2), description: text(2000).nullable().optional(), rubric: text(4000).min(3) };
development.post('/competencies', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, ...compFields }), req.body);
  need(req.access, 'jobs.manage', b.company_id);
  const row = await one('insert into competencies (company_id, name, description, rubric) values ($1,$2,$3,$4) returning *', [b.company_id, b.name, b.description ?? null, b.rubric]);
  await audit(pool, req.person.id, b.company_id, 'competency', row.id, 'create', { name: b.name });
  res.status(201).json(row);
});
development.patch('/competencies/:id', async (req, res) => {
  const k = await one('select * from competencies where id = $1', [idParam(req.params.id)]);
  if (!k || !req.access.perms.has(k.company_id)) throw notFound();
  need(req.access, 'jobs.manage', k.company_id);
  const b = parse(z.object({ ...compFields, active: z.boolean() }).partial().strict(), req.body);
  const keys = Object.keys(b);
  const row = keys.length ? await one(`update competencies set ${keys.map((x, i) => `${x} = $${i + 2}`).join(', ')} where id = $1 returning *`, [k.id, ...keys.map((x) => (b as any)[x])]) : k;
  res.json(row);
});
development.post('/people/:id/competency-assessments', async (req, res) => {
  const personId = idParam(req.params.id);
  const b = parse(z.object({ competency_id: uuid, level: z.enum(['not_assessed', 'developing', 'competent', 'verified_to_support']), assessed_on: isoDate,
    rubric_notes: text(4000).min(3, 'Say how the rubric was applied'), evidence: text(4000).min(3, 'Describe what you observed'), review_due: isoDate.nullable().optional() }), req.body);
  const k = await one('select * from competencies where id = $1 and active', [b.competency_id]);
  if (!k || !req.access.perms.has(k.company_id)) throw notFound();
  need(req.access, 'competence.assess', k.company_id);
  if (personId === req.person.id) throw forbidden('You cannot assess your own competence.');
  if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [personId, k.company_id]))) throw bad('They have no current role in this competency’s company.');
  if (b.review_due && b.review_due <= b.assessed_on) throw bad('The review date must be after the assessment.', { fields: { review_due: 'Too early' } });
  if ((await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} f`, [b.assessed_on]))!.f) throw bad('An assessment cannot be in the future.', { fields: { assessed_on: 'In the future' } });
  const row = await one(`insert into competency_assessments (person_id, competency_id, level, assessor_id, assessed_on, rubric_notes, evidence, review_due) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [personId, k.id, b.level, req.person.id, b.assessed_on, b.rubric_notes, b.evidence, b.review_due ?? null]);
  await notify(pool, personId, k.company_id, `Competency recorded: ${k.name}`, '/profile?tab=development');
  await audit(pool, req.person.id, k.company_id, 'competency_assessment', row.id, 'create', { person_id: personId, level: b.level });
  res.status(201).json(row);
});

// ── Onboarding templates and plans ──
const KINDS = ['profile', 'checks', 'contract', 'job_description', 'induction', 'policies', 'training', 'competence', 'allocation', 'probation', 'other'] as const;
const DEFAULT_ITEMS: { kind: (typeof KINDS)[number]; title: string }[] = [
  { kind: 'profile', title: 'Profile and emergency contact completed' }, { kind: 'checks', title: 'Employment checks and references recorded' },
  { kind: 'contract', title: 'Contract or agreement signed' }, { kind: 'job_description', title: 'Job description read and acknowledged' },
  { kind: 'induction', title: 'Induction completed' }, { kind: 'policies', title: 'Required policies read' },
  { kind: 'training', title: 'Required training completed' }, { kind: 'competence', title: 'Initial competence assessed by a manager' },
  { kind: 'allocation', title: 'Manager and properties allocated' }, { kind: 'probation', title: 'Probation reviews booked' },
];
const items = z.array(z.object({ kind: z.enum(KINDS), title: text(200).min(2) })).min(1).max(40);

development.get('/onboarding-templates', async (req, res) => {
  res.json(await q(`select t.*, c.code as company_code, c.name as company_name from onboarding_templates t join companies c on c.id = t.company_id
                     where t.company_id = any($1::uuid[]) order by c.name, t.name`, [[...new Set([...companiesWith(req.access, 'jobs.manage'), ...companiesWith(req.access, 'onboarding.manage')])]]));
});
development.post('/onboarding-templates', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, name: text(120).min(2), items: items.default(DEFAULT_ITEMS), probation_months: z.coerce.number().int().min(0).max(24).default(6) }), req.body);
  need(req.access, 'jobs.manage', b.company_id);
  const row = await one('insert into onboarding_templates (company_id, name, items, probation_months) values ($1,$2,$3,$4) returning *', [b.company_id, b.name, JSON.stringify(b.items), b.probation_months]);
  res.status(201).json(row);
});
development.patch('/onboarding-templates/:id', async (req, res) => {
  const t = await one('select * from onboarding_templates where id = $1', [idParam(req.params.id)]);
  if (!t || !req.access.perms.has(t.company_id)) throw notFound();
  need(req.access, 'jobs.manage', t.company_id);
  const b = parse(z.object({ name: text(120).min(2), items, probation_months: z.coerce.number().int().min(0).max(24), active: z.boolean() }).partial().strict(), req.body);
  const keys = Object.keys(b);
  const row = keys.length ? await one(`update onboarding_templates set ${keys.map((x, i) => `${x} = $${i + 2}`).join(', ')} where id = $1 returning *`, [t.id, ...keys.map((x) => (x === 'items' ? JSON.stringify((b as any)[x]) : (b as any)[x]))]) : t;
  res.json(row);
});

development.post('/appointments/:id/onboarding', async (req, res) => {
  const ap = await one('select * from appointments where id = $1', [idParam(req.params.id)]);
  if (!ap || !req.access.perms.has(ap.company_id)) throw notFound();
  need(req.access, 'onboarding.manage', ap.company_id);
  const { template_id } = parse(z.object({ template_id: uuid.nullable().optional() }), req.body);
  const t = template_id ? await one('select * from onboarding_templates where id = $1 and company_id = $2 and active', [template_id, ap.company_id]) : null;
  if (template_id && !t) throw bad('Choose an active template from this company.');
  const plan = await tx(async (db) => {
    if (await one('select 1 from onboarding_plans where appointment_id = $1', [ap.id], db)) throw conflict('Onboarding has already started for this appointment.');
    const p = await one('insert into onboarding_plans (appointment_id, template_id, created_by) values ($1,$2,$3) returning *', [ap.id, t?.id ?? null, req.person.id], db);
    const list: { kind: string; title: string }[] = t?.items ?? DEFAULT_ITEMS;
    for (const [i, it] of list.entries()) await q('insert into onboarding_items (plan_id, position, kind, title) values ($1,$2,$3,$4)', [p.id, i, it.kind, it.title], db);
    const months = t?.probation_months ?? 6;
    // Interim review halfway, final review at the end of probation, both from the appointment's start date.
    if (months > 0) await q(`insert into probation_reviews (appointment_id, kind, due_on) values ($1, 'interim', ($2::date + make_interval(months => $3 / 2, days => ($3 % 2) * 15))::date), ($1, 'final', ($2::date + make_interval(months => $3))::date)`, [ap.id, ap.start_date, months], db);
    await audit(db, req.person.id, ap.company_id, 'appointment', ap.id, 'onboarding_start', { template_id: t?.id ?? null });
    return p;
  });
  res.status(201).json(plan);
});
development.patch('/onboarding-items/:id', async (req, res) => {
  const it = await one('select i.*, a.company_id, a.person_id from onboarding_items i join onboarding_plans p on p.id = i.plan_id join appointments a on a.id = p.appointment_id where i.id = $1', [idParam(req.params.id)]);
  if (!it || !req.access.perms.has(it.company_id)) throw notFound();
  need(req.access, 'onboarding.manage', it.company_id);
  const b = parse(z.object({ done: z.boolean(), note: text(500).nullable().optional() }), req.body);
  const row = await one(`update onboarding_items set done_at = case when $2 then coalesce(done_at, now()) end, done_by = case when $2 then coalesce(done_by, $3) end, note = coalesce($4, note) where id = $1 returning *`,
    [it.id, b.done, req.person.id, b.note ?? null]);
  await audit(pool, req.person.id, it.company_id, 'onboarding_item', it.id, b.done ? 'done' : 'undone', { person_id: it.person_id });
  res.json(row);
});
development.post('/probation-reviews/:id/complete', async (req, res) => {
  const r = await one('select r.*, a.company_id, a.person_id from probation_reviews r join appointments a on a.id = r.appointment_id where r.id = $1', [idParam(req.params.id)]);
  if (!r || !req.access.perms.has(r.company_id)) throw notFound();
  need(req.access, 'onboarding.manage', r.company_id);
  if (r.person_id === req.person.id) throw forbidden('You cannot review your own probation.');
  if (r.outcome !== 'pending') throw conflict('This review is already complete.');
  const b = parse(z.object({ outcome: z.enum(['on_track', 'concerns', 'passed', 'extended', 'not_passed']), notes: text(4000).min(3, 'Record what was discussed and agreed'), extend_to: isoDate.optional() }), req.body);
  if (r.kind === 'interim' && ['passed', 'not_passed', 'extended'].includes(b.outcome)) throw bad('An interim review records progress: choose "on track" or "concerns".', { fields: { outcome: 'Not for an interim review' } });
  if (r.kind !== 'interim' && ['on_track', 'concerns'].includes(b.outcome)) throw bad('A final review needs a decision: passed, extended or not passed.', { fields: { outcome: 'Decision needed' } });
  if (b.outcome === 'extended' && (!b.extend_to || b.extend_to <= r.due_on)) throw bad('Give the new review date, after this one.', { fields: { extend_to: 'Required' } });
  await tx(async (db) => {
    await q(`update probation_reviews set outcome = $2, notes = $3, reviewer_id = $4, completed_at = now() where id = $1`, [r.id, b.outcome, b.notes, req.person.id], db);
    if (b.outcome === 'extended') await q(`insert into probation_reviews (appointment_id, kind, due_on) values ($1, 'extension', $2)`, [r.appointment_id, b.extend_to], db);
    await notify(db, r.person_id, r.company_id, 'Your probation review has been recorded', '/profile?tab=development');
    await audit(db, req.person.id, r.company_id, 'probation_review', r.id, 'complete', { outcome: b.outcome });
  });
  res.json({ ok: true });
});

// ── One person's development: job description status, onboarding, probation and competence, per role they can see ──
development.get('/people/:id/development', async (req, res) => {
  const a = req.access;
  const personId = idParam(req.params.id);
  const self = personId === a.personId;
  const appts = (await q(`select ap.id, ap.company_id, ap.job_title, ap.start_date, ap.end_date, ap.job_description_root_id, c.name as company_name, c.code as company_code, (${ACTIVE_APPT('ap')}) as is_current
                             from appointments ap join companies c on c.id = ap.company_id where ap.person_id = $1 order by (${ACTIVE_APPT('ap')}) desc, ap.start_date desc`, [personId]))
    .filter((x) => self || can(a, 'staff.view', x.company_id));
  if (!appts.length && !self) throw notFound();
  const out: any[] = [];
  for (const ap of appts) {
    const jd = ap.job_description_root_id ? await one(`select j.id, j.title, j.version, j.published_at, (select acknowledged_at from jd_acknowledgements k where k.job_description_id = j.id and k.person_id = $2) as acknowledged_at
                                                         from job_descriptions j where j.root_id = $1 and j.status = 'published'`, [ap.job_description_root_id, personId]) : null;
    const plan = await one('select * from onboarding_plans where appointment_id = $1', [ap.id]);
    const restricted = self || can(a, 'onboarding.manage', ap.company_id) || can(a, 'staff.restricted', ap.company_id);
    out.push({
      ...ap, job_description: jd ?? null,
      onboarding: plan ? { ...plan, items: await q(`select i.*, ${name('d')} as done_by_name from onboarding_items i left join people d on d.id = i.done_by where i.plan_id = $1 order by i.position`, [plan.id]) } : null,
      probation: await q(`select r.id, r.kind, r.due_on, r.outcome, r.completed_at, ${restricted ? 'r.notes' : 'null as notes'}, ${name('rv')} as reviewer_name from probation_reviews r left join people rv on rv.id = r.reviewer_id where r.appointment_id = $1 order by r.due_on`, [ap.id]),
      can: { onboarding: can(a, 'onboarding.manage', ap.company_id) && !self, assess: can(a, 'competence.assess', ap.company_id) && !self, setJd: can(a, 'appointments.manage', ap.company_id) },
    });
  }
  const competence = await q(`select distinct on (x.competency_id) x.*, k.name as competency_name, k.company_id, ${name('s')} as assessor_name,
                                     (select count(*)::int from competency_assessments y where y.person_id = x.person_id and y.competency_id = x.competency_id) as history
                                from competency_assessments x join competencies k on k.id = x.competency_id join people s on s.id = x.assessor_id
                               where x.person_id = $1 and k.company_id = any($2::uuid[]) order by x.competency_id, x.assessed_on desc, x.created_at desc`, [personId, appts.map((x) => x.company_id)]);
  res.json({ appointments: out, competence });
});
