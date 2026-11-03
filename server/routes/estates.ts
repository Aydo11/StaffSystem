import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { issueAccessLink, sendAccessEmail } from './account.ts';
import { propertyVisible } from '../visibility.ts';
import { upload } from './people.ts';
import { CATEGORIES, suggestUrgency, URGENCY_RANK } from '../repairPriority.ts';

export const estates = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const noResidents = (s: string | null | undefined) => !s || !/\b(resident|tenant|service user)\s+(name|called|is)\b/i.test(s);
const residentMsg = 'Describe the property issue only. Do not include resident names or personal details.';

// Properties an agent user may see: those linked to their agents.
async function agentPropertyIds(a: Access, db: Db = pool) {
  if (!a.agentIds.length) return [];
  return (await q<{ property_id: string }>('select property_id from agent_properties where agent_id = any($1::uuid[])', [a.agentIds], db)).map((r) => r.property_id);
}
// Staff see estates records for properties they can see; managers by permission; agents for their linked properties.
async function propertyAccess(a: Access, propertyId: string, perm?: string) {
  const p = await one(`select p.* from properties p where p.id = $1`, [propertyId]);
  if (!p) throw notFound();
  if ((await agentPropertyIds(a)).includes(p.id)) return { p, agent: true, manage: false };
  const seen = await one(`select 1 from properties p where p.id = $1 and ${propertyVisible('p', 2, 3)}`, [p.id, a.personId, companiesWith(a, 'properties.view').concat(companiesWith(a, 'repairs.manage'), companiesWith(a, 'safety.manage'))]);
  if (!seen) throw notFound();
  return { p, agent: false, manage: perm ? can(a, perm, p.company_id) : false };
}

// ── Safety schedules ──
const SAFETY = `
  select sr.*, p.name as property_name, p.ref as property_ref, c.code as company_code, c.name as company_name, last.done_on as last_done, last.result as last_result, last.id as last_check_id,
         (coalesce(last.done_on, sr.created_at::date - sr.interval_days) + sr.interval_days) as next_due,
         case when last.done_on is null then 'never_done' when last.result = 'fail' then 'failed'
              when last.done_on + sr.interval_days < ${LONDON_TODAY} then 'overdue' when last.done_on + sr.interval_days <= ${LONDON_TODAY} + 30 then 'due_soon' else 'in_date' end as state
    from safety_requirements sr join properties p on p.id = sr.property_id join companies c on c.id = sr.company_id
    left join lateral (select id, done_on, result from safety_checks sc where sc.requirement_id = sr.id order by done_on desc, created_at desc limit 1) last on true
   where sr.retired_at is null`;
estates.get('/safety', async (req, res) => {
  const a = req.access;
  const property = req.query.property ? parse(uuid, req.query.property) : null;
  const agentProps = await agentPropertyIds(a);
  const cs = scope(a, null, req.query.company).filter((c) => can(a, 'safety.manage', c) || can(a, 'properties.view', c) || can(a, 'governance.view', c));
  res.json(await q(`${SAFETY} and (sr.company_id = any($1::uuid[]) or sr.property_id = any($2::uuid[])) and ($3::uuid is null or sr.property_id = $3) order by next_due`, [cs, agentProps, property]));
});
estates.post('/safety/requirements', async (req, res) => {
  const b = parse(z.object({ property_id: uuid, name: text(200).min(3), interval_days: z.coerce.number().int().min(1).max(3660), responsible: text(200).min(2), notes: text(2000).nullable().optional() }), req.body);
  const { p } = await propertyAccess(req.access, b.property_id);
  need(req.access, 'safety.manage', p.company_id);
  const r = await one('insert into safety_requirements (company_id, property_id, name, interval_days, responsible, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *',
    [p.company_id, p.id, b.name, b.interval_days, b.responsible, b.notes ?? null, req.person.id]);
  await audit(pool, req.person.id, p.company_id, 'safety_requirement', r.id, 'create', { name: b.name });
  res.status(201).json(r);
});
estates.post('/safety/requirements/:id/retire', async (req, res) => {
  const r = await one('select * from safety_requirements where id = $1', [idParam(req.params.id)]);
  if (!r) throw notFound();
  need(req.access, 'safety.manage', r.company_id);
  await q('update safety_requirements set retired_at = now() where id = $1', [r.id]);
  res.json({ ok: true });
});
estates.get('/safety/requirements/:id', async (req, res) => {
  const r = await one('select * from safety_requirements where id = $1', [idParam(req.params.id)]);
  if (!r) throw notFound();
  const { manage } = await propertyAccess(req.access, r.property_id, 'safety.manage');
  res.json({ requirement: (await one(`${SAFETY} and sr.id = $1`, [r.id])),
    checks: await q(`select sc.*, ${name('rb')} as recorded_by_name, ${name('vb')} as verified_by_name from safety_checks sc join people rb on rb.id = sc.recorded_by left join people vb on vb.id = sc.verified_by where sc.requirement_id = $1 order by sc.done_on desc`, [r.id]),
    actions: await q(`select x.id, x.action, x.status, x.due_on from improvement_actions x join safety_checks sc on sc.id = x.source_id where x.source_type = 'safety_check' and sc.requirement_id = $1`, [r.id]),
    can: { manage } });
});
// A failed check opens a significant improvement action automatically, so it is followed through to verification.
estates.post('/safety/requirements/:id/checks', upload.single('file'), async (req, res) => {
  const r = await one('select * from safety_requirements where id = $1 and retired_at is null', [idParam(req.params.id)]);
  if (!r) throw notFound();
  const { manage, agent } = await propertyAccess(req.access, r.property_id, 'safety.manage');
  if (!manage && !agent) throw forbidden();
  const b = parse(z.object({ done_on: isoDate, done_by_text: text(200).nullable().optional(), result: z.enum(['pass', 'advisory', 'fail']), findings: text(4000).nullable().optional() }), req.body);
  if (!noResidents(b.findings)) throw bad(residentMsg, { fields: { findings: 'Property details only' } });
  if (b.result !== 'pass' && !b.findings) throw bad('Describe what was found.', { fields: { findings: 'Required' } });
  if ((await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} f`, [b.done_on]))!.f) throw bad('The check date cannot be in the future.', { fields: { done_on: 'In the future' } });
  const out = await tx(async (db) => {
    const sc = await one(`insert into safety_checks (requirement_id, done_on, done_by_text, result, findings, recorded_by) values ($1,$2,$3,$4,$5,$6) returning *`, [r.id, b.done_on, b.done_by_text ?? null, b.result, b.findings ?? null, req.person.id], db);
    if (req.file) {
      const f = await saveFile(db, { companyId: r.company_id, entityType: 'safety_check', entityId: sc.id, name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id });
      await q('update safety_checks set evidence_file_id = $2 where id = $1', [sc.id, f.id], db);
    }
    let action: any = null;
    if (b.result === 'fail') {
      const owner = await one<{ manager_person_id: string | null }>('select manager_person_id from properties where id = $1', [r.property_id], db);
      action = await one(`insert into improvement_actions (company_id, source_type, source_id, finding, action, significance, owner_id, due_on, created_by) values ($1,'safety_check',$2,$3,$4,'significant',$5, ${LONDON_TODAY} + 7, $6) returning id`,
        [r.company_id, sc.id, `${r.name} failed: ${b.findings}`, `Put right the failed ${r.name.toLowerCase()} and arrange a re-check`, owner?.manager_person_id ?? null, req.person.id], db);
      if (owner?.manager_person_id) await notify(db, owner.manager_person_id, r.company_id, `Failed safety check: ${r.name}`, `/governance/actions/${action.id}`);
    }
    await audit(db, req.person.id, r.company_id, 'safety_check', sc.id, 'record', { result: b.result });
    return { check: sc, action };
  });
  res.status(201).json(out);
});
estates.post('/safety/checks/:id/verify', async (req, res) => {
  const sc = await one('select sc.*, sr.company_id from safety_checks sc join safety_requirements sr on sr.id = sc.requirement_id where sc.id = $1', [idParam(req.params.id)]);
  if (!sc) throw notFound();
  need(req.access, 'safety.manage', sc.company_id);
  if (sc.recorded_by === req.person.id) throw forbidden('Someone other than the person who recorded the check must verify it.');
  await q('update safety_checks set verified_by = $2, verified_at = now() where id = $1', [sc.id, req.person.id]);
  res.json({ ok: true });
});

// ── Repairs: Reported → Under review → Assigned → In progress ⇄ Awaiting parts/access → Completed → Verified → Closed.
// Cancelled (with a reason) from any stage before the work is done; Closed or Cancelled can be Reopened (with a reason).
export const DONE = `('verified','closed','cancelled')`; // no more work: excluded from open, overdue and escalation
const NEXT: Record<string, string[]> = {
  reported: ['under_review', 'assigned', 'cancelled'], under_review: ['assigned', 'cancelled'], assigned: ['in_progress', 'awaiting_parts', 'cancelled'],
  in_progress: ['awaiting_parts', 'completed', 'cancelled'], awaiting_parts: ['in_progress', 'completed', 'cancelled'], completed: ['verified', 'in_progress'],
  verified: ['closed', 'in_progress'], closed: ['reopened'], cancelled: ['reopened'], reopened: ['under_review', 'assigned', 'cancelled'],
};
// Moves only a repairs manager may make; the rest can also be made by whoever is doing the work.
const MANAGER_MOVES = ['under_review', 'assigned', 'cancelled', 'verified', 'closed', 'reopened'];
const LOCKED = ['closed', 'cancelled'];

// Repairs the person may see: agent-linked properties, their own properties, or by permission.
const visibleRepairs = (a: Access, agentProps: string[]) => ({
  where: `(r.property_id = any($1::uuid[]) or (${propertyVisible('p', 2, 3)}))`,
  args: [agentProps, a.personId, companiesWith(a, 'properties.view').concat(companiesWith(a, 'repairs.manage'))] as unknown[],
});
estates.get('/repairs', async (req, res) => {
  const a = req.access;
  const v = visibleRepairs(a, await agentPropertyIds(a));
  res.json(await q(`select r.*, p.name as property_name, p.ref as property_ref, c.code as company_code, c.name as company_name, ${name('as_')} as assignee_name, ag.name as agent_name, ${name('rb')} as reported_by_name,
                           (r.status not in ${DONE} and r.due_on < ${LONDON_TODAY}) as overdue,
                           (r.category is not null and r.status <> 'cancelled' and exists (select 1 from repairs x where x.property_id = r.property_id and x.category = r.category and x.id <> r.id and x.status <> 'cancelled'
                              and x.reported_on between r.reported_on - 90 and r.reported_on and (x.reported_on < r.reported_on or x.created_at < r.created_at))) as repeat
                      from repairs r join properties p on p.id = r.property_id join companies c on c.id = r.company_id left join people as_ on as_.id = r.assignee_id left join agents ag on ag.id = r.agent_id join people rb on rb.id = r.reported_by
                     where ${v.where} and ($4::uuid is null or r.company_id = $4) and ($5::uuid is null or r.property_id = $5)
                     order by r.status in ${DONE}, case r.urgency when 'emergency' then 0 when 'urgent' then 1 when 'routine' then 2 else 3 end, r.created_at desc limit 1000`,
    [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null]));
});

// Dashboard figures, all from repair records. The period (default: this month so far) applies to completed, resolution, target, repeat and spend.
estates.get('/repairs/summary', async (req, res) => {
  const a = req.access;
  const v = visibleRepairs(a, await agentPropertyIds(a));
  const f = parse(z.object({ company: uuid.optional(), property: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
  const m = await one(`with w as (select coalesce($6::date, date_trunc('month', ${LONDON_TODAY})::date) as f, coalesce($7::date, ${LONDON_TODAY}) as t),
      rs as (select r.* from repairs r join properties p on p.id = r.property_id where ${v.where} and ($4::uuid is null or r.company_id = $4) and ($5::uuid is null or r.property_id = $5)),
      done as (select rs.* from rs, w where rs.status <> 'cancelled' and rs.completed_on between w.f and w.t)
    select (select f from w) as period_from, (select t from w) as period_to,
      (select count(*) from rs where status not in ${DONE})::int as open,
      (select count(*) from rs where reported_on = ${LONDON_TODAY})::int as reported_today,
      (select count(*) from rs where status not in ${DONE} and urgency = 'emergency')::int as emergency,
      (select count(*) from rs where status not in ${DONE} and due_on < ${LONDON_TODAY})::int as overdue,
      (select count(*) from done)::int as completed,
      (select round(avg(completed_on - reported_on), 1) from done) as avg_days,
      (select count(*) from done where completed_on <= due_on)::int as within_target,
      (select count(*) from rs, w where rs.status <> 'cancelled' and rs.category is not null and rs.reported_on between w.f and w.t
         and exists (select 1 from repairs x where x.property_id = rs.property_id and x.category = rs.category and x.id <> rs.id and x.status <> 'cancelled'
                       and x.reported_on between rs.reported_on - 90 and rs.reported_on and (x.reported_on < rs.reported_on or x.created_at < rs.created_at)))::int as repeat,
      (select coalesce(sum(cost), 0) from done) as spend,
      (select count(*) from done where cost is null)::int as spend_missing,
      (select count(*) from rs where status not in ${DONE} and category is null)::int as uncategorised,
      (select coalesce(jsonb_object_agg(k, n), '{}') from (select coalesce(category, 'uncategorised') k, count(*)::int n from rs where status not in ${DONE} group by 1) x) as by_category,
      (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*)::int n from rs where status not in ${DONE} group by 1) x) as by_status,
      (select coalesce(jsonb_object_agg(urgency, n), '{}') from (select urgency, count(*)::int n from rs where status not in ${DONE} group by 1) x) as by_urgency`,
    [...v.args, f.company ?? null, f.property ?? null, f.from ?? null, f.to ?? null]);
  res.json(m);
});

// Target days per priority, per company.
estates.get('/repairs/sla', async (req, res) => {
  const cs = scope(req.access, null, req.query.company).filter((c) => can(req.access, 'repairs.manage', c) || can(req.access, 'properties.view', c));
  res.json(await q('select s.*, c.code as company_code from repair_sla s join companies c on c.id = s.company_id where s.company_id = any($1::uuid[]) order by c.code, s.target_days', [cs]));
});
estates.put('/repairs/sla', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, targets: z.array(z.object({ urgency: z.enum(['emergency', 'urgent', 'routine', 'planned']), target_days: z.coerce.number().int().min(0).max(365), escalate_after_days: z.coerce.number().int().min(0).max(90) })).min(1).max(4) }), req.body);
  need(req.access, 'repairs.manage', b.company_id);
  await tx(async (db) => {
    for (const t of b.targets) await q(`insert into repair_sla (company_id, urgency, target_days, escalate_after_days, updated_by, updated_at) values ($1,$2,$3,$4,$5,now())
      on conflict (company_id, urgency) do update set target_days = excluded.target_days, escalate_after_days = excluded.escalate_after_days, updated_by = excluded.updated_by, updated_at = now()`, [b.company_id, t.urgency, t.target_days, t.escalate_after_days, req.person.id], db);
    await audit(db, req.person.id, b.company_id, 'repair_sla', null, 'update', { targets: b.targets });
  });
  res.json({ ok: true });
});

export async function loadRepair(a: Access, id: string) {
  const r = await one(`select r.*, p.name as property_name, c.code as company_code, ${name('as_')} as assignee_name, ag.name as agent_name, ${name('rb')} as reported_by_name,
                                t.owner_id as manager_id, ${name('tm')} as manager_name, t.status as task_status, ${name('vb')} as verified_by_name
                         from repairs r join properties p on p.id = r.property_id join companies c on c.id = r.company_id left join people as_ on as_.id = r.assignee_id
                         left join agents ag on ag.id = r.agent_id join people rb on rb.id = r.reported_by left join tasks t on t.id = r.task_id left join people tm on tm.id = t.owner_id
                         left join people vb on vb.id = r.verified_by where r.id = $1`, [id]);
  if (!r) throw notFound();
  // The repairs manager holding this repair's task runs it, even without repairs.manage or sight of the property otherwise.
  const mine = r.manager_id === a.personId && a.perms.has(r.company_id);
  const { manage, agent } = mine ? { manage: true, agent: false } : await propertyAccess(a, r.property_id, 'repairs.manage');
  return { r, manage, agentWork: agent && r.agent_id && a.agentIds.includes(r.agent_id), assignee: r.assignee_id === a.personId };
}
estates.get('/repairs/:id', async (req, res) => {
  const { r, manage, agentWork, assignee } = await loadRepair(req.access, idParam(req.params.id));
  const work = manage || agentWork || assignee;
  res.json({ repair: r, updates: await q(`select u.*, ${name('au')} as author_name from repair_updates u join people au on au.id = u.author_id where u.repair_id = $1 order by u.created_at`, [r.id]),
    files: await q(`select id, original_name, uploaded_at, tag, mime_type like 'image/%' as is_image from files where entity_type = 'repair' and entity_id = $1 order by uploaded_at`, [r.id]),
    can: { manage, work, photos: r.reported_by === req.person.id, next: NEXT[r.status].filter((s) => (MANAGER_MOVES.includes(s) || r.status === 'verified' ? manage : work)) } });
});
const urgencyEnum = z.enum(['emergency', 'urgent', 'routine', 'planned']);
const categoryEnum = z.enum(CATEGORIES);
export const repairBody = z.object({
  property_id: uuid, title: text(200).min(3), description: text(4000).nullable().optional(), impact: text(1000).nullable().optional(), urgency: urgencyEnum,
  immediate_action: text(2000).nullable().optional(), category: categoryEnum.nullable().optional(), location: text(120).nullable().optional(),
  reported_on: isoDate.optional(), notes: text(4000).nullable().optional(), urgency_reason: text(1000).nullable().optional(),
  // Only someone who manages repairs for the property may set these when reporting.
  agent_id: uuid.nullable().optional(), contractor: text(200).nullable().optional(), due_on: isoDate.nullable().optional(),
});
// Shared with the visit finish form, which can report a repair in the same save.
export async function reportRepair(db: Db, personId: string, p: { id: string; company_id: string; name: string; manager_person_id: string | null }, b: Omit<z.infer<typeof repairBody>, 'property_id'>, manage = false) {
  for (const t of [b.title, b.description, b.impact, b.location, b.notes]) if (!noResidents(t)) throw bad(residentMsg);
  if (!manage && (b.agent_id || b.contractor || b.due_on)) throw forbidden('Only a repairs manager can assign a repair or set its deadline.');
  if (b.agent_id && !(await one('select 1 from agents where id = $1 and company_id = $2', [b.agent_id, p.company_id], db))) throw bad('Choose an agent of this company.');
  if (b.reported_on && (await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} or $1::date < ${LONDON_TODAY} - 365 f`, [b.reported_on], db))!.f) throw bad('The date reported must be within the last year and not in the future.', { fields: { reported_on: 'Check the date' } });
  // The suggestion can be raised by anyone; lowering it needs a repairs manager and a reason, otherwise the suggestion stands.
  const s = suggestUrgency(`${b.title} ${b.description ?? ''} ${b.impact ?? ''}`);
  let urgency = b.urgency;
  if (URGENCY_RANK[urgency] > URGENCY_RANK[s.urgency]) {
    if (manage && b.urgency_reason && b.urgency_reason.trim().length >= 3) { /* authorised override */ }
    else if (manage) throw bad(`This sounds ${s.urgency}: ${s.reason.toLowerCase()}. Give a reason to set a lower priority.`, { fields: { urgency_reason: 'Required to lower the priority' } });
    else urgency = s.urgency;
  }
  const r = await one(`insert into repairs (company_id, property_id, title, description, impact, urgency, immediate_action, reported_by, category, location, reported_on, suggested_urgency, urgency_reason, notes, agent_id, contractor, due_on)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::date, ${LONDON_TODAY}),$12,$13,$14,$15,$16,
                         coalesce($17::date, coalesce($11::date, ${LONDON_TODAY}) + coalesce((select target_days from repair_sla where company_id = $1 and urgency = $6), case $6 when 'emergency' then 1 when 'urgent' then 7 when 'routine' then 28 else 90 end))) returning *`,
    [p.company_id, p.id, b.title, b.description ?? null, b.impact ?? null, urgency, b.immediate_action ?? null, personId, b.category ?? null, b.location ?? null, b.reported_on ?? null, s.urgency,
     urgency !== s.urgency ? (b.urgency_reason ?? null) : null, b.notes ?? null, b.agent_id ?? null, b.contractor ?? null, b.due_on ?? null], db);
  // The repairs manager (Governance → Leads: the lead with the fewest open repair tasks, then a deputy) gets a task, else the property manager.
  const lead = await one<{ id: string }>(`select g.person_id as id from governance_leads g join appointments a on a.person_id = g.person_id and a.company_id = g.company_id and ${ACTIVE_APPT('a')}
      where g.company_id = $1 and g.area = 'repairs' and g.to_date is null group by g.person_id, g.role
      order by g.role = 'deputy', (select count(*) from repairs x join tasks t on t.id = x.task_id where t.owner_id = g.person_id and t.status <> 'completed'), min(g.created_at) limit 1`, [p.company_id], db);
  const owner = lead?.id ?? p.manager_person_id;
  const t = await one(`insert into tasks (company_id, property_id, title, description, owner_id, created_by, due_on, priority) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [p.company_id, p.id, `Repair (${urgency}) at ${p.name}: ${b.title}`, `${b.description ?? ''}\n\nOpen the repair to assign it and record progress: /estates/repairs/${r.id}\nThis task completes itself when the repair is closed.`.trim(),
     owner, personId, r.due_on, urgency === 'emergency' ? 'urgent' : urgency === 'urgent' ? 'high' : 'normal'], db);
  await q('update repairs set task_id = $2 where id = $1', [r.id, t!.id], db);
  r.task_id = t!.id;
  const title = `${urgency === 'emergency' ? 'EMERGENCY repair' : 'Repair reported'}: ${b.title} at ${p.name}`;
  for (const who of new Set([owner, p.manager_person_id])) if (who && who !== personId) await notify(db, who, p.company_id, title, `/estates/repairs/${r.id}`);
  await audit(db, personId, p.company_id, 'repair', r.id, 'report', { urgency, suggested: s.urgency, task_id: t!.id });
  return r;
}
estates.post('/repairs', async (req, res) => {
  const b = parse(repairBody, req.body);
  const { p, manage } = await propertyAccess(req.access, b.property_id, 'repairs.manage');
  res.status(201).json(await reportRepair(pool, req.person.id, p, b, manage));
});
// Live suggestion for the report form (the same rule the server applies).
estates.post('/repairs/suggest', async (req, res) => {
  const b = parse(z.object({ text: text(6000) }), req.body);
  res.json(suggestUrgency(b.text));
});
estates.patch('/repairs/:id', async (req, res) => {
  const { r, manage } = await loadRepair(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  if (LOCKED.includes(r.status)) throw conflict(`This repair is ${r.status}. Reopen it, with a reason, to change it.`);
  const b = parse(z.object({ urgency: urgencyEnum, urgency_reason: text(1000).nullable(), assignee_id: uuid.nullable(), agent_id: uuid.nullable(), contractor: text(200).nullable(), due_on: isoDate.nullable(),
    immediate_action: text(2000).nullable(), category: categoryEnum.nullable(), location: text(120).nullable(), notes: text(4000).nullable(), cost: z.coerce.number().min(0).max(1_000_000).nullable() }).partial().strict(), req.body);
  if (b.agent_id && !(await one('select 1 from agents where id = $1 and company_id = $2', [b.agent_id, r.company_id]))) throw bad('Choose an agent of this company.');
  for (const t of [b.location, b.notes]) if (!noResidents(t)) throw bad(residentMsg);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  const out = await tx(async (db) => {
    const row = await one(`update repairs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [r.id, ...keys.map((k) => (b as any)[k])], db);
    // Every change is on record: what it was and what it became.
    await audit(db, req.person.id, r.company_id, 'repair', r.id, 'update', Object.fromEntries(keys.map((k) => [k, { from: r[k] ?? null, to: (b as any)[k] }])));
    return row;
  });
  res.json(out);
});
const statusBody = z.object({
  status: z.enum(['under_review', 'assigned', 'in_progress', 'awaiting_parts', 'completed', 'verified', 'closed', 'cancelled', 'reopened']), note: text(4000).min(2),
  // Completion evidence.
  work_description: text(4000).optional(), completed_on: isoDate.optional(), cost: z.coerce.number().min(0).max(1_000_000).nullable().optional(),
  contractor_attended: z.boolean().nullable().optional(), resident_confirmed: z.boolean().nullable().optional(),
});
estates.post('/repairs/:id/status', async (req, res) => {
  const { r, manage, agentWork, assignee } = await loadRepair(req.access, idParam(req.params.id));
  const b = parse(statusBody, req.body);
  if (!NEXT[r.status].includes(b.status)) throw conflict(`A repair that is ${r.status.replace(/_/g, ' ')} cannot move to ${b.status.replace(/_/g, ' ')}.`);
  if (MANAGER_MOVES.includes(b.status) || r.status === 'verified' ? !manage : !(manage || agentWork || assignee)) throw forbidden();
  if (b.status === 'assigned' && !r.assignee_id && !r.agent_id && !r.contractor) throw bad('Assign a person, agent or contractor first.');
  if (['cancelled', 'reopened'].includes(b.status) && b.note.trim().length < 5) throw bad('Give the reason.', { fields: { note: 'Give the reason' } });
  if (b.status === 'completed') {
    if (!b.work_description || b.work_description.trim().length < 3) throw bad('Describe the work done.', { fields: { work_description: 'Required' } });
    if (!noResidents(b.work_description)) throw bad(residentMsg);
    if (b.completed_on && (await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} or $1::date < $2::date f`, [b.completed_on, r.reported_on]))!.f) throw bad('The completion date must be between the date reported and today.', { fields: { completed_on: 'Check the date' } });
  }
  // Verifying is a second pair of eyes: not the person who marked the work completed.
  const lastWorker = await one<{ author_id: string }>(`select author_id from repair_updates where repair_id = $1 and status_to = 'completed' order by created_at desc limit 1`, [r.id]);
  if (b.status === 'verified' && lastWorker?.author_id === req.person.id) throw forbidden('Someone other than the person who completed the work must verify it.');
  await tx(async (db) => {
    if (b.status === 'completed') await q(`update repairs set completed_on = coalesce($2::date, ${LONDON_TODAY}), work_description = $3, cost = coalesce($4, cost), contractor_attended = $5, resident_confirmed = $6 where id = $1`,
      [r.id, b.completed_on ?? null, b.work_description, b.cost ?? null, b.contractor_attended ?? null, b.resident_confirmed ?? null], db);
    if (b.status === 'verified') await q('update repairs set verified_by = $2, verified_at = now() where id = $1', [r.id, req.person.id], db);
    if (b.status === 'closed') await q('update repairs set closed_at = now() where id = $1', [r.id], db);
    // Sent back or reopened: the work is no longer done, so the completion and verification are cleared (history keeps them).
    if (['in_progress', 'reopened'].includes(b.status) && ['completed', 'verified', 'closed', 'cancelled'].includes(r.status))
      await q('update repairs set completed_on = null, verified_by = null, verified_at = null, closed_at = null, escalated_at = null where id = $1', [r.id], db);
    await q('update repairs set status = $2, updated_at = now() where id = $1', [r.id, b.status], db);
    await q('insert into repair_updates (repair_id, author_id, body, status_from, status_to) values ($1,$2,$3,$4,$5)', [r.id, req.person.id, b.note, r.status, b.status], db);
    // The repairs manager's task completes when the repair is closed or cancelled, and opens again if it is reopened.
    if (['closed', 'cancelled'].includes(b.status) && r.task_id) await q(`update tasks set status = 'completed', completed_at = now(), updated_at = now() where id = $1 and status <> 'completed'`, [r.task_id], db);
    if (b.status === 'reopened' && r.task_id) await q(`update tasks set status = 'in_progress', completed_at = null, updated_at = now() where id = $1`, [r.task_id], db);
    if (b.status === 'reopened' && r.manager_id && r.manager_id !== req.person.id) await notify(db, r.manager_id, r.company_id, `Repair reopened: ${r.title} at ${r.property_name}`, `/estates/repairs/${r.id}`);
    await audit(db, req.person.id, r.company_id, 'repair', r.id, b.status, b.status === 'completed' ? { cost: b.cost ?? null } : {});
  });
  res.json({ ok: true });
});
estates.post('/repairs/:id/updates', upload.single('file'), async (req, res) => {
  const { r, manage, agentWork, assignee } = await loadRepair(req.access, idParam(req.params.id));
  if (!(manage || agentWork || assignee || r.reported_by === req.person.id)) throw forbidden();
  if (LOCKED.includes(r.status)) throw conflict(`This repair is ${r.status}. Reopen it to add to it.`);
  const body = parse(text(4000).min(2), req.body?.body);
  if (!noResidents(body)) throw bad(residentMsg);
  await tx(async (db) => {
    await q('insert into repair_updates (repair_id, author_id, body) values ($1,$2,$3)', [r.id, req.person.id, body], db);
    if (req.file) await saveFile(db, { companyId: r.company_id, entityType: 'repair', entityId: r.id, name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id });
  });
  res.status(201).json({ ok: true });
});

// Photos of the problem (before) and of the finished work (after).
estates.post('/repairs/:id/photos', upload.single('file'), async (req, res) => {
  const { r, manage, agentWork, assignee } = await loadRepair(req.access, idParam(req.params.id));
  if (!(manage || agentWork || assignee || r.reported_by === req.person.id)) throw forbidden();
  if (LOCKED.includes(r.status)) throw conflict(`This repair is ${r.status}.`);
  if (!req.file) throw bad('Choose a photo to upload.');
  const tag = parse(z.enum(['before', 'after']).optional(), req.body?.tag || undefined);
  if ((await one<{ n: number }>(`select count(*)::int n from files where entity_type = 'repair' and entity_id = $1`, [r.id]))!.n >= 20) throw conflict('A repair can have up to 20 photos and documents.');
  const f = await tx(async (db) => {
    const f = await saveFile(db, { companyId: r.company_id, entityType: 'repair', entityId: r.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true });
    await q('update files set tag = $2 where id = $1', [f.id, tag ?? (['completed', 'verified'].includes(r.status) ? 'after' : 'before')], db);
    return f;
  });
  res.status(201).json({ id: f.id });
});

// Hourly: repairs past their target by the company's escalation days are escalated once to the repairs manager and property manager.
export async function escalateRepairs() {
  await tx(async (db) => {
    for (const r of await q(`select r.id, r.company_id, r.title, r.urgency, p.name as property_name, p.manager_person_id, t.owner_id
                               from repairs r join properties p on p.id = r.property_id left join tasks t on t.id = r.task_id
                               left join repair_sla s on s.company_id = r.company_id and s.urgency = r.urgency
                              where r.status not in ${DONE} and r.status <> 'completed' and r.escalated_at is null and r.due_on + coalesce(s.escalate_after_days, 0) < ${LONDON_TODAY}
                              for update of r skip locked`, [], db)) {
      for (const who of new Set([r.owner_id, r.manager_person_id])) if (who) await notify(db, who, r.company_id, `Overdue ${r.urgency} repair: ${r.title} at ${r.property_name}`, `/estates/repairs/${r.id}`);
      await q('update repairs set escalated_at = now() where id = $1', [r.id], db);
      await audit(db, null, r.company_id, 'repair', r.id, 'escalate', {});
    }
  });
}

// ── Managing agents ──
async function loadAgent(a: Access, id: string, perm = 'agents.manage') {
  const ag = await one('select ag.*, c.code as company_code, c.name as company_name from agents ag join companies c on c.id = ag.company_id where ag.id = $1', [id]);
  if (!ag || !(can(a, perm, ag.company_id) || can(a, 'governance.view', ag.company_id))) throw notFound();
  return { ag, manage: can(a, 'agents.manage', ag.company_id) };
}
estates.get('/agents', async (req, res) => {
  const cs = scope(req.access, null, req.query.company).filter((c) => can(req.access, 'agents.manage', c) || can(req.access, 'governance.view', c));
  res.json(await q(`select ag.*, c.code as company_code, c.name as company_name,
                           (select count(*) from agent_properties ap where ap.agent_id = ag.id)::int as properties,
                           (select round(avg((s->>'score')::numeric), 1) from agent_reviews r, jsonb_array_elements(r.scores) s where r.agent_id = ag.id and r.id = (select id from agent_reviews r2 where r2.agent_id = ag.id order by period_end desc limit 1)) as last_score,
                           (select max(period_end) from agent_reviews r where r.agent_id = ag.id) as last_review,
                           (select count(*) from improvement_actions x where x.source_type = 'agent' and x.source_id = ag.id and x.status <> 'closed')::int as open_actions
                      from agents ag join companies c on c.id = ag.company_id where ag.company_id = any($1::uuid[]) order by ag.name`, [cs]));
});
estates.get('/agents/:id', async (req, res) => {
  const { ag, manage } = await loadAgent(req.access, idParam(req.params.id));
  res.json({ agent: ag, can: { manage },
    properties: await q('select p.id, p.name, p.ref from agent_properties ap join properties p on p.id = ap.property_id where ap.agent_id = $1 order by p.ref', [ag.id]),
    users: await q(`select au.person_id, ${name('p')} as name, p.email, au.expires_at from agent_users au join people p on p.id = au.person_id where au.agent_id = $1`, [ag.id]),
    reviews: await q(`select r.*, ${name('p')} as reviewer_name from agent_reviews r join people p on p.id = r.reviewer_id where r.agent_id = $1 order by r.period_end desc`, [ag.id]),
    actions: await q(`select id, finding, action, status, due_on, significance from improvement_actions where source_type = 'agent' and source_id = $1 order by created_at desc`, [ag.id]),
    repairs: await q(`select r.id, r.title, r.status, r.urgency, r.due_on, p.name as property_name from repairs r join properties p on p.id = r.property_id where r.agent_id = $1 and r.status not in ${DONE} order by r.due_on`, [ag.id]) });
});
const agentFields = z.object({ name: text(200).min(2), contact: text(500).nullable(), contract_start: isoDate.nullable(), contract_end: isoDate.nullable(), responsibilities: text(4000).nullable(), required_evidence: text(4000).nullable(), escalation: text(2000).nullable() }).partial();
estates.post('/agents', async (req, res) => {
  const b = parse(agentFields.extend({ company_id: uuid, name: text(200).min(2) }), req.body);
  need(req.access, 'agents.manage', b.company_id);
  res.status(201).json(await one(`insert into agents (company_id, name, contact, contract_start, contract_end, responsibilities, required_evidence, escalation) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [b.company_id, b.name, b.contact ?? null, b.contract_start ?? null, b.contract_end ?? null, b.responsibilities ?? null, b.required_evidence ?? null, b.escalation ?? null]));
});
estates.patch('/agents/:id', async (req, res) => {
  const { ag, manage } = await loadAgent(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(agentFields.strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  res.json(await one(`update agents set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [ag.id, ...keys.map((k) => (b as any)[k])]));
});
estates.post('/agents/:id/properties', async (req, res) => {
  const { ag, manage } = await loadAgent(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const { property_id, remove } = parse(z.object({ property_id: uuid, remove: z.boolean().optional() }), req.body);
  if (!(await one('select 1 from properties where id = $1 and company_id = $2', [property_id, ag.company_id]))) throw bad('Choose a property of this company.');
  await q(remove ? 'delete from agent_properties where agent_id = $1 and property_id = $2' : 'insert into agent_properties (agent_id, property_id) values ($1,$2) on conflict do nothing', [ag.id, property_id]);
  await audit(pool, req.person.id, ag.company_id, 'agent', ag.id, remove ? 'unlink_property' : 'link_property', { property_id });
  res.json({ ok: true });
});
// Agent users are external people with no company appointment: they can only use the agent portal.
estates.post('/agents/:id/users', async (req, res) => {
  const { ag, manage } = await loadAgent(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(z.object({ email: z.email(), full_name: text(120).min(2), expires_at: z.iso.datetime({ offset: true }).nullable().optional(), remove: z.boolean().optional() }), req.body);
  const out = await tx(async (db) => {
    let p = await one<{ id: string }>('select id from people where lower(email) = lower($1)', [b.email], db);
    if (b.remove) {
      if (p) await q('delete from agent_users where agent_id = $1 and person_id = $2', [ag.id, p.id], db);
      return { removed: true };
    }
    const isNew = !p;
    if (!p) {
      const ref = (await one<{ ref: string }>(`select 'AGT-' || lpad((count(*) + 1)::text, 4, '0') ref from people where staff_ref like 'AGT-%'`, [], db))!.ref;
      p = await one('insert into people (email, full_name, staff_ref, status) values ($1,$2,$3,$4) returning id', [b.email, b.full_name, ref, 'invited'], db);
    }
    await q('insert into agent_users (agent_id, person_id, granted_by, expires_at) values ($1,$2,$3,$4) on conflict (agent_id, person_id) do update set expires_at = excluded.expires_at', [ag.id, p!.id, req.person.id, b.expires_at ?? null], db);
    await audit(db, req.person.id, ag.company_id, 'agent', ag.id, 'grant_user', { person_id: p!.id, expires_at: b.expires_at ?? null });
    return { person_id: p!.id, link: isNew ? await issueAccessLink(db, p!.id, 'invite') : null };
  });
  if ('link' in out && out.link) return res.status(201).json({ person_id: out.person_id, invitation: await sendAccessEmail(b.email, out.link, 'invite'), invite_link: (process.env.APP_URL ?? 'http://localhost:5173') + out.link });
  res.status(201).json(out);
});
estates.post('/agents/:id/reviews', async (req, res) => {
  const { ag, manage } = await loadAgent(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(z.object({ period_start: isoDate, period_end: isoDate, scores: z.array(z.object({ criterion: text(300).min(2), score: z.coerce.number().int().min(1).max(5), evidence: text(2000).min(3, 'Give the evidence for each score') })).min(1).max(30), summary: text(4000).nullable().optional() }), req.body);
  if (b.period_end < b.period_start) throw bad('The period ends before it starts.');
  const r = await one('insert into agent_reviews (agent_id, period_start, period_end, scores, summary, reviewer_id) values ($1,$2,$3,$4,$5,$6) returning *', [ag.id, b.period_start, b.period_end, JSON.stringify(b.scores), b.summary ?? null, req.person.id]);
  await audit(pool, req.person.id, ag.company_id, 'agent_review', r.id, 'create', {});
  res.status(201).json(r);
});

// ── Agent portal: only the agent's own properties, repairs and safety schedules ──
estates.get('/agent-portal', async (req, res) => {
  const a = req.access;
  if (!a.agentIds.length) throw notFound();
  const props = await agentPropertyIds(a);
  res.json({
    agents: await q('select ag.id, ag.name, ag.responsibilities, ag.required_evidence, ag.escalation, c.name as company_name, c.code as company_code from agents ag join companies c on c.id = ag.company_id where ag.id = any($1::uuid[])', [a.agentIds]),
    properties: await q('select p.id, p.name, p.ref, p.address_line1, p.postcode, c.code as company_code from properties p join companies c on c.id = p.company_id where p.id = any($1::uuid[]) order by p.ref', [props]),
    repairs: await q(`select r.id, r.title, r.status, r.urgency, r.due_on, p.name as property_name, (r.agent_id = any($2::uuid[])) as assigned_to_you from repairs r join properties p on p.id = r.property_id
                       where r.property_id = any($1::uuid[]) and r.status not in ${DONE} order by r.due_on`, [props, a.agentIds]),
    safety: await q(`${SAFETY} and sr.property_id = any($1::uuid[]) order by next_due`, [props]),
  });
});
