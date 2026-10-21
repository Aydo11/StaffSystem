import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid, idParam } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith } from '../perm.ts';
import { deleteFile, readFile, saveFile } from '../storage.ts';
import { personVisible, taskVisible, visitVisible } from '../visibility.ts';
import { caseRoleForFile } from './cases.ts';
import { loadRepair } from './estates.ts';
import { canReadStory, upload } from './people.ts';

export const tasks = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const checklist = z.array(z.object({ text: text(200).min(1), done: z.boolean() })).max(30);

async function loadTask(a: Access, id: string) {
  const t = await one(`select t.* from tasks t where t.id = $1 and ${taskVisible('t', 2, 3)}`, [id, a.personId, companiesWith(a, 'tasks.view_all')]);
  if (!t) throw notFound();
  return t;
}

tasks.get('/tasks', async (req, res) => {
  const a = req.access;
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const property = req.query.property ? parse(uuid, req.query.property) : null;
  const mine = req.query.mine === 'true';
  res.json(await q(`
    select t.id, t.title, t.status, t.priority, t.due_on, t.recurrence, t.company_id, c.name as company_name, c.code as company_code, t.property_id, p.name as property_name,
           t.owner_id, ${name('o')} as owner_name, t.reviewer_id, ${name('r')} as reviewer_name, t.checklist, t.updated_at,
           (t.status <> 'completed' and t.due_on < ${LONDON_TODAY}) as overdue,
           (select count(*) from files f where f.entity_type = 'task' and f.entity_id = t.id)::int as file_count
      from tasks t join companies c on c.id = t.company_id left join properties p on p.id = t.property_id left join people o on o.id = t.owner_id left join people r on r.id = t.reviewer_id
     where ${taskVisible('t', 1, 2)} and ($3::uuid is null or t.company_id = $3) and ($4::uuid is null or t.property_id = $4) and (not $5 or t.owner_id = $1)
       and (t.status <> 'completed' or t.completed_at > now() - interval '30 days')
     order by t.status = 'completed', t.due_on nulls last, t.priority desc limit 500`, [a.personId, companiesWith(a, 'tasks.view_all'), company, property, mine]));
});

tasks.get('/tasks/:id', async (req, res) => {
  const a = req.access;
  const t = await loadTask(a, idParam(req.params.id));
  const [detail, comments, files] = await Promise.all([
    one(`select c.name as company_name, c.code as company_code, p.name as property_name, ${name('o')} as owner_name, ${name('r')} as reviewer_name, ${name('cr')} as created_by_name
           from tasks t join companies c on c.id = t.company_id left join properties p on p.id = t.property_id left join people o on o.id = t.owner_id left join people r on r.id = t.reviewer_id left join people cr on cr.id = t.created_by where t.id = $1`, [t.id]),
    q(`select tc.id, tc.body, tc.created_at, ${name('au')} as author_name, tc.author_id from task_comments tc join people au on au.id = tc.author_id where tc.task_id = $1 order by tc.created_at`, [t.id]),
    q(`select f.id, f.original_name, f.mime_type, f.size_bytes, f.uploaded_at, ${name('u')} as uploaded_by_name from files f join people u on u.id = f.uploaded_by where f.entity_type = 'task' and f.entity_id = $1 order by f.uploaded_at`, [t.id]),
  ]);
  const manage = can(a, 'tasks.manage', t.company_id);
  res.json({ task: { ...t, ...detail }, comments, files, can: { manage, review: (t.reviewer_id === a.personId || manage) && t.owner_id !== a.personId, work: t.owner_id === a.personId } });
});

const taskBody = z.object({
  title: text(200).min(3), description: text(4000).nullable().optional(), property_id: uuid.nullable().optional(),
  owner_id: uuid.nullable().optional(), reviewer_id: uuid.nullable().optional(), due_on: isoDate.nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']), checklist,
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']),
});
// Zod applies .default() even inside .partial(), so defaults live only on the create schema.
const taskCreate = taskBody.extend({ company_id: uuid, priority: taskBody.shape.priority.default('normal'), checklist: checklist.default([]), recurrence: taskBody.shape.recurrence.default('none') });

async function checkAssignees(companyId: string, ids: (string | null | undefined)[]) {
  for (const id of ids.filter(Boolean)) {
    const ok = await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [id, companyId]);
    if (!ok) throw bad('Owners and reviewers must have a current role in the task’s company.', { fields: { owner_id: 'Not in this company' } });
  }
}
async function checkProperty(companyId: string, propertyId: string | null | undefined) {
  if (!propertyId) return;
  const ok = await one('select 1 from properties p where p.id = $1 and (p.company_id = $2 or exists (select 1 from property_company_links l where l.property_id = p.id and l.company_id = $2))', [propertyId, companyId]);
  if (!ok) throw bad('That property is not part of this company.', { fields: { property_id: 'Wrong company' } });
}

tasks.post('/tasks', async (req, res) => {
  const b = parse(taskCreate, req.body);
  const a = req.access;
  if (!a.perms.has(b.company_id)) throw forbidden();
  // Staff may create tasks for themselves; assigning to others needs tasks.manage.
  if (!can(a, 'tasks.manage', b.company_id) && (b.owner_id ?? a.personId) !== a.personId) throw forbidden('You can only create tasks for yourself.');
  const owner = b.owner_id ?? a.personId;
  await checkAssignees(b.company_id, [owner, b.reviewer_id]);
  await checkProperty(b.company_id, b.property_id);
  const row = await one(`insert into tasks (company_id, property_id, title, description, owner_id, reviewer_id, created_by, due_on, priority, checklist, recurrence) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [b.company_id, b.property_id ?? null, b.title, b.description ?? null, owner, b.reviewer_id ?? null, a.personId, b.due_on ?? null, b.priority, JSON.stringify(b.checklist), b.recurrence]);
  await audit(pool, a.personId, b.company_id, 'task', row.id, 'create', { title: b.title });
  if (owner !== a.personId) await notify(pool, owner, b.company_id, `New task: ${b.title}`, `/tasks/${row.id}`);
  res.status(201).json(row);
});

const NEXT: Record<string, string> = { daily: '1 day', weekly: '7 days', monthly: '1 month' };

tasks.patch('/tasks/:id', async (req, res) => {
  const a = req.access;
  const t = await loadTask(a, idParam(req.params.id));
  const b = parse(taskBody.partial().extend({ status: z.enum(['not_started', 'in_progress', 'submitted', 'changes_requested', 'completed']).optional(), comment: text(2000).optional(), expected_updated_at: z.string().optional() }).strict(), req.body);
  const manage = can(a, 'tasks.manage', t.company_id);
  const isOwner = t.owner_id === a.personId;
  const isReviewer = (t.reviewer_id === a.personId || manage) && !isOwner;
  const ownerFields = ['status', 'checklist', 'comment', 'expected_updated_at'];
  if (!manage && Object.keys(b).some((k) => !ownerFields.includes(k))) throw forbidden('Only managers can change task details.');
  if (b.status && b.status !== t.status) {
    // Reopening would let a recurring task spawn its next copy twice.
    if (t.status === 'completed' && !manage) throw forbidden('Only a manager can reopen a completed task.');
    const ownerMoves = ['not_started', 'in_progress', 'submitted'];
    const reviewerMoves = ['changes_requested', 'completed'];
    if (ownerMoves.includes(b.status) && !isOwner && !manage) throw forbidden('Only the owner can move this task.');
    if (reviewerMoves.includes(b.status)) {
      // With a reviewer, completion is a review decision; without one, the owner completes their own task.
      const selfComplete = b.status === 'completed' && isOwner && !t.reviewer_id;
      if (!isReviewer && !selfComplete) throw forbidden('A reviewer must complete or return this task.');
      if (b.status === 'changes_requested' && !b.comment) throw bad('Say what needs to change.', { fields: { comment: 'Required' } });
    }
  }
  if (b.owner_id !== undefined || b.reviewer_id !== undefined) await checkAssignees(t.company_id, [b.owner_id, b.reviewer_id]);
  if (b.property_id !== undefined) await checkProperty(t.company_id, b.property_id);
  const row = await tx(async (db) => {
    const fields = Object.keys(b).filter((k) => !['comment', 'expected_updated_at'].includes(k));
    const vals = fields.map((k) => (k === 'checklist' ? JSON.stringify((b as any)[k]) : (b as any)[k]));
    // Optimistic concurrency: refuse to overwrite someone else's newer change.
    const r = await one(`update tasks set ${fields.map((k, i) => `${k} = $${i + 3}`).concat(['updated_at = now()', `completed_at = case when ${b.status === 'completed'} then now() when ${!!b.status} then null else completed_at end`]).join(', ')}
                         where id = $1 and ($2::text is null or date_trunc('milliseconds', updated_at) = $2::timestamptz) returning *`, [t.id, b.expected_updated_at ?? null, ...vals], db);
    if (!r) throw conflict('Someone else changed this task while you were editing. Reload to see their changes.');
    if (b.comment) await q('insert into task_comments (task_id, author_id, body) values ($1,$2,$3)', [t.id, a.personId, b.comment], db);
    if (b.status === 'completed' && t.status !== 'completed' && t.recurrence !== 'none' && t.due_on) {
      await q(`insert into tasks (company_id, property_id, title, description, owner_id, reviewer_id, created_by, due_on, priority, checklist, recurrence)
               select company_id, property_id, title, description, owner_id, reviewer_id, created_by, (due_on + interval '${NEXT[t.recurrence]}')::date, priority,
                      (select coalesce(jsonb_agg(jsonb_set(x, '{done}', 'false')), '[]') from jsonb_array_elements(checklist) x), recurrence from tasks where id = $1`, [t.id], db);
    }
    await audit(db, a.personId, t.company_id, 'task', t.id, 'update', { fields, from_status: t.status, to_status: b.status ?? t.status });
    const notifyId = b.status === 'submitted' ? t.reviewer_id : ['changes_requested', 'completed'].includes(b.status ?? '') ? t.owner_id : null;
    if (notifyId && notifyId !== a.personId) await notify(db, notifyId, t.company_id, `Task ${b.status!.replace('_', ' ')}: ${t.title}`, `/tasks/${t.id}`, b.comment);
    return r;
  });
  res.json(row);
});

tasks.post('/tasks/:id/comments', async (req, res) => {
  const t = await loadTask(req.access, idParam(req.params.id));
  const { body } = parse(z.object({ body: text(2000).min(1) }), req.body);
  res.status(201).json(await one('insert into task_comments (task_id, author_id, body) values ($1,$2,$3) returning *', [t.id, req.person.id, body]));
});

tasks.post('/tasks/:id/files', upload.single('file'), async (req, res) => {
  const t = await loadTask(req.access, idParam(req.params.id));
  if (t.owner_id !== req.person.id && !can(req.access, 'tasks.manage', t.company_id)) throw forbidden();
  if (!req.file) throw bad('Choose a file to upload.');
  const f = await tx(async (db) => {
    const saved = await saveFile(db, { companyId: t.company_id, entityType: 'task', entityId: t.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id });
    await audit(db, req.person.id, t.company_id, 'file', saved.id, 'upload', { task_id: t.id });
    return saved;
  });
  res.status(201).json({ ...f, storage_path: undefined });
});

// Protected download: the file's parent record decides who may read it.
tasks.get('/files/:id', async (req, res) => {
  const a = req.access;
  const f = await one('select * from files where id = $1', [idParam(req.params.id)]);
  if (!f) throw notFound();
  if (f.entity_type === 'task') await loadTask(a, f.entity_id);
  else if (f.entity_type === 'visit') {
    const v = await one(`select 1 from visits v where v.id = $1 and ${visitVisible('v', 2, 3)}`, [f.entity_id, a.personId, companiesWith(a, 'visits.view_all')]);
    if (!v) throw notFound();
  } else if (f.entity_type === 'course') {
    // Course images: visible to anyone who can see a course of that root (shared courses: everyone).
    const c = await one(`select 1 from courses where root_id = $1 and (company_id is null or company_id = any($2::uuid[]))`, [f.entity_id, [...a.perms.keys()]]);
    if (!c) throw notFound();
  } else if (f.entity_type === 'policy') {
    const pol = await one(`select company_id from policies where root_id = $1 limit 1`, [f.entity_id]);
    const pub = await one(`select 1 from policies p join policy_publications pp on pp.policy_id = p.id where p.root_id = $1 and pp.company_id = any($2::uuid[])`, [f.entity_id, [...a.perms.keys()]]);
    const drafting = pol && (pol.company_id ? can(a, 'policies.manage', pol.company_id) || can(a, 'policies.approve', pol.company_id) : companiesWith(a, 'policies.manage').length + companiesWith(a, 'policies.approve').length > 0);
    if (!pol || (!pub && !drafting)) throw notFound();
  } else if (f.entity_type === 'training_record') {
    const r = await one('select person_id from training_records where id = $1', [f.entity_id]);
    const cos = r ? (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [r.person_id])).map((x) => x.company_id) : [];
    if (!r || (r.person_id !== a.personId && !cos.some((c) => can(a, 'training.manage', c)))) throw notFound();
  } else if (f.entity_type === 'case') {
    if (!(await caseRoleForFile(a, f.entity_id))) throw notFound();
  } else if (f.entity_type === 'repair') {
    await loadRepair(a, f.entity_id);
  } else if (f.entity_type === 'safety_check') {
    const sc = await one('select sr.property_id, sr.company_id from safety_checks sc join safety_requirements sr on sr.id = sc.requirement_id where sc.id = $1', [f.entity_id]);
    const agentOk = sc && (await one('select 1 from agent_properties where property_id = $1 and agent_id = any($2::uuid[])', [sc.property_id, a.agentIds]));
    if (!sc || !(agentOk || can(a, 'safety.manage', sc.company_id) || can(a, 'governance.view', sc.company_id) || can(a, 'properties.view', sc.company_id))) throw notFound();
  } else if (['action', 'audit', 'agent'].includes(f.entity_type)) {
    if (!can(a, 'governance.view', f.company_id) && !can(a, 'agents.manage', f.company_id) && !(f.entity_type === 'action' && (await one('select 1 from improvement_actions where id = $1 and owner_id = $2', [f.entity_id, a.personId])))) throw notFound();
  } else if (f.entity_type === 'meeting') {
    const m = await one('select company_ids from meetings where id = $1', [f.entity_id]);
    if (!m || !m.company_ids.some((c: string) => can(a, 'governance.view', c))) throw notFound();
  } else if (f.entity_type === 'message') {
    if (!(await one('select 1 from conversation_members where conversation_id = $1 and person_id = $2 and left_at is null', [f.entity_id, a.personId]))) throw notFound();
  } else if (f.entity_type === 'news') {
    const n = await one('select company_ids, status from news_posts where id = $1', [f.entity_id]);
    if (!n || !n.company_ids.some((c: string) => a.perms.has(c))) throw notFound();
  } else if (f.entity_type === 'finance') {
    const d = await one('select company_id, submitted_by, recipient_person_id, kind from finance_documents where id = $1', [f.entity_id]);
    if (!d || !(can(a, 'finance.view', d.company_id) || d.submitted_by === a.personId || d.recipient_person_id === a.personId || (d.kind === 'expense_claim' && can(a, 'expenses.approve', d.company_id)))) throw notFound();
  } else if (f.entity_type === 'story') {
    // A story photo is readable by whoever may read that person's story.
    const st = await one('select p.id, p.story_visibility from story_chapters sc join people p on p.id = sc.person_id where sc.id = $1', [f.entity_id]);
    if (!st || !(await one(`select 1 from people p where p.id = $1 and ${personVisible('p', 2, 3)}`, [st.id, a.personId, companiesWith(a, 'staff.view')])) || !(await canReadStory(a, st.id, st.story_visibility))) throw notFound();
  } else if (f.entity_type === 'person_doc') {
    // Staff documents: the person themself, or someone who can edit their profile in a company they work for.
    const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [f.entity_id])).map((x) => x.company_id);
    if (f.entity_id !== a.personId && !cos.some((c) => can(a, 'staff.edit', c))) throw notFound();
  } else throw notFound(); // photos have their own endpoints
  await audit(pool, a.personId, f.company_id, 'file', f.id, 'download', {});
  res.set({ 'Content-Type': f.mime_type, 'Content-Disposition': `attachment; filename="${f.original_name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
    .send(await readFile(f.storage_path));
});
tasks.delete('/files/:id', async (req, res) => {
  const f = await one('select * from files where id = $1', [idParam(req.params.id)]);
  if (!f || f.entity_type !== 'task') throw notFound();
  const t = await loadTask(req.access, f.entity_id);
  if (f.uploaded_by !== req.person.id && !can(req.access, 'tasks.manage', t.company_id)) throw forbidden();
  if (t.status === 'completed') throw conflict('Evidence on a completed task is kept as part of the record.');
  const path = await tx(async (db) => { const p = await deleteFile(db, f.id); await audit(db, req.person.id, t.company_id, 'file', f.id, 'delete', { task_id: t.id, name: f.original_name }); return p; });
  res.json({ ok: true });
});

// ── Daily handover (operational only; sensitive employee concerns do not belong here) ──
tasks.get('/handover', async (req, res) => {
  const date = req.query.date ? parse(isoDate, req.query.date) : null;
  const cs = [...req.access.perms.keys()].filter((c) => !req.query.company || c === req.query.company);
  res.json(await q(`select h.*, c.name as company_name, c.code as company_code, p.name as property_name, ${name('a')} as author_name
                      from handover_notes h join companies c on c.id = h.company_id left join properties p on p.id = h.property_id join people a on a.id = h.author_id
                     where h.company_id = any($1::uuid[]) and h.for_date = coalesce($2::date, ${LONDON_TODAY}) order by h.created_at desc`, [cs, date]));
});
tasks.post('/handover', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, property_id: uuid.nullable().optional(), for_date: isoDate, body: text(2000).min(3) }), req.body);
  if (!req.access.perms.has(b.company_id)) throw forbidden();
  await checkProperty(b.company_id, b.property_id);
  const row = await one('insert into handover_notes (company_id, property_id, author_id, for_date, body) values ($1,$2,$3,$4,$5) returning *', [b.company_id, b.property_id ?? null, req.person.id, b.for_date, b.body]);
  res.status(201).json(row);
});
