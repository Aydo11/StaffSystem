import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const governance = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const company = (v: unknown) => (v ? parse(uuid, v) : null);

async function patchRow(table: string, id: string, body: Record<string, unknown>, json: string[] = []) {
  const keys = Object.keys(body);
  if (!keys.length) throw bad('Nothing to save.');
  return one(`update ${table} set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [id, ...keys.map((k) => (json.includes(k) ? JSON.stringify(body[k]) : body[k]))]);
}
// Loads a company-owned row the viewer may see (governance.view in its company); 404 otherwise.
async function loadOwned(a: Access, table: string, id: string, perm = 'governance.view') {
  const r = await one(`select * from ${table} where id = $1`, [id]);
  if (!r || !can(a, perm, r.company_id)) throw notFound();
  return r;
}

// ── Accountability: named leads and deputies (responsibility, not access) and the org chart ──
governance.get('/governance/leads', async (req, res) => {
  res.json(await q(`select g.*, ${name('l')} as person_name, c.code as company_code, c.name as company_name
                      from governance_leads g join companies c on c.id = g.company_id join people l on l.id = g.person_id
                     where g.company_id = any($1::uuid[]) and g.to_date is null order by c.code, g.area, g.role, g.created_at`, [scope(req.access, null, req.query.company)]));
});
// Any number of leads and deputies per area; adding one never removes another.
governance.post('/governance/leads', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, area: z.enum(['staffing', 'quality', 'safeguarding_oversight', 'property_safety', 'complaints_oversight', 'repairs', 'finance', 'data_protection']), person_id: uuid, role: z.enum(['lead', 'deputy']), delegated_authority: text(2000).nullable().optional() }), req.body);
  need(req.access, 'governance.manage', b.company_id);
  if (!(await one('select 1 from appointments where person_id = $1 and company_id = $2', [b.person_id, b.company_id]))) throw bad('This person has no role in this company.', { fields: { person_id: 'Not in this company' } });
  const r = await tx(async (db) => {
    await q(`update governance_leads set to_date = ${LONDON_TODAY} where company_id = $1 and area = $2 and person_id = $3 and to_date is null`, [b.company_id, b.area, b.person_id], db); // switching lead ↔ deputy
    const row = await one('insert into governance_leads (company_id, area, person_id, role, delegated_authority, created_by) values ($1,$2,$3,$4,$5,$6) returning *',
      [b.company_id, b.area, b.person_id, b.role, b.delegated_authority ?? null, req.person.id], db);
    await audit(db, req.person.id, b.company_id, 'governance_lead', row.id, 'set', { area: b.area, person: b.person_id, role: b.role });
    return row;
  });
  res.status(201).json(r);
});
governance.post('/governance/leads/:id/end', async (req, res) => {
  const g = await one('select * from governance_leads where id = $1 and to_date is null', [idParam(req.params.id)]);
  if (!g) throw notFound();
  need(req.access, 'governance.manage', g.company_id);
  await q(`update governance_leads set to_date = ${LONDON_TODAY} where id = $1`, [g.id]);
  await audit(pool, req.person.id, g.company_id, 'governance_lead', g.id, 'end', { area: g.area });
  res.json({ ok: true });
});
governance.get('/governance/org-chart', async (req, res) => {
  const cs = scope(req.access, 'staff.view', req.query.company);
  res.json(await q(`select a.id, a.person_id, ${name('p')} as person_name, a.job_title, a.manager_person_id, a.company_id, c.code as company_code
                      from appointments a join people p on p.id = a.person_id join companies c on c.id = a.company_id
                     where a.company_id = any($1::uuid[]) and ${ACTIVE_APPT('a')} order by c.code, p.full_name`, [cs]));
});

// ── Meetings, minutes and decisions ──
async function loadMeeting(a: Access, id: string) {
  const m = await one('select * from meetings where id = $1', [id]);
  if (!m || !m.company_ids.some((c: string) => can(a, 'governance.view', c))) throw notFound();
  return { m, manage: m.company_ids.every((c: string) => can(a, 'governance.manage', c)) };
}
governance.get('/meetings', async (req, res) => {
  const cs = scope(req.access, 'governance.view', req.query.company);
  res.json(await q(`select m.id, m.title, m.held_on, m.company_ids, m.minutes_status, m.minutes_version, ${name('ch')} as chair_name,
                           (select array_agg(code order by code) from companies where id = any(m.company_ids)) as company_codes,
                           (select count(*) from decisions d where d.meeting_id = m.id)::int as decisions
                      from meetings m left join people ch on ch.id = m.chair_id where m.company_ids && $1::uuid[] order by m.held_on desc`, [cs]));
});
governance.get('/meetings/:id', async (req, res) => {
  const { m, manage } = await loadMeeting(req.access, idParam(req.params.id));
  const visible = m.company_ids.filter((c: string) => can(req.access, 'governance.view', c));
  res.json({
    meeting: m, can: { manage },
    companies: await q('select id, code, name from companies where id = any($1::uuid[])', [m.company_ids]),
    decisions: await q(`select d.*, ${name('au')} as authoriser_name, c.code as company_code from decisions d join companies c on c.id = d.company_id join people au on au.id = d.authoriser_id
                         where d.meeting_id = $1 and d.company_id = any($2::uuid[]) order by d.created_at`, [m.id, visible]),
    versions: await q(`select v.version, v.amendment_reason, v.approved_at, ${name('p')} as approved_by_name from meeting_minutes_versions v join people p on p.id = v.approved_by where v.meeting_id = $1 order by v.version desc`, [m.id]),
    actions: await q(`select id, action, status, due_on, company_id from improvement_actions where source_type = 'meeting' and source_id = $1 and company_id = any($2::uuid[])`, [m.id, visible]),
  });
});
const meetingFields = z.object({
  title: text(200).min(3), held_on: isoDate, chair_id: uuid.nullable(),
  agenda: z.array(z.object({ item: text(500).min(1), paper_file_id: uuid.nullable().optional() })).max(60),
  attendance: z.array(z.object({ person_id: uuid.nullable().optional(), name: text(120).min(1), role: text(120).optional(), status: z.enum(['present', 'apologies', 'absent']) })).max(100),
  conflicts: text(4000).nullable(), minutes: text(50000).nullable(),
}).partial();
governance.post('/meetings', async (req, res) => {
  const b = parse(meetingFields.extend({ company_ids: z.array(uuid).min(1).max(3), title: text(200).min(3), held_on: isoDate }), req.body);
  for (const c of b.company_ids) need(req.access, 'governance.manage', c);
  const m = await one(`insert into meetings (title, company_ids, held_on, chair_id, agenda, created_by) values ($1,$2,$3,$4,$5,$6) returning *`,
    [b.title, b.company_ids, b.held_on, b.chair_id ?? null, JSON.stringify(b.agenda ?? []), req.person.id]);
  res.status(201).json(m);
});
governance.patch('/meetings/:id', async (req, res) => {
  const { m, manage } = await loadMeeting(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(meetingFields.strict(), req.body);
  if (b.minutes !== undefined && m.minutes_status === 'approved') throw conflict('These minutes are approved. Start an amendment to change them; the approved version is kept.');
  res.json(await patchRow('meetings', m.id, { ...b, updated_at: new Date().toISOString() }, ['agenda', 'attendance']));
});
governance.post('/meetings/:id/papers', upload.single('file'), async (req, res) => {
  const { m, manage } = await loadMeeting(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (!req.file) throw bad('Choose a file.');
  const f = await tx((db) => saveFile(db, { companyId: m.company_ids[0], entityType: 'meeting', entityId: m.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id }));
  res.status(201).json({ id: f.id, original_name: f.original_name });
});
governance.post('/meetings/:id/approve-minutes', async (req, res) => {
  const { m, manage } = await loadMeeting(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const { amendment_reason } = parse(z.object({ amendment_reason: text(1000).optional() }), req.body);
  if (m.minutes_status === 'approved') throw conflict('Already approved.');
  if (!m.minutes?.trim()) throw bad('Write the minutes first.');
  if (m.minutes_version > 0 && !amendment_reason) throw bad('Explain why the approved minutes are being amended.', { fields: { amendment_reason: 'Required' } });
  await tx(async (db) => {
    await q(`update meetings set minutes_status = 'approved', minutes_version = minutes_version + 1, updated_at = now() where id = $1`, [m.id], db);
    await q('insert into meeting_minutes_versions (meeting_id, version, minutes, amendment_reason, approved_by) values ($1,$2,$3,$4,$5)', [m.id, m.minutes_version + 1, m.minutes, amendment_reason ?? null, req.person.id], db);
    await audit(db, req.person.id, m.company_ids[0], 'meeting', m.id, m.minutes_version ? 'amend_minutes' : 'approve_minutes', { version: m.minutes_version + 1 });
  });
  res.json({ ok: true });
});
governance.post('/meetings/:id/amend', async (req, res) => {
  const { m, manage } = await loadMeeting(req.access, idParam(req.params.id));
  if (!manage || m.minutes_status !== 'approved') throw forbidden();
  await q(`update meetings set minutes_status = 'draft', updated_at = now() where id = $1`, [m.id]); // approved text stays in meeting_minutes_versions
  res.json({ ok: true });
});

governance.get('/decisions', async (req, res) => {
  res.json(await q(`select d.*, ${name('au')} as authoriser_name, c.code as company_code, c.name as company_name, m.title as meeting_title
                      from decisions d join companies c on c.id = d.company_id join people au on au.id = d.authoriser_id left join meetings m on m.id = d.meeting_id
                     where d.company_id = any($1::uuid[]) order by d.decided_on desc`, [scope(req.access, 'governance.view', req.query.company)]));
});
governance.post('/decisions', async (req, res) => {
  const b = parse(z.object({ meeting_id: uuid.nullable().optional(), company_id: uuid, title: text(300).min(3), evidence: text(8000).nullable().optional(), options: text(8000).nullable().optional(),
    rationale: text(8000).min(3), resources: text(4000).nullable().optional(), authoriser_id: uuid, decided_on: isoDate, review_on: isoDate.nullable().optional() }), req.body);
  need(req.access, 'governance.manage', b.company_id);
  if (b.meeting_id) {
    const m = await one('select company_ids from meetings where id = $1', [b.meeting_id]);
    if (!m || !m.company_ids.includes(b.company_id)) throw bad('Choose one of the companies at this meeting.', { fields: { company_id: 'Not in this meeting' } });
  }
  const d = await one(`insert into decisions (meeting_id, company_id, title, evidence, options, rationale, resources, authoriser_id, decided_on, review_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [b.meeting_id ?? null, b.company_id, b.title, b.evidence ?? null, b.options ?? null, b.rationale, b.resources ?? null, b.authoriser_id, b.decided_on, b.review_on ?? null, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'decision', d.id, 'record', { title: b.title });
  res.status(201).json(d);
});

// ── Risk register ──
governance.get('/risks', async (req, res) => {
  res.json(await q(`select r.*, r.likelihood * r.impact as score, ${name('o')} as owner_name, c.code as company_code, c.name as company_name,
                           (select count(*) from improvement_actions x where x.source_type = 'risk' and x.source_id = r.id and x.status <> 'closed')::int as open_actions
                      from risks r join companies c on c.id = r.company_id left join people o on o.id = r.owner_id
                     where r.company_id = any($1::uuid[]) order by r.status, r.likelihood * r.impact desc`, [scope(req.access, 'governance.view', req.query.company)]));
});
const riskFields = z.object({ title: text(200).min(3), description: text(4000).nullable(), category: text(80).nullable(), owner_id: uuid.nullable(), controls: text(4000).nullable(), target_score: z.coerce.number().int().min(1).max(25).nullable(), review_on: isoDate.nullable(), status: z.enum(['open', 'closed']) }).partial();
governance.post('/risks', async (req, res) => {
  const b = parse(riskFields.extend({ company_id: uuid, title: text(200).min(3), likelihood: z.coerce.number().int().min(1).max(5), impact: z.coerce.number().int().min(1).max(5) }), req.body);
  need(req.access, 'governance.manage', b.company_id);
  const r = await tx(async (db) => {
    const row = await one(`insert into risks (company_id, title, description, category, owner_id, controls, likelihood, impact, target_score, review_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [b.company_id, b.title, b.description ?? null, b.category ?? null, b.owner_id ?? null, b.controls ?? null, b.likelihood, b.impact, b.target_score ?? null, b.review_on ?? null, req.person.id], db);
    await q('insert into risk_assessments (risk_id, likelihood, impact, note, assessed_by) values ($1,$2,$3,$4,$5)', [row.id, b.likelihood, b.impact, 'Initial assessment', req.person.id], db);
    return row;
  });
  res.status(201).json(r);
});
governance.patch('/risks/:id', async (req, res) => {
  const r = await loadOwned(req.access, 'risks', idParam(req.params.id), 'governance.manage');
  res.json(await patchRow('risks', r.id, { ...parse(riskFields.strict(), req.body), updated_at: new Date().toISOString() }));
});
governance.post('/risks/:id/assess', async (req, res) => {
  const r = await loadOwned(req.access, 'risks', idParam(req.params.id), 'governance.manage');
  const b = parse(z.object({ likelihood: z.coerce.number().int().min(1).max(5), impact: z.coerce.number().int().min(1).max(5), note: text(2000).min(3) }), req.body);
  await tx(async (db) => {
    await q('insert into risk_assessments (risk_id, likelihood, impact, note, assessed_by) values ($1,$2,$3,$4,$5)', [r.id, b.likelihood, b.impact, b.note, req.person.id], db);
    await q('update risks set likelihood = $2, impact = $3, updated_at = now() where id = $1', [r.id, b.likelihood, b.impact], db);
  });
  res.json({ ok: true });
});
governance.get('/risks/:id', async (req, res) => {
  const r = await loadOwned(req.access, 'risks', idParam(req.params.id));
  res.json({ risk: { ...r, score: r.likelihood * r.impact },
    assessments: await q(`select ra.*, ${name('p')} as assessed_by_name from risk_assessments ra join people p on p.id = ra.assessed_by where ra.risk_id = $1 order by ra.assessed_at desc`, [r.id]),
    actions: await q(`select id, action, status, due_on, significance from improvement_actions where source_type = 'risk' and source_id = $1`, [r.id]),
    can: { manage: can(req.access, 'governance.manage', r.company_id) } });
});

// ── Audits ──
const rubric = z.array(z.object({ criterion: text(500).min(1), result: z.enum(['met', 'partly_met', 'not_met', 'not_applicable']).nullable().optional(), note: text(2000).nullable().optional() })).max(100);
governance.get('/audits', async (req, res) => {
  res.json(await q(`select a.id, a.company_id, a.area, a.title, a.planned_on, a.completed_on, a.status, ${name('r')} as reviewer_name, c.code as company_code, c.name as company_name,
                           (select count(*) from improvement_actions x where x.source_type = 'audit' and x.source_id = a.id)::int as findings,
                           (select count(*) from improvement_actions x where x.source_type = 'audit' and x.source_id = a.id and x.status <> 'closed')::int as open_findings
                      from audits a join companies c on c.id = a.company_id left join people r on r.id = a.reviewer_id
                     where a.company_id = any($1::uuid[]) order by a.planned_on desc`, [scope(req.access, 'governance.view', req.query.company)]));
});
governance.get('/audits/:id', async (req, res) => {
  const a = await loadOwned(req.access, 'audits', idParam(req.params.id));
  res.json({ audit: a, actions: await q(`select x.*, ${name('o')} as owner_name from improvement_actions x left join people o on o.id = x.owner_id where x.source_type = 'audit' and x.source_id = $1 order by x.created_at`, [a.id]),
    can: { manage: can(req.access, 'governance.manage', a.company_id) } });
});
governance.post('/audits', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, area: z.enum(['staff_files', 'recruitment', 'training', 'supervision', 'governance', 'agents', 'information_security', 'property_safety']), title: text(200).min(3), scope: text(4000).nullable().optional(), sample: text(4000).nullable().optional(), reviewer_id: uuid.nullable().optional(), planned_on: isoDate, rubric: rubric.optional() }), req.body);
  need(req.access, 'governance.manage', b.company_id);
  res.status(201).json(await one(`insert into audits (company_id, area, title, scope, sample, reviewer_id, planned_on, rubric, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [b.company_id, b.area, b.title, b.scope ?? null, b.sample ?? null, b.reviewer_id ?? null, b.planned_on, JSON.stringify(b.rubric ?? []), req.person.id]));
});
governance.patch('/audits/:id', async (req, res) => {
  const a = await loadOwned(req.access, 'audits', idParam(req.params.id), 'governance.manage');
  if (a.status === 'completed') throw conflict('This audit is completed. Record follow-up as actions.');
  const b = parse(z.object({ title: text(200).min(3), scope: text(4000).nullable(), sample: text(4000).nullable(), reviewer_id: uuid.nullable(), planned_on: isoDate, rubric, summary: text(8000).nullable(), status: z.enum(['planned', 'in_progress', 'completed']) }).partial().strict(), req.body);
  if (b.status === 'completed') {
    const items = b.rubric ?? a.rubric;
    if (!items.length || items.some((i: any) => !i.result)) throw bad('Record a result for every rubric item before completing the audit.');
    (b as any).completed_on = new Date().toISOString().slice(0, 10);
  }
  const r = await patchRow('audits', a.id, b, ['rubric']);
  if (b.status === 'completed') await audit(pool, req.person.id, a.company_id, 'audit', a.id, 'complete', {});
  res.json(r);
});

// ── Improvement actions: Finding → Action → Owner → Deadline → Evidence → Verification → Effectiveness review ──
const SOURCE_PERM: Record<string, string> = { safety_check: 'safety.manage', agent: 'agents.manage' };
async function loadAction(a: Access, id: string) {
  const x = await one(`select x.*, ${name('o')} as owner_name, ${name('v')} as verified_by_name, ${name('rv')} as reviewed_by_name, c.code as company_code, c.name as company_name
                         from improvement_actions x join companies c on c.id = x.company_id left join people o on o.id = x.owner_id left join people v on v.id = x.verified_by left join people rv on rv.id = x.reviewed_by where x.id = $1`, [id]);
  if (!x || !(x.owner_id === a.personId || can(a, 'governance.view', x.company_id) || (SOURCE_PERM[x.source_type] && can(a, SOURCE_PERM[x.source_type], x.company_id)))) throw notFound();
  return { x, manage: can(a, 'governance.manage', x.company_id) && x.owner_id !== a.personId };
}
governance.get('/actions', async (req, res) => {
  const a = req.access;
  res.json(await q(`select x.*, ${name('o')} as owner_name, c.code as company_code, c.name as company_name, (x.status <> 'closed' and x.due_on < ${LONDON_TODAY}) as overdue
                      from improvement_actions x join companies c on c.id = x.company_id left join people o on o.id = x.owner_id
                     where (x.owner_id = $1 or x.company_id = any($2::uuid[])) and ($3::uuid is null or x.company_id = $3) and ($4::text is null or x.source_type = $4)
                     order by x.status = 'closed', x.due_on nulls last`, [a.personId, companiesWith(a, 'governance.view'), company(req.query.company), req.query.source ? parse(text(30), req.query.source) : null]));
});
governance.get('/actions/:id', async (req, res) => {
  const { x, manage } = await loadAction(req.access, idParam(req.params.id));
  res.json({ action: x, files: await q(`select id, original_name, uploaded_at from files where entity_type = 'action' and entity_id = $1`, [x.id]), can: { manage, evidence: x.owner_id === req.person.id || manage } });
});
governance.post('/actions', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, source_type: z.enum(['audit', 'risk', 'decision', 'safety_check', 'agent', 'meeting', 'other']), source_id: uuid.nullable().optional(), finding: text(4000).min(3), action: text(2000).min(3),
    significance: z.enum(['standard', 'significant']).default('standard'), owner_id: uuid.nullable().optional(), due_on: isoDate.nullable().optional(), effectiveness_review_on: isoDate.nullable().optional() }), req.body);
  if (!can(req.access, 'governance.manage', b.company_id) && !(SOURCE_PERM[b.source_type] && can(req.access, SOURCE_PERM[b.source_type], b.company_id))) throw forbidden();
  const x = await one(`insert into improvement_actions (company_id, source_type, source_id, finding, action, significance, owner_id, due_on, effectiveness_review_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [b.company_id, b.source_type, b.source_id ?? null, b.finding, b.action, b.significance, b.owner_id ?? null, b.due_on ?? null, b.effectiveness_review_on ?? null, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'improvement_action', x.id, 'create', { source_type: b.source_type, significance: b.significance });
  if (b.owner_id && b.owner_id !== req.person.id) await notify(pool, b.owner_id, b.company_id, `Action for you: ${b.action}`, `/governance/actions/${x.id}`);
  res.status(201).json(x);
});
governance.post('/actions/:id/evidence', upload.single('file'), async (req, res) => {
  const { x, manage } = await loadAction(req.access, idParam(req.params.id));
  if (x.owner_id !== req.person.id && !manage) throw forbidden();
  if (x.status === 'closed') throw conflict('This action is closed.');
  const note = parse(text(4000).min(3, 'Describe what was done'), req.body?.note);
  await tx(async (db) => {
    if (req.file) await saveFile(db, { companyId: x.company_id, entityType: 'action', entityId: x.id, name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id });
    // Submitting evidence never closes an action: someone else must verify it.
    await q(`update improvement_actions set evidence_note = $2, evidence_at = now(), status = 'evidence_submitted' where id = $1`, [x.id, note], db);
  });
  res.json({ ok: true });
});
governance.post('/actions/:id/verify', async (req, res) => {
  const { x, manage } = await loadAction(req.access, idParam(req.params.id));
  if (!manage) throw forbidden('Someone other than the owner, with governance rights, must verify.');
  if (x.status !== 'evidence_submitted') throw conflict('There is no evidence waiting to be verified.');
  const b = parse(z.object({ accept: z.boolean(), note: text(2000).min(3) }), req.body);
  await q(`update improvement_actions set status = $2, verified_by = case when $3 then $4::uuid else null end, verified_at = case when $3 then now() else null end, verification_note = $5 where id = $1`,
    [x.id, b.accept ? 'verified' : 'reopened', b.accept, req.person.id, b.note]);
  await audit(pool, req.person.id, x.company_id, 'improvement_action', x.id, b.accept ? 'verify' : 'reject_evidence', { note: b.note });
  if (x.owner_id) await notify(pool, x.owner_id, x.company_id, b.accept ? 'Your action evidence was verified' : 'More evidence is needed for your action', `/governance/actions/${x.id}`, b.note);
  res.json({ ok: true });
});
governance.post('/actions/:id/review', async (req, res) => {
  const { x, manage } = await loadAction(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (!x.verified_at) throw conflict('Verify the action before reviewing whether it worked.');
  const b = parse(z.object({ effectiveness: z.enum(['effective', 'partly_effective', 'not_effective']), recurred: z.boolean(), note: text(2000).min(3) }), req.body);
  await q(`update improvement_actions set effectiveness = $2, recurred = $3, effectiveness_note = $4, reviewed_by = $5, reviewed_at = now(), status = case when $2 = 'effective' and not $3 then status else 'reopened' end where id = $1`,
    [x.id, b.effectiveness, b.recurred, b.note, req.person.id]);
  await audit(pool, req.person.id, x.company_id, 'improvement_action', x.id, 'effectiveness_review', b);
  res.json({ ok: true });
});
governance.post('/actions/:id/close', async (req, res) => {
  const { x, manage } = await loadAction(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (x.significance === 'significant' && !(x.verified_at && x.effectiveness)) throw conflict('A significant action can only be closed after it has been verified and its effectiveness reviewed.');
  if (x.significance === 'standard' && !x.verified_at) throw conflict('Verify the evidence before closing.');
  await q(`update improvement_actions set status = 'closed', closed_at = now() where id = $1`, [x.id]);
  await audit(pool, req.person.id, x.company_id, 'improvement_action', x.id, 'close', {});
  res.json({ ok: true });
});

// ── External quality summaries (non-identifiable, entered from the support system) ──
const COUNT_MEASURES = ['missed_contacts', 'follow_up_outstanding', 'safeguarding_actions_outstanding'];
governance.get('/quality-summaries', async (req, res) => {
  const a = req.access;
  const rows = await q(`select s.*, c.code as company_code, c.name as company_name, ${name('e')} as entered_by_name, ${name('v')} as verified_by_name
                          from quality_summaries s join companies c on c.id = s.company_id join people e on e.id = s.entered_by left join people v on v.id = s.verified_by
                         where s.company_id = any($1::uuid[]) order by s.period_end desc, s.measure`, [scope(a, 'quality.view', req.query.company)]);
  res.json(rows.filter((r) => !r.sensitive || can(a, 'quality.manage', r.company_id)).map((r) => {
    // Small counts are suppressed for viewers, so that no individual can be identified from a breakdown.
    const small = COUNT_MEASURES.includes(r.measure) && r.value !== null && Number(r.value) > 0 && Number(r.value) < 5;
    return small && !can(a, 'quality.manage', r.company_id) ? { ...r, value: null, suppressed: 'fewer than 5' } : r;
  }));
});
governance.post('/quality-summaries', async (req, res) => {
  const b = parse(z.object({
    company_id: uuid, measure: z.enum(['missed_contacts', 'follow_up_outstanding', 'safeguarding_actions_outstanding', 'complaint_themes', 'resident_feedback', 'outcome_measure']),
    period_start: isoDate, period_end: isoDate, value: z.coerce.number().min(0).max(100000).nullable().optional(),
    theme: text(200).nullable().optional().refine((t) => !t || !/\b(Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z]/.test(t), 'Themes must not include names'),
    definition: text(1000).min(5), source: text(200).min(2), sensitive: z.boolean().default(false),
  }), req.body);
  need(req.access, 'quality.manage', b.company_id);
  if (b.period_end < b.period_start) throw bad('The period ends before it starts.');
  const r = await one(`insert into quality_summaries (company_id, measure, period_start, period_end, value, theme, definition, source, sensitive, entered_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [b.company_id, b.measure, b.period_start, b.period_end, b.value ?? null, b.theme ?? null, b.definition, b.source, b.sensitive, req.person.id]);
  res.status(201).json(r);
});
governance.post('/quality-summaries/:id/verify', async (req, res) => {
  const s = await loadOwned(req.access, 'quality_summaries', idParam(req.params.id), 'quality.manage');
  if (s.entered_by === req.person.id) throw forbidden('Someone other than the person who entered it must verify it.');
  await q('update quality_summaries set verified_by = $2, verified_at = now() where id = $1', [s.id, req.person.id]);
  res.json({ ok: true });
});

// ── Assessment framework mapping (criteria entered by the organisation) ──
governance.get('/framework', async (req, res) => {
  res.json(await q(`select f.*, c.code as company_code from framework_items f join companies c on c.id = f.company_id where f.company_id = any($1::uuid[]) order by f.framework, f.ref`,
    [scope(req.access, 'governance.view', req.query.company)]));
});
const frameworkBody = z.object({ framework: text(120).min(2), ref: text(40).min(1), title: text(500).min(3), evidence: z.array(z.object({ label: text(200).min(1), link: text(500).min(1) })).max(30), status: z.enum(['evidence_missing', 'awaiting_review', 'action_required', 'verified', 'not_applicable']), note: text(2000).nullable() }).partial();
governance.post('/framework', async (req, res) => {
  const b = parse(frameworkBody.extend({ company_id: uuid, framework: text(120).min(2), ref: text(40).min(1), title: text(500).min(3) }), req.body);
  need(req.access, 'governance.manage', b.company_id);
  res.status(201).json(await one(`insert into framework_items (company_id, framework, ref, title, evidence, status, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [b.company_id, b.framework, b.ref, b.title, JSON.stringify(b.evidence ?? []), b.status ?? 'evidence_missing', b.note ?? null, req.person.id]));
});
governance.patch('/framework/:id', async (req, res) => {
  const f = await loadOwned(req.access, 'framework_items', idParam(req.params.id), 'governance.manage');
  res.json(await patchRow('framework_items', f.id, { ...parse(frameworkBody.strict(), req.body), updated_by: req.person.id, updated_at: new Date().toISOString() }, ['evidence']));
});

// ── Monthly management pack: each section has a plain status label, never one overall percentage ──
type Section = { key: string; title: string; status: 'evidence_missing' | 'awaiting_review' | 'action_required' | 'verified' | 'not_applicable'; figures: [string, number | string][]; link: string; note?: string };
async function pack(db: Db, a: Access, companyId: string, month: string): Promise<Section[]> {
  const p = [companyId, `${month}-01`];
  const W = `w as (select $2::date ds, ($2::date + interval '1 month')::date de, least(($2::date + interval '1 month')::date - 1, ${LONDON_TODAY}) snap)`;
  const [m] = await q(`with ${W} select
      (select count(*) from appointments a, w where a.company_id = $1 and a.start_date <= w.snap and (a.end_date is null or a.end_date >= w.snap) and a.status <> 'planned')::int staff,
      (select count(*) from appointments a, w where a.company_id = $1 and a.start_date >= w.ds and a.start_date < w.de)::int starters,
      (select count(*) from appointments a, w where a.company_id = $1 and a.end_date >= w.ds and a.end_date < w.de)::int leavers,
      (select count(*) from current_clearance cc join people pe on pe.id = cc.person_id where cc.company_id = $1 and pe.status <> 'left' and cc.status in ('pending','not_authorised'))::int clearance_open,
      (select count(*) from current_clearance cc where cc.company_id = $1 and cc.review_date < ${LONDON_TODAY})::int clearance_review_overdue,
      (select count(*) from w, training_matrix(w.snap) t where t.company_id = $1)::int training_all,
      (select count(*) from w, training_matrix(w.snap) t where t.company_id = $1 and t.status = 'overdue')::int training_overdue,
      (select count(*) from appointments a, w where a.company_id = $1 and a.status = 'active' and a.start_date <= w.snap and (a.end_date is null or a.end_date >= w.snap)
         and not exists (select 1 from supervisions s where s.person_id = a.person_id and s.company_id = $1 and s.status = 'completed' and s.held_on > w.snap - 56))::int supervision_overdue,
      (select coalesce(sum(contracted_hours_per_week), 0) from appointments a, w where a.company_id = $1 and a.status = 'active' and a.start_date <= w.snap and (a.end_date is null or a.end_date >= w.snap))::numeric contracted_week,
      (select count(*) from visits v, w where v.company_id = $1 and v.entry_mode <> 'schedule' and (v.started_at at time zone 'Europe/London')::date >= w.ds and (v.started_at at time zone 'Europe/London')::date < w.de and v.status in ('submitted','approved'))::int visits,
      (select count(*) from visits v where v.company_id = $1 and v.status = 'submitted')::int visits_awaiting,
      (select count(*) from visits v where v.company_id = $1 and v.status = 'in_progress' and v.started_at < now() - interval '12 hours')::int missing_finish,
      (select count(*) from scheduled_visits s, w where s.company_id = $1 and s.status = 'scheduled' and s.planned_start >= w.ds and s.planned_start < w.de and s.planned_start + make_interval(mins => s.planned_minutes) < now())::int missed,
      (select count(*) from audits x, w where x.company_id = $1 and x.completed_on >= w.ds and x.completed_on < w.de)::int audits_done,
      (select count(*) from audits x where x.company_id = $1 and x.status <> 'completed' and x.planned_on < ${LONDON_TODAY})::int audits_late,
      (select count(*) from repairs r where r.company_id = $1 and r.status <> 'closed')::int repairs_open,
      (select count(*) from repairs r where r.company_id = $1 and r.status <> 'closed' and r.urgency = 'emergency')::int repairs_emergency,
      (select count(*) from repairs r where r.company_id = $1 and r.status <> 'closed' and r.due_on < ${LONDON_TODAY})::int repairs_overdue,
      (select count(*) from safety_requirements sr where sr.company_id = $1 and sr.retired_at is null
         and coalesce((select max(done_on) from safety_checks sc where sc.requirement_id = sr.id) + sr.interval_days, '1900-01-01') < ${LONDON_TODAY})::int safety_overdue,
      (select count(*) from safety_checks sc join safety_requirements sr on sr.id = sc.requirement_id, w where sr.company_id = $1 and sc.result = 'fail' and sc.done_on >= w.ds and sc.done_on < w.de)::int safety_failed,
      (select count(*) from agents ag where ag.company_id = $1)::int agents,
      (select count(*) from agents ag where ag.company_id = $1 and not exists (select 1 from agent_reviews r where r.agent_id = ag.id and r.period_end > ${LONDON_TODAY} - 120))::int agents_unreviewed,
      (select count(*) from risks r where r.company_id = $1 and r.status = 'open')::int risks_open,
      (select count(*) from risks r where r.company_id = $1 and r.status = 'open' and r.likelihood * r.impact >= 15)::int risks_high,
      (select count(*) from risks r where r.company_id = $1 and r.status = 'open' and r.review_on < ${LONDON_TODAY})::int risks_review_overdue,
      (select count(*) from improvement_actions x where x.company_id = $1 and x.status <> 'closed')::int actions_open,
      (select count(*) from improvement_actions x where x.company_id = $1 and x.status <> 'closed' and x.due_on < ${LONDON_TODAY})::int actions_overdue,
      (select count(*) from improvement_actions x where x.company_id = $1 and x.status = 'evidence_submitted')::int actions_awaiting,
      (select count(*) from improvement_actions x where x.company_id = $1 and x.verified_at is not null and x.effectiveness is null and x.effectiveness_review_on <= ${LONDON_TODAY})::int effectiveness_due,
      (select count(*) from improvement_actions x where x.company_id = $1 and x.effectiveness = 'not_effective')::int not_effective,
      (select count(*) from quality_summaries s, w where s.company_id = $1 and s.period_end >= w.ds and s.period_start < w.de)::int quality_entered,
      (select count(*) from quality_summaries s, w where s.company_id = $1 and s.period_end >= w.ds and s.period_start < w.de and s.verified_at is null)::int quality_unverified`, p, db);
  const finance = can(a, 'finance.view', companyId) ? await one(`select (select count(*) from finance_documents f where f.company_id = $1 and f.direction = 'receivable' and f.status in ('issued','part_paid') and f.due_date < ${LONDON_TODAY})::int overdue,
                                              (select count(*) from finance_documents f where f.company_id = $1 and f.status in ('awaiting_approval','submitted'))::int awaiting`, [companyId], db) : null;
  const S = (key: string, title: string, status: Section['status'], figures: Section['figures'], link: string, note?: string): Section => ({ key, title, status, figures, link, note });
  const sections: Section[] = [
    S('staffing', 'Staffing', m.staff ? 'verified' : 'evidence_missing', [['Current roles', m.staff], ['Started this month', m.starters], ['Left this month', m.leavers]], '/people'),
    S('clearance', 'Recruitment and clearance', m.clearance_open || m.clearance_review_overdue ? 'action_required' : m.staff ? 'verified' : 'evidence_missing', [['Pending or not authorised', m.clearance_open], ['Clearance reviews overdue', m.clearance_review_overdue]], '/people'),
    S('training', 'Training', !m.training_all ? 'evidence_missing' : m.training_overdue ? 'action_required' : 'verified', [['Required courses tracked', m.training_all], ['Overdue', m.training_overdue]], '/training?tab=manage'),
    S('supervision', 'Supervision', m.supervision_overdue ? 'action_required' : m.staff ? 'verified' : 'evidence_missing', [['People without supervision in 8 weeks', m.supervision_overdue]], '/performance?tab=supervision'),
    S('capacity', 'Capacity', m.staff ? 'verified' : 'evidence_missing', [['Contracted hours per week', Number(m.contracted_week)]], '/workload', 'Contracted hours. Approved leave is shown week by week on the Workload page.'),
    S('attendance', 'Attendance', m.visits_awaiting || m.missing_finish ? 'awaiting_review' : m.visits ? 'verified' : 'evidence_missing', [['Visits recorded', m.visits], ['Awaiting review', m.visits_awaiting], ['No finish time', m.missing_finish], ['Planned visits missed', m.missed]], '/attendance?team=1'),
    S('audits', 'Audits', m.audits_late ? 'action_required' : m.audits_done ? 'verified' : 'evidence_missing', [['Completed this month', m.audits_done], ['Overdue', m.audits_late]], '/governance?tab=audits'),
    S('property', 'Property safety and repairs', m.repairs_emergency || m.repairs_overdue || m.safety_overdue || m.safety_failed ? 'action_required' : 'verified', [['Open repairs', m.repairs_open], ['Emergency repairs open', m.repairs_emergency], ['Repairs overdue', m.repairs_overdue], ['Safety checks overdue', m.safety_overdue], ['Failed checks this month', m.safety_failed]], '/estates'),
    S('agents', 'Managing agents', !m.agents ? 'not_applicable' : m.agents_unreviewed ? 'action_required' : 'verified', [['Agents', m.agents], ['Not reviewed in 4 months', m.agents_unreviewed]], '/estates?tab=agents'),
    finance ? S('finance', 'Finance', finance.overdue || finance.awaiting ? 'action_required' : 'verified', [['Invoices overdue', finance.overdue], ['Awaiting approval', finance.awaiting]], '/finance') : S('finance', 'Finance', 'not_applicable', [], '/finance', 'Shown to finance roles only.'),
    S('risks', 'Risks', m.risks_high || m.risks_review_overdue ? 'action_required' : m.risks_open ? 'verified' : 'evidence_missing', [['Open risks', m.risks_open], ['Scoring 15 or more', m.risks_high], ['Reviews overdue', m.risks_review_overdue]], '/governance?tab=risks'),
    S('improvement', 'Improvement actions', m.actions_overdue || m.not_effective ? 'action_required' : m.actions_awaiting || m.effectiveness_due ? 'awaiting_review' : m.actions_open ? 'verified' : 'evidence_missing',
      [['Open', m.actions_open], ['Overdue', m.actions_overdue], ['Evidence awaiting verification', m.actions_awaiting], ['Effectiveness reviews due', m.effectiveness_due], ['Found not effective', m.not_effective]], '/governance?tab=actions'),
  ];
  if (can(a, 'quality.view', companyId)) sections.push(S('quality', 'Service quality summaries', !m.quality_entered ? 'evidence_missing' : m.quality_unverified ? 'awaiting_review' : 'verified', [['Summaries for this month', m.quality_entered], ['Not yet verified', m.quality_unverified]], '/governance?tab=quality', 'Entered from the support system; not a live link. Low counts are not a sign of success on their own.'));
  return sections;
}
export const packFor = (a: Access, companyId: string, month: string) => pack(pool, a, companyId, `${month}`);
governance.get('/packs', async (req, res) => {
  const month = parse(z.string().regex(/^\d{4}-\d{2}$/), req.query.month);
  const cs = scope(req.access, 'governance.view', req.query.company);
  if (!cs.length) throw forbidden();
  const companies = await q('select id, code, name from companies where id = any($1::uuid[]) order by name', [cs]);
  const out: object[] = [];
  for (const c of companies) out.push({ company_id: c.id, company_code: c.code, company_name: c.name, sections: await pack(pool, req.access, c.id, month) });
  await audit(pool, req.person.id, null, 'management_pack', null, 'view', { month, companies: cs.length });
  res.json(out);
});
