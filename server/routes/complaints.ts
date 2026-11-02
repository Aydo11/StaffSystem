// Complaints workspace: one register of complaint cases with stages, owners, deadlines, a timeline, follow-up actions,
// evidence and escalation. Confidential (HR) cases open only for complaints.confidential holders, the owner, people
// added to the case, and action owners; the person who logged a case sees its progress but not internal notes.
import { Router } from 'express';
import { z } from 'zod';
import { complaintBody, createComplaint, propertyOf } from '../condition.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, companiesWith } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const complaints = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
export const STAGES = ['new', 'under_review', 'assigned', 'in_progress', 'awaiting_information', 'resolved', 'closed'] as const;
const DONE = ['resolved', 'closed'];
const TASK_PRIORITY: Record<string, string> = { low: 'low', medium: 'normal', high: 'high', urgent: 'urgent' };

// Company lists for this person. Governance complaints leads/deputies work complaints whatever their job role.
async function rights(a: Access, db: Db = pool) {
  const leads = (await q<{ company_id: string }>(`select distinct company_id from governance_leads where person_id = $1 and area = 'complaints_oversight' and to_date is null`, [a.personId], db)).map((r) => r.company_id);
  return {
    view: [...new Set([...companiesWith(a, 'complaints.view'), ...leads])],
    manage: [...new Set([...companiesWith(a, 'complaints.manage'), ...leads])],
    conf: companiesWith(a, 'complaints.confidential'),
  };
}
type Rights = Awaited<ReturnType<typeof rights>>;
// $1 = me, $2 = view companies, $3 = confidential companies
const VISIBLE = `((not c.confidential and c.company_id = any($2::uuid[])) or (c.confidential and c.company_id = any($3::uuid[]))
  or c.owner_id = $1 or c.raised_by = $1 or exists (select 1 from complaint_access x where x.complaint_id = c.id and x.person_id = $1)
  or exists (select 1 from complaint_actions y where y.complaint_id = c.id and y.owner_id = $1))`;

// handler: works the case · team: owns a follow-up action · party: logged it, sees progress only
async function loadComplaint(a: Access, id: string, db: Db = pool) {
  const r = await rights(a, db);
  const c = await one(`select c.*, co.code as company_code, co.name as company_name, pr.name as property_name, pr.ref as property_ref,
                              ${name('o')} as owner_name, ${name('rb')} as raised_by_name
                         from property_complaints c join companies co on co.id = c.company_id left join properties pr on pr.id = c.property_id
                         left join people o on o.id = c.owner_id join people rb on rb.id = c.raised_by
                        where c.id = $4 and ${VISIBLE}`, [a.personId, r.view, r.conf, id], db);
  if (!c) throw notFound();
  const listed = await one('select 1 from complaint_access where complaint_id = $1 and person_id = $2', [c.id, a.personId], db);
  const handler = c.owner_id === a.personId || !!listed || (c.confidential ? r.conf : r.view).includes(c.company_id);
  const team = !handler && !!(await one('select 1 from complaint_actions where complaint_id = $1 and owner_id = $2', [c.id, a.personId], db));
  const role: 'handler' | 'team' | 'party' = handler ? 'handler' : team ? 'team' : 'party';
  const can = {
    manage: handler && (c.owner_id === a.personId || r.manage.includes(c.company_id) || r.conf.includes(c.company_id)),
    confidential: r.conf.includes(c.company_id),
    note: role !== 'party',
  };
  return { c, role, can, r };
}
export const complaintRoleForFile = async (a: Access, id: string) => { try { const { role } = await loadComplaint(a, id); return role === 'party' ? null : role; } catch { return null; } };

const event = (db: Db, id: string, actor: string | null, kind: string, body: string | null = null, meta: object = {}) =>
  q('insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at) values ($1,$2,$3,$4,$5, clock_timestamp())', [id, actor, kind, body, JSON.stringify(meta)], db);

// Senior staff for escalations: company administrators and super admins, plus complaints leads (not for confidential cases).
async function seniors(db: Db, companyId: string, confidential: boolean) {
  return (await q<{ id: string }>(`select distinct id from (
      select a.person_id id from appointments a join job_roles jr on jr.key = a.job_role_key where a.company_id = $1 and ${ACTIVE_APPT('a')} and jr.access_role_key = 'company_admin'
      union select g.person_id from role_grants g where g.role_key in ('company_admin','super_admin') and (g.company_id = $1 or g.company_id is null) and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
      union select g.person_id from governance_leads g where g.company_id = $1 and g.area = 'complaints_oversight' and g.role = 'lead' and g.to_date is null and not $2) s`, [companyId, confidential], db)).map((x) => x.id);
}
const short = (c: any) => (c.confidential ? `Complaint ${c.ref}` : `${c.ref}${c.title ? ` — ${c.title}` : ''}`);

complaints.get('/complaints', async (req, res) => {
  const a = req.access;
  const r = await rights(a);
  // shortcut: returns every visible case (filters, search and reports run in the browser); add server paging past a few thousand cases.
  const rows = await q(`select c.id, c.ref, c.title, c.summary, c.category, c.source, c.department, c.priority, c.stage, c.confidential, c.escalated, c.escalation_reason,
           c.company_id, co.code as company_code, c.property_id, pr.name as property_name, c.owner_id, ${name('o')} as owner_name, ${name('rb')} as raised_by_name,
           c.complainant_name, c.due_on, c.created_at, c.resolved_at, c.closed_at, c.updated_at,
           (c.stage not in ('resolved','closed') and c.due_on < ${LONDON_TODAY}) as overdue,
           (select count(*)::int from complaint_actions x where x.complaint_id = c.id and x.done_at is null) as open_actions,
           (select count(*)::int from complaint_actions x where x.complaint_id = c.id and x.done_at is null and x.due_on < ${LONDON_TODAY}) as overdue_actions,
           (select json_build_object('title', x.title, 'due_on', x.due_on) from complaint_actions x where x.complaint_id = c.id and x.done_at is null order by x.due_on nulls last limit 1) as next_action,
           (select max(e.created_at) from complaint_events e where e.complaint_id = c.id) as last_activity,
           not (${VISIBLE.replace('or c.raised_by = $1 ', '')}) as party_only
      from property_complaints c join companies co on co.id = c.company_id left join properties pr on pr.id = c.property_id
      left join people o on o.id = c.owner_id join people rb on rb.id = c.raised_by
     where ${VISIBLE} order by c.created_at desc limit 2000`, [a.personId, r.view, r.conf]);
  res.json({ cases: rows.map((c) => (c.party_only ? { ...c, escalation_reason: null } : c)), can: { view: r.view, manage: r.manage, confidential: r.conf } });
});

complaints.get('/complaints/:id', async (req, res) => {
  const { c, role, can } = await loadComplaint(req.access, idParam(req.params.id));
  const partyKinds = ['created', 'stage', 'assigned'];
  const events = await q(`select e.id, e.kind, e.body, e.meta, e.created_at, ${name('ac')} as actor_name,
           case when e.kind = 'assigned' then (select ${name('p')} from people p where p.id = (e.meta->>'to')::uuid) end as to_name,
           case when e.kind = 'assigned' and e.meta ? 'from' then (select ${name('p')} from people p where p.id = (e.meta->>'from')::uuid) end as from_name
      from complaint_events e left join people ac on ac.id = e.actor_id
     where e.complaint_id = $1 and ($2 or e.kind = any($3)) order by e.created_at, e.id`, [c.id, role !== 'party', partyKinds]);
  const actions = role === 'party' ? [] : await q(`select x.id, x.title, x.owner_id, ${name('o')} as owner_name, x.due_on, x.done_at, x.task_id, x.created_at,
           (x.done_at is null and x.due_on < ${LONDON_TODAY}) as overdue
      from complaint_actions x left join people o on o.id = x.owner_id where x.complaint_id = $1 order by x.done_at nulls first, x.due_on nulls last, x.created_at`, [c.id]);
  const files = role === 'party' ? [] : await q(`select f.id, f.original_name, f.uploaded_at, ${name('u')} as uploaded_by_name from files f left join people u on u.id = f.uploaded_by where f.entity_type = 'complaint' and f.entity_id = $1 order by f.uploaded_at`, [c.id]);
  const access = role === 'party' ? [] : await q(`select x.person_id, ${name('p')} as name, x.created_at from complaint_access x join people p on p.id = x.person_id where x.complaint_id = $1 order by x.created_at`, [c.id]);
  if (c.confidential && role !== 'party') await audit(pool, req.person.id, c.company_id, 'property_complaint', c.id, 'view', {}); // every read of a confidential case is recorded
  const visible = role === 'party' ? { ...c, escalation_reason: null, reminded_on: undefined } : { ...c, reminded_on: undefined };
  res.json({ case: visible, events, actions, files, access, role, can });
});

const createBody = complaintBody.extend({
  company_id: uuid, property_id: uuid.nullable().optional(), title: text(200).min(3, 'Give the complaint a short title').optional(),
  department: z.enum(['support', 'property', 'repairs', 'hr', 'management', 'finance', 'other']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), owner_id: uuid.nullable().optional(), due_on: isoDate.nullable().optional(),
  confidential: z.boolean().default(false), complainant_name: text(200).nullable().optional(),
});
complaints.post('/complaints', async (req, res) => {
  const a = req.access;
  const b = parse(createBody, req.body);
  const r = await rights(a);
  if (!r.view.includes(b.company_id) && !r.conf.includes(b.company_id)) throw forbidden('Log a complaint from the property page, or ask the complaints manager.');
  const c = await tx(async (db) => {
    const p = b.property_id ? await propertyOf(db, b.property_id) : null;
    if (p && p.company_id !== b.company_id && !(await one('select 1 from property_company_links where property_id = $1 and company_id = $2', [p.id, b.company_id], db))) throw bad('That property is not with this company.', { fields: { property_id: 'Not with this company' } });
    if (b.owner_id && !(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [b.owner_id, b.company_id], db))) throw bad('The owner must work for this company.', { fields: { owner_id: 'Not working for this company' } });
    return createComplaint(db, a.personId, b.company_id, p, null, b);
  });
  res.status(201).json(c);
});

const patchBody = z.object({
  stage: z.enum(STAGES), priority: z.enum(['low', 'medium', 'high', 'urgent']),
  department: z.enum(['support', 'property', 'repairs', 'hr', 'management', 'finance', 'other']),
  category: complaintBody.shape.category, owner_id: uuid.nullable(), due_on: isoDate.nullable(), title: text(200).nullable(),
  resolution: text(8000).nullable(), confidential: z.boolean(), escalated: z.boolean(), escalation_reason: text(2000).nullable(),
  complainant_name: text(200).nullable(), comment: text(2000),
}).partial().strict();
complaints.patch('/complaints/:id', async (req, res) => {
  const b = parse(patchBody, req.body);
  const out = await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    if (!can.manage) throw forbidden();
    if (b.confidential !== undefined && b.confidential !== c.confidential && !can.confidential) throw forbidden('Only staff authorised for confidential complaints can change this.');
    const me = req.person.id;
    const next = { ...c, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'comment')) };
    if (DONE.includes(next.stage) && !next.resolution?.trim()) throw bad('Record the resolution before resolving or closing the complaint.', { fields: { resolution: 'Say how the complaint was resolved' } });
    if (b.escalated && !(b.escalation_reason ?? c.escalation_reason)?.trim()) throw bad('Say why it needs senior attention.', { fields: { escalation_reason: 'Give a reason' } });
    if (b.owner_id && b.owner_id !== c.owner_id && !(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [b.owner_id, c.company_id], db))) throw bad('The owner must work for this company.', { fields: { owner_id: 'Not working for this company' } });

    const reopening = b.stage && DONE.includes(c.stage) && !DONE.includes(b.stage);
    await q(`update property_complaints set stage = $2, priority = $3, department = $4, category = $5, owner_id = $6, due_on = $7, title = $8, resolution = $9,
               confidential = $10, escalated = $11, escalation_reason = $12, complainant_name = $13, updated_at = now(), reminded_on = case when $7::date is distinct from due_on then null else reminded_on end,
               resolved_at = case when $2 in ('resolved','closed') then coalesce(resolved_at, now()) else null end,
               closed_at = case when $2 = 'closed' then coalesce(closed_at, now()) else null end
             where id = $1`,
      [c.id, next.stage, next.priority, next.department, next.category, next.owner_id, next.due_on, next.title, next.resolution, next.confidential, next.escalated, next.escalated ? next.escalation_reason : null, next.complainant_name], db);

    // Keep the handler's task in step: owner, deadline, priority, and done when the case is resolved or closed.
    if (c.task_id) {
      await q(`update tasks set owner_id = $2, due_on = $3, priority = $4, updated_at = now(),
                 status = case when $5 then 'completed' when $6 then 'in_progress' else status end,
                 completed_at = case when $5 then coalesce(completed_at, now()) when $6 then null else completed_at end,
                 title = case when $7 then $8 else title end, description = case when $7 then $9 else description end, property_id = case when $7 then null else property_id end
               where id = $1`,
        [c.task_id, next.owner_id, next.due_on, TASK_PRIORITY[next.priority], DONE.includes(next.stage), !!reopening, next.confidential && !c.confidential,
         `Complaint ${c.ref} (confidential)`, `A confidential complaint. Open it in Complaints: /complaints/${c.id}`], db);
    }

    if (b.stage && b.stage !== c.stage) await event(db, c.id, me, 'stage', b.comment || null, { from: c.stage, to: b.stage });
    else if (b.comment) await event(db, c.id, me, 'note', b.comment);
    if (b.owner_id !== undefined && b.owner_id !== c.owner_id) {
      await event(db, c.id, me, 'assigned', null, { from: c.owner_id, to: b.owner_id });
      if (b.owner_id && b.owner_id !== me) await notify(db, b.owner_id, c.company_id, `Complaint assigned to you — ${short(next)}`, `/complaints/${c.id}`);
    }
    if (b.escalated !== undefined && b.escalated !== c.escalated) {
      await event(db, c.id, me, b.escalated ? 'escalated' : 'deescalated', b.escalated ? next.escalation_reason : null);
      if (b.escalated) for (const s of await seniors(db, c.company_id, next.confidential)) if (s !== me) await notify(db, s, c.company_id, `Needs senior attention — ${short(next)}`, `/complaints/${c.id}`);
    }
    const changed = (['priority', 'department', 'category', 'due_on', 'title', 'resolution', 'confidential', 'complainant_name'] as const)
      .filter((k) => b[k] !== undefined && String(b[k] ?? '') !== String(k === 'due_on' && c.due_on ? isoDay(c.due_on) : c[k] ?? ''));
    if (changed.length) await event(db, c.id, me, 'updated', null, { fields: changed, changes: Object.fromEntries(changed.filter((k) => k !== 'resolution').map((k) => [k, { from: k === 'due_on' && c.due_on ? isoDay(c.due_on) : c[k], to: b[k] }])) });
    await audit(db, me, c.company_id, 'property_complaint', c.id, 'update', { fields: Object.keys(b).filter((k) => k !== 'comment') });
    return { id: c.id };
  });
  res.json(out);
});
const isoDay = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

complaints.post('/complaints/:id/events', async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['note', 'advice', 'recommendation']), body: text(8000).min(2, 'Write something first') }), req.body);
  await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    if (!can.note) throw forbidden();
    await event(db, c.id, req.person.id, b.kind, b.body);
    await q('update property_complaints set updated_at = now() where id = $1', [c.id], db);
    if (c.owner_id && c.owner_id !== req.person.id && b.kind !== 'note') await notify(db, c.owner_id, c.company_id, `New ${b.kind} on ${short(c)}`, `/complaints/${c.id}`);
  });
  res.status(201).json({ ok: true });
});

complaints.post('/complaints/:id/actions', async (req, res) => {
  const b = parse(z.object({ title: text(300).min(3, 'Describe the action'), owner_id: uuid, due_on: isoDate.nullable().optional() }), req.body);
  const row = await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    if (!can.manage) throw forbidden();
    if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [b.owner_id, c.company_id], db))) throw bad('Choose someone who works for this company.', { fields: { owner_id: 'Not working for this company' } });
    const t = await one(`insert into tasks (company_id, property_id, title, description, owner_id, created_by, due_on, priority) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [c.company_id, c.confidential ? null : c.property_id, c.confidential ? `Follow-up for complaint ${c.ref}` : `Complaint ${c.ref}: ${b.title}`,
       `A follow-up action on complaint ${c.ref}. Open it in Complaints: /complaints/${c.id}`, b.owner_id, req.person.id, b.due_on || null, TASK_PRIORITY[c.priority]], db);
    const x = await one('insert into complaint_actions (complaint_id, title, owner_id, due_on, task_id, created_by) values ($1,$2,$3,$4,$5,$6) returning *', [c.id, b.title, b.owner_id, b.due_on || null, t!.id, req.person.id], db);
    await event(db, c.id, req.person.id, 'action', b.title, { action_id: x!.id, owner_id: b.owner_id, due_on: b.due_on ?? null });
    if (b.owner_id !== req.person.id) await notify(db, b.owner_id, c.company_id, `Action for you on ${short(c)}`, `/complaints/${c.id}`);
    return x;
  });
  res.status(201).json(row);
});

complaints.post('/complaints/:id/actions/:aid/done', async (req, res) => {
  await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    const x = await one('select * from complaint_actions where id = $1 and complaint_id = $2', [idParam(req.params.aid), c.id], db);
    if (!x) throw notFound();
    if (!can.manage && x.owner_id !== req.person.id) throw forbidden();
    if (x.done_at) return;
    await q('update complaint_actions set done_at = now(), done_by = $2 where id = $1', [x.id, req.person.id], db);
    if (x.task_id) await q(`update tasks set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() where id = $1`, [x.task_id], db);
    await event(db, c.id, req.person.id, 'action_done', x.title, { action_id: x.id });
    if (c.owner_id && c.owner_id !== req.person.id) await notify(db, c.owner_id, c.company_id, `Action done on ${short(c)}`, `/complaints/${c.id}`);
  });
  res.json({ ok: true });
});

complaints.post('/complaints/:id/files', upload.single('file'), async (req, res) => {
  const { c, can } = await loadComplaint(req.access, idParam(req.params.id));
  if (!can.note) throw forbidden();
  if (!req.file) throw bad('Choose a file.');
  const f = await tx(async (db) => {
    const f = await saveFile(db, { companyId: c.company_id, entityType: 'complaint', entityId: c.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id });
    await event(db, c.id, req.person.id, 'evidence', f.original_name, { file_id: f.id });
    return f;
  });
  res.status(201).json({ id: f.id });
});

// People specifically authorised for a confidential case.
complaints.post('/complaints/:id/access', async (req, res) => {
  const b = parse(z.object({ person_id: uuid }), req.body);
  await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    if (!can.confidential) throw forbidden();
    if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [b.person_id, c.company_id], db))) throw bad('Choose someone who works for this company.');
    await q('insert into complaint_access (complaint_id, person_id, added_by) values ($1,$2,$3) on conflict do nothing', [c.id, b.person_id, req.person.id], db);
    await event(db, c.id, req.person.id, 'updated', null, { fields: ['access'], added: b.person_id });
    await notify(db, b.person_id, c.company_id, `You have been given access to complaint ${c.ref}`, `/complaints/${c.id}`);
    await audit(db, req.person.id, c.company_id, 'property_complaint', c.id, 'grant_access', { person_id: b.person_id });
  });
  res.status(201).json({ ok: true });
});
complaints.delete('/complaints/:id/access/:pid', async (req, res) => {
  await tx(async (db) => {
    const { c, can } = await loadComplaint(req.access, idParam(req.params.id), db);
    if (!can.confidential) throw forbidden();
    await q('delete from complaint_access where complaint_id = $1 and person_id = $2', [c.id, idParam(req.params.pid)], db);
    await audit(db, req.person.id, c.company_id, 'property_complaint', c.id, 'revoke_access', { person_id: req.params.pid });
  });
  res.json({ ok: true });
});

// Hourly: once a day per case, remind the owner two days before the deadline; when it passes, remind again and
// escalate to senior staff (once).
export async function complaintReminders(db: Db = pool) {
  const due = await q(`select c.* from property_complaints c where c.stage not in ('resolved','closed') and c.due_on is not null and c.due_on <= ${LONDON_TODAY} + 2
                         and (c.reminded_on is null or c.reminded_on < ${LONDON_TODAY})`, [], db);
  const today = (await one<{ d: string }>(`select ${LONDON_TODAY}::text d`, [], db))!.d;
  for (const c of due) {
    const overdue = isoDay(c.due_on) < today;
    await tx(async (t) => {
      await q(`update property_complaints set reminded_on = ${LONDON_TODAY} where id = $1`, [c.id], t);
      if (c.owner_id) await notify(t, c.owner_id, c.company_id, overdue ? `Overdue complaint — ${short(c)}` : `Complaint due ${isoDay(c.due_on)} — ${short(c)}`, `/complaints/${c.id}`);
      await event(t, c.id, null, 'reminder', overdue ? 'Past its deadline. Owner reminded.' : 'Deadline approaching. Owner reminded.');
      if (overdue && !c.escalated) {
        await q(`update property_complaints set escalated = true, escalation_reason = 'Past its deadline', updated_at = now() where id = $1`, [c.id], t);
        await event(t, c.id, null, 'escalated', 'Past its deadline');
        for (const s of await seniors(t, c.company_id, c.confidential)) if (s !== c.owner_id) await notify(t, s, c.company_id, `Overdue complaint needs senior attention — ${short(c)}`, `/complaints/${c.id}`);
      }
    });
  }
  return due.length;
}
