// Property safety for every property: inspections from templates, the property risk register and safety actions.
// A failed inspection item always opens a follow-up (an improvement action or a repair); a risk stays open until its
// actions are verified, and someone other than its owner confirms the closure.
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { type Access, can, companiesWith, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { propertyVisible } from '../visibility.ts';
import { upload } from './people.ts';
import { agentPropertyIds, noResidents, propertyAccess, reportRepair, residentMsg } from './estates.ts';
import { assertRiskActionsVerified } from './governance.ts';
import { AGENT_LABEL } from './compliance.ts';
import { STANDARD_TEMPLATES } from '../inspectionTemplates.ts';

export const safety = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const KINDS = ['weekly', 'monthly', 'quarterly', 'communal', 'fire', 'damp', 'room', 'health_safety'] as const;
const DUE_DAYS = { low: 28, medium: 14, high: 7, critical: 1 } as const;
const URGENCY = { low: 'planned', medium: 'routine', high: 'urgent', critical: 'emergency' } as const;
const clean = (t: string | null | undefined) => { if (!noResidents(t)) throw bad(residentMsg); return t || null; };

// Properties this person may see safety records for (staff by visibility, managers by permission, agents by link).
const visible = async (a: Access, al = 'p') => ({
  where: `(${al}.id = any($1::uuid[]) or (${propertyVisible(al, 2, 3)}))`,
  args: [await agentPropertyIds(a), a.personId, companiesWith(a, 'properties.view').concat(companiesWith(a, 'safety.manage'))] as unknown[],
});
const inCompany = async (personId: string, companyId: string) => !!(await one('select 1 from appointments where person_id = $1 and company_id = $2', [personId, companyId]));

// ── Templates ──
safety.get('/inspection-templates', async (req, res) => {
  const cs = scope(req.access, null, req.query.company);
  // A company with no templates at all (retired ones count) gets the standard set.
  for (const c of await q<{ id: string }>('select id from companies c where id = any($1::uuid[]) and not exists (select 1 from inspection_templates t where t.company_id = c.id)', [cs]))
    for (const t of STANDARD_TEMPLATES) await q('insert into inspection_templates (company_id, kind, name, interval_days, items) values ($1,$2,$3,$4,$5) on conflict do nothing', [c.id, t.kind, t.name, t.interval_days, JSON.stringify(t.items)]);
  res.json(await q('select t.*, c.code as company_code from inspection_templates t join companies c on c.id = t.company_id where t.company_id = any($1::uuid[]) and t.retired_at is null order by t.kind, t.name', [cs]));
});
safety.post('/inspection-templates', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, kind: z.enum(KINDS), name: text(200).min(2), interval_days: z.coerce.number().int().min(1).max(3660).nullable().optional(),
    items: z.array(z.object({ text: text(300).min(3) })).min(1).max(80) }), req.body);
  if (!can(req.access, 'safety.manage', b.company_id)) throw forbidden();
  const items = b.items.map((it, i) => ({ key: `q${i + 1}`, text: it.text }));
  const t = await one('insert into inspection_templates (company_id, kind, name, interval_days, items, created_by) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, name) do nothing returning *',
    [b.company_id, b.kind, b.name, b.interval_days ?? null, JSON.stringify(items), req.person.id]);
  if (!t) throw conflict('A template with that name already exists.');
  await audit(pool, req.person.id, b.company_id, 'inspection_template', t.id, 'create', { name: b.name });
  res.status(201).json(t);
});
safety.post('/inspection-templates/:id/retire', async (req, res) => {
  const t = await one('select * from inspection_templates where id = $1', [idParam(req.params.id)]);
  if (!t || !can(req.access, 'safety.manage', t.company_id)) throw notFound();
  await q('update inspection_templates set retired_at = now() where id = $1', [t.id]);
  res.json({ ok: true });
});

// ── Inspections ──
const itemBody = z.object({ key: text(60), result: z.enum(['pass', 'fail', 'na']), comment: text(2000).nullable().optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
  owner_id: uuid.nullable().optional(), follow_up: z.enum(['action', 'repair']).nullable().optional() });
safety.post('/inspections', async (req, res) => {
  const b = parse(z.object({ property_id: uuid, template_id: uuid, location: text(120).nullable().optional(), notes: text(4000).nullable().optional(), items: z.array(itemBody).min(1).max(80) }), req.body);
  const { p, agent, manage } = await propertyAccess(req.access, b.property_id, 'repairs.manage');
  if (agent) throw forbidden('Inspections are recorded by staff.');
  const t = await one('select * from inspection_templates where id = $1 and company_id = $2 and retired_at is null', [b.template_id, p.company_id]);
  if (!t) throw bad('Choose a template of this company.');
  // Every question answered exactly once; a fail needs a comment, a severity and a follow-up.
  const answers = new Map(b.items.map((it) => [it.key, it]));
  if (answers.size !== b.items.length || t.items.length !== b.items.length || t.items.some((q: any) => !answers.has(q.key))) throw bad('Answer every question once.');
  const fields: Record<string, string> = {};
  for (const it of b.items) {
    clean(it.comment);
    if (it.result === 'fail') {
      if (!it.comment || it.comment.length < 3) fields[`${it.key}.comment`] = 'Say what is wrong';
      if (!it.severity) fields[`${it.key}.severity`] = 'Choose a severity';
      if (!it.follow_up) fields[`${it.key}.follow_up`] = 'Choose an action or a repair';
    }
    if (it.owner_id && !(await inCompany(it.owner_id, p.company_id))) fields[`${it.key}.owner_id`] = 'Choose someone from this company';
  }
  if (Object.keys(fields).length) throw bad('Each failed item needs what is wrong, a severity and a follow-up.', { fields });
  clean(b.location); clean(b.notes);
  const out = await tx(async (db) => {
    const count = (r: string) => b.items.filter((i) => i.result === r).length;
    const ins = await one(`insert into inspections (company_id, property_id, template_id, kind, name, location, notes, inspector_id, passed, failed, not_applicable) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [p.company_id, p.id, t.id, t.kind, t.name, b.location ?? null, b.notes ?? null, req.person.id, count('pass'), count('fail'), count('na')], db);
    const items: any[] = [];
    for (const qn of t.items) {
      const it = answers.get(qn.key)!;
      const row = await one(`insert into inspection_items (inspection_id, key, question, result, comment, severity, owner_id, follow_up) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [ins.id, qn.key, qn.text, it.result, it.comment ?? null, it.result === 'fail' ? it.severity : null, it.owner_id ?? null, it.result === 'fail' ? it.follow_up : null], db);
      if (it.result === 'fail') {
        const sev = it.severity!;
        if (it.follow_up === 'repair') {
          const r = await reportRepair(db, req.person.id, p, { title: `${qn.text} (${t.name})`.slice(0, 200), description: it.comment, urgency: URGENCY[sev], location: b.location ?? null,
            urgency_reason: `Severity "${sev}" set at inspection` }, manage);
          await q('update inspection_items set repair_id = $2 where id = $1', [row.id, r.id], db);
          row.repair_id = r.id;
        } else {
          const owner = it.owner_id ?? p.manager_person_id;
          const x = await one(`insert into improvement_actions (company_id, source_type, source_id, finding, action, significance, owner_id, due_on, created_by) values ($1,'inspection',$2,$3,$4,$5,$6, ${LONDON_TODAY} + $7::int, $8) returning id`,
            [p.company_id, row.id, `${t.name} at ${p.name}${b.location ? ` (${b.location})` : ''}: failed "${qn.text}". ${it.comment}`, `Put right: ${qn.text}`, ['high', 'critical'].includes(sev) ? 'significant' : 'standard', owner ?? null, DUE_DAYS[sev], req.person.id], db);
          await q('update inspection_items set action_id = $2 where id = $1', [row.id, x.id], db);
          row.action_id = x.id;
          if (owner && owner !== req.person.id) await notify(db, owner, p.company_id, `${sev === 'critical' ? 'URGENT safety action' : 'Safety action'}: ${qn.text} at ${p.name}`, `/governance/actions/${x.id}`);
        }
      }
      items.push(row);
    }
    if (count('fail') && p.manager_person_id && p.manager_person_id !== req.person.id) await notify(db, p.manager_person_id, p.company_id, `Failed inspection: ${t.name} at ${p.name} (${count('fail')} item${count('fail') === 1 ? '' : 's'})`, `/estates/inspections/${ins.id}`);
    await audit(db, req.person.id, p.company_id, 'inspection', ins.id, 'record', { property_id: p.id, failed: count('fail') });
    return { ...ins, items };
  });
  res.status(201).json(out);
});
safety.get('/inspections', async (req, res) => {
  const v = await visible(req.access);
  res.json(await q(`select i.id, i.property_id, i.kind, i.name, i.location, i.inspected_at, i.passed, i.failed, i.not_applicable, p.name as property_name, p.ref as property_ref, c.code as company_code, ${name('ip')} as inspector_name
                      from inspections i join properties p on p.id = i.property_id join companies c on c.id = i.company_id join people ip on ip.id = i.inspector_id
                     where ${v.where} and ($4::uuid is null or i.company_id = $4) and ($5::uuid is null or i.property_id = $5) order by i.inspected_at desc limit 500`,
    [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null]));
});
async function loadInspection(a: Access, id: string) {
  const i = await one(`select i.*, p.name as property_name, p.ref as property_ref, c.code as company_code, ${name('ip')} as inspector_name from inspections i join properties p on p.id = i.property_id
                         join companies c on c.id = i.company_id join people ip on ip.id = i.inspector_id where i.id = $1`, [id]);
  if (!i) throw notFound();
  const { manage } = await propertyAccess(a, i.property_id, 'safety.manage');
  return { i, manage };
}
safety.get('/inspections/:id', async (req, res) => {
  const { i, manage } = await loadInspection(req.access, idParam(req.params.id));
  res.json({ inspection: i, can: { photos: manage || i.inspector_id === req.person.id },
    items: await q(`select it.*, ${name('o')} as owner_name, x.status as action_status, r.status as repair_status,
                      coalesce((select json_agg(json_build_object('id', f.id, 'original_name', f.original_name, 'uploaded_at', f.uploaded_at) order by f.uploaded_at) from files f where f.entity_type = 'inspection_item' and f.entity_id = it.id), '[]') as photos
                      from inspection_items it left join people o on o.id = it.owner_id left join improvement_actions x on x.id = it.action_id left join repairs r on r.id = it.repair_id
                     where it.inspection_id = $1 order by (it.result = 'fail') desc, it.key`, [i.id]) });
});
safety.post('/inspection-items/:id/photos', upload.single('file'), async (req, res) => {
  const it = await one('select * from inspection_items where id = $1', [idParam(req.params.id)]);
  if (!it) throw notFound();
  const { i, manage } = await loadInspection(req.access, it.inspection_id);
  if (!(manage || i.inspector_id === req.person.id)) throw forbidden();
  if (!req.file) throw bad('Choose a photo to upload.');
  if ((await one<{ n: number }>(`select count(*)::int n from files where entity_type = 'inspection_item' and entity_id = $1`, [it.id]))!.n >= 6) throw conflict('Up to 6 photos per item.');
  const f = await tx((db) => saveFile(db, { companyId: i.company_id, entityType: 'inspection_item', entityId: it.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true }));
  res.status(201).json({ id: f.id });
});

// ── Overview: one card per property (all properties, not only compliance-monitored ones) ──
safety.get('/safety/overview', async (req, res) => {
  const a = req.access;
  const v = await visible(a);
  const compliance = scope(a, null).filter((c) => can(a, 'compliance.view', c) || can(a, 'compliance.record', c) || can(a, 'compliance.manage', c));
  const rows = await q(`select p.id, p.name, p.ref, p.address_line1, p.postcode, p.company_id, c.code as company_code, p.photo_path is not null as has_photo, ${AGENT_LABEL('p')} as agent,
        (select max(inspected_at) from inspections i where i.property_id = p.id) as last_inspection,
        (select count(*) from inspections i where i.property_id = p.id and i.failed > 0 and i.inspected_at > now() - interval '30 days')::int as failed_30,
        (select count(*) from risks r where r.property_id = p.id and r.status = 'open')::int as open_risks,
        (select count(*) from risks r where r.property_id = p.id and r.status = 'open' and r.likelihood * r.impact >= 15)::int as high_risks,
        (select count(*) from improvement_actions x join inspection_items it on it.id = x.source_id join inspections i on i.id = it.inspection_id
           where x.source_type = 'inspection' and i.property_id = p.id and x.status not in ('verified','closed'))::int
        + (select count(*) from improvement_actions x join risks r on r.id = x.source_id where x.source_type = 'risk' and r.property_id = p.id and x.status not in ('verified','closed'))::int as open_actions,
        (select min(coalesce(last.done_on, sr.created_at::date - sr.interval_days) + sr.interval_days) from safety_requirements sr
           left join lateral (select done_on from safety_checks sc where sc.requirement_id = sr.id order by done_on desc limit 1) last on true
          where sr.property_id = p.id and sr.retired_at is null) as next_due,
        p.compliance_enabled and p.company_id = any($6::uuid[]) as show_compliance
      from properties p join companies c on c.id = p.company_id
     where p.status <> 'offboarded' and ${v.where} and ($4::uuid is null or p.company_id = $4) and ($5::uuid is null or p.id = $5) order by p.ref`,
    [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null, compliance]);
  // Compliance only for monitored properties the person may see compliance for.
  const ids = rows.filter((r) => r.show_compliance).map((r) => r.id);
  const scores = ids.length ? await q(`select cr.property_id, count(*) filter (where not cr.not_applicable)::int as applicable,
        count(*) filter (where not cr.not_applicable and last.outcome <> 'fail' and last.next_due_on >= ${LONDON_TODAY})::int as compliant
      from compliance_requirements cr left join lateral (select outcome, next_due_on from compliance_records r where r.requirement_id = cr.id order by completed_on desc, created_at desc limit 1) last on true
     where cr.retired_at is null and cr.property_id = any($1::uuid[]) group by cr.property_id`, [ids]) : [];
  const byId = new Map(scores.map((s) => [s.property_id, s.applicable ? Math.round((100 * s.compliant) / s.applicable) : null]));
  res.json(rows.map(({ show_compliance, ...r }) => ({ ...r, compliance_score: show_compliance ? byId.get(r.id) ?? null : undefined })));
});

// ── Property risk register (stored in the shared risks table with a property) ──
async function loadRisk(a: Access, id: string) {
  const r = await one(`select r.*, r.likelihood * r.impact as score, p.name as property_name, p.ref as property_ref, ${name('o')} as owner_name, ${name('cb')} as closed_by_name
                         from risks r join properties p on p.id = r.property_id left join people o on o.id = r.owner_id left join people cb on cb.id = r.closed_by where r.id = $1`, [id]);
  if (!r) throw notFound();
  const { manage } = await propertyAccess(a, r.property_id, 'safety.manage');
  return { r, manage };
}
safety.get('/property-risks', async (req, res) => {
  const v = await visible(req.access);
  res.json(await q(`select r.*, r.likelihood * r.impact as score, p.name as property_name, p.ref as property_ref, c.code as company_code, ${name('o')} as owner_name,
                           (select count(*) from improvement_actions x where x.source_type = 'risk' and x.source_id = r.id and x.status not in ('verified','closed'))::int as open_actions,
                           (r.status = 'open' and r.review_on < ${LONDON_TODAY}) as review_overdue
                      from risks r join properties p on p.id = r.property_id join companies c on c.id = r.company_id left join people o on o.id = r.owner_id
                     where ${v.where} and ($4::uuid is null or r.company_id = $4) and ($5::uuid is null or r.property_id = $5)
                     order by r.status, r.likelihood * r.impact desc, r.created_at desc`,
    [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null]));
});
const riskBody = z.object({ location: text(120).nullable(), category: text(80).nullable(), title: text(200).min(3), description: text(4000).nullable(), likelihood: z.coerce.number().int().min(1).max(5),
  impact: z.coerce.number().int().min(1).max(5), controls: text(4000).nullable(), owner_id: uuid.nullable(), target_on: isoDate.nullable(), review_on: isoDate.nullable() }).partial();
safety.post('/property-risks', async (req, res) => {
  const b = parse(riskBody.extend({ property_id: uuid, title: text(200).min(3), likelihood: z.coerce.number().int().min(1).max(5), impact: z.coerce.number().int().min(1).max(5) }), req.body);
  const { p, manage } = await propertyAccess(req.access, b.property_id, 'safety.manage');
  if (!manage) throw forbidden('Only someone who manages property safety can add a risk. Report the hazard through an inspection or a repair.');
  for (const t of [b.title, b.description, b.location, b.controls]) clean(t);
  if (b.owner_id && !(await inCompany(b.owner_id, p.company_id))) throw bad('Choose an owner from this company.', { fields: { owner_id: 'Not in this company' } });
  const r = await tx(async (db) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`risk-ref-${p.company_id}`], db);
    const ref = (await one<{ ref: string }>(`select 'R-' || lpad((coalesce(max(substring(ref from 3)::int), 0) + 1)::text, 4, '0') as ref from risks where company_id = $1 and ref ~ '^R-[0-9]+$'`, [p.company_id], db))!.ref;
    const row = await one(`insert into risks (company_id, property_id, ref, location, category, title, description, likelihood, impact, controls, owner_id, target_on, review_on, created_by)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [p.company_id, p.id, ref, b.location ?? null, b.category ?? null, b.title, b.description ?? null, b.likelihood, b.impact, b.controls ?? null, b.owner_id ?? null, b.target_on ?? null, b.review_on ?? null, req.person.id], db);
    await q('insert into risk_assessments (risk_id, likelihood, impact, note, assessed_by) values ($1,$2,$3,$4,$5)', [row.id, b.likelihood, b.impact, 'Initial assessment', req.person.id], db);
    await audit(db, req.person.id, p.company_id, 'risk', row.id, 'create', { property_id: p.id, ref, score: b.likelihood * b.impact });
    if (row.owner_id && row.owner_id !== req.person.id) await notify(db, row.owner_id, p.company_id, `Risk for you: ${ref} ${b.title} at ${p.name}`, `/estates/risks/${row.id}`);
    return row;
  });
  res.status(201).json(r);
});
safety.get('/property-risks/:id', async (req, res) => {
  const { r, manage } = await loadRisk(req.access, idParam(req.params.id));
  res.json({ risk: r, can: { manage, close: manage && r.status === 'open' && r.owner_id !== req.person.id, evidence: manage || r.owner_id === req.person.id },
    assessments: await q(`select ra.*, ${name('p')} as assessed_by_name from risk_assessments ra join people p on p.id = ra.assessed_by where ra.risk_id = $1 order by ra.assessed_at desc`, [r.id]),
    actions: await q(`select x.id, x.action, x.status, x.due_on, x.significance, ${name('o')} as owner_name from improvement_actions x left join people o on o.id = x.owner_id where x.source_type = 'risk' and x.source_id = $1 order by x.created_at`, [r.id]),
    files: await q(`select id, original_name, uploaded_at, mime_type like 'image/%' as is_image from files where entity_type = 'risk' and entity_id = $1 order by uploaded_at`, [r.id]) });
});
safety.patch('/property-risks/:id', async (req, res) => {
  const { r, manage } = await loadRisk(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (r.status !== 'open') throw conflict('This risk is closed.');
  const b = parse(riskBody.extend({ assessment_note: text(2000).optional() }).strict(), req.body);
  const { assessment_note, ...f } = b;
  for (const t of [f.title, f.description, f.location, f.controls]) clean(t);
  if (f.owner_id && !(await inCompany(f.owner_id, r.company_id))) throw bad('Choose an owner from this company.');
  const rescored = (f.likelihood !== undefined && f.likelihood !== r.likelihood) || (f.impact !== undefined && f.impact !== r.impact);
  if (rescored && (!assessment_note || assessment_note.length < 3)) throw bad('Say why the rating changed.', { fields: { assessment_note: 'Required when the rating changes' } });
  const keys = Object.keys(f);
  if (!keys.length) throw bad('Nothing to save.');
  await tx(async (db) => {
    await q(`update risks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [r.id, ...keys.map((k) => (f as any)[k])], db);
    if (rescored) await q('insert into risk_assessments (risk_id, likelihood, impact, note, assessed_by) values ($1,$2,$3,$4,$5)', [r.id, f.likelihood ?? r.likelihood, f.impact ?? r.impact, assessment_note, req.person.id], db);
    await audit(db, req.person.id, r.company_id, 'risk', r.id, 'update', Object.fromEntries(keys.map((k) => [k, { from: r[k] ?? null, to: (f as any)[k] }])));
  });
  res.json({ ok: true });
});
safety.post('/property-risks/:id/evidence', upload.single('file'), async (req, res) => {
  const { r, manage } = await loadRisk(req.access, idParam(req.params.id));
  if (!(manage || r.owner_id === req.person.id)) throw forbidden();
  if (!req.file) throw bad('Choose a file.');
  const f = await tx((db) => saveFile(db, { companyId: r.company_id, entityType: 'risk', entityId: r.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id }));
  res.status(201).json({ id: f.id });
});
// Closing is verification: by a safety manager who is not the risk's owner, once every action is verified.
safety.post('/property-risks/:id/close', async (req, res) => {
  const { r, manage } = await loadRisk(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (r.status !== 'open') throw conflict('This risk is already closed.');
  if (r.owner_id === req.person.id) throw forbidden('Someone other than the risk owner must confirm it can close.');
  const note = parse(text(2000).min(5, 'Say what was checked'), req.body?.note);
  await assertRiskActionsVerified(r.id);
  await tx(async (db) => {
    await q(`update risks set status = 'closed', closure_note = $2, closed_by = $3, closed_at = now(), updated_at = now() where id = $1`, [r.id, note, req.person.id], db);
    await audit(db, req.person.id, r.company_id, 'risk', r.id, 'close', { note });
  });
  res.json({ ok: true });
});

// ── Safety actions for a property: from inspections, risks, scheduled checks and compliance records ──
safety.get('/safety/actions', async (req, res) => {
  const v = await visible(req.access);
  res.json(await q(`with src as (
        select x.id, i.property_id from improvement_actions x join inspection_items it on it.id = x.source_id join inspections i on i.id = it.inspection_id where x.source_type = 'inspection'
        union all select x.id, r.property_id from improvement_actions x join risks r on r.id = x.source_id where x.source_type = 'risk' and r.property_id is not null
        union all select x.id, sr.property_id from improvement_actions x join safety_checks sc on sc.id = x.source_id join safety_requirements sr on sr.id = sc.requirement_id where x.source_type = 'safety_check')
      select x.id, x.source_type, x.finding, x.action, x.status, x.due_on, x.significance, ${name('o')} as owner_name, p.id as property_id, p.name as property_name, p.ref as property_ref,
             (x.status not in ('verified','closed') and x.due_on < ${LONDON_TODAY}) as overdue
        from src join improvement_actions x on x.id = src.id join properties p on p.id = src.property_id left join people o on o.id = x.owner_id
       where ${v.where} and ($4::uuid is null or p.company_id = $4) and ($5::uuid is null or p.id = $5)
       order by x.status in ('verified','closed'), x.due_on nulls last limit 500`,
    [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null]));
});
