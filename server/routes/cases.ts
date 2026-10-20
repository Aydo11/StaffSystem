import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const cases = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const RAISED = ['grievance', 'bullying_harassment', 'whistleblowing', 'concern_about_manager'];
const PROCESS = ['development', 'capability', 'conduct'];

// Who sees a case: the person who raised it, the employee a process is about, the investigator, and cases.handle holders
// in that company — never anyone implicated, even if they hold HR rights.
function roleIn(a: Access, c: any): 'party' | 'handler' | null {
  if (c.implicated_ids.includes(a.personId)) return null;
  if (c.raised_by === a.personId || c.subject_person_id === a.personId) return 'party';
  if (c.investigator_id === a.personId || can(a, 'cases.handle', c.company_id)) return 'handler';
  return null;
}
async function loadCase(a: Access, id: string, db: Db = pool) {
  const c = await one(`select k.*, co.code as company_code, co.name as company_name, ${name('rb')} as raised_by_name, ${name('sp')} as subject_name, ${name('iv')} as investigator_name
                         from cases k join companies co on co.id = k.company_id left join people rb on rb.id = k.raised_by left join people sp on sp.id = k.subject_person_id left join people iv on iv.id = k.investigator_id where k.id = $1`, [id], db);
  const role = c && roleIn(a, c);
  if (!role) throw notFound();
  return { c, role };
}
async function handlers(db: Db, companyId: string, exclude: string[]) {
  return (await q<{ person_id: string }>(`select distinct g.person_id from role_grants g join role_permissions rp on rp.role_key = g.role_key
                                           where rp.permission_key = 'cases.handle' and (g.company_id = $1 or g.company_id is null) and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
                                             and not (g.person_id = any($2::uuid[]))`, [companyId, exclude], db)).map((r) => r.person_id);
}

cases.get('/cases', async (req, res) => {
  const a = req.access;
  const rows = await q(`select k.id, k.kind, k.status, k.created_at, k.company_id, k.raised_by, k.subject_person_id, k.investigator_id, k.implicated_ids, co.code as company_code, co.name as company_name, ${name('sp')} as subject_name
                          from cases k join companies co on co.id = k.company_id left join people sp on sp.id = k.subject_person_id
                         where (k.raised_by = $1 or k.subject_person_id = $1 or k.investigator_id = $1 or k.company_id = any($2::uuid[])) and not ($1 = any(k.implicated_ids))
                         order by k.created_at desc`, [a.personId, companiesWith(a, 'cases.handle')]);
  res.json(rows.map((c) => ({ ...c, implicated_ids: undefined, role: roleIn(a, c) })));
});

cases.get('/cases/:id', async (req, res) => {
  const { c, role } = await loadCase(req.access, idParam(req.params.id));
  const updates = await q(`select u.id, u.body, u.shared, u.created_at, ${name('au')} as author_name from case_updates u join people au on au.id = u.author_id
                            where u.case_id = $1 and ($2 or u.shared) order by u.created_at`, [c.id, role === 'handler']);
  const files = await q(`select id, original_name, uploaded_at from files where entity_type = 'case' and entity_id = $1`, [c.id]);
  if (role === 'handler') await audit(pool, req.person.id, c.company_id, 'case', c.id, 'view', {}); // every handler view of a confidential case is recorded
  const implicated = role === 'handler' || c.raised_by === req.person.id ? await q(`select id, ${name('p')} as name from people p where p.id = any($1::uuid[])`, [c.implicated_ids]) : [];
  res.json({ case: { ...c, implicated_ids: undefined }, implicated, updates, files, role });
});

cases.post('/cases', async (req, res) => {
  const a = req.access;
  const b = parse(z.object({ company_id: uuid, kind: z.enum(['grievance', 'bullying_harassment', 'whistleblowing', 'concern_about_manager', 'development', 'capability', 'conduct']),
    summary: text(8000).min(10, 'Please describe the concern in a little more detail'), implicated_ids: z.array(uuid).max(10).default([]), subject_person_id: uuid.optional(), procedure_ref: text(200).optional() }), req.body);
  if (!a.perms.has(b.company_id)) throw forbidden();
  const implicated = new Set(b.implicated_ids);
  if (RAISED.includes(b.kind)) {
    // A concern about your manager is automatically kept away from them.
    if (b.kind === 'concern_about_manager') {
      for (const r of await q<{ manager_person_id: string }>(`select manager_person_id from appointments a where a.person_id = $1 and a.company_id = $2 and a.manager_person_id is not null and ${ACTIVE_APPT('a')}`, [a.personId, b.company_id])) implicated.add(r.manager_person_id);
      if (!implicated.size) throw bad('Name the manager concerned, or choose another type of concern.', { fields: { implicated_ids: 'Required' } });
    }
    implicated.delete(a.personId);
  } else {
    if (!can(a, 'cases.handle', b.company_id)) throw forbidden();
    if (!b.subject_person_id || b.subject_person_id === a.personId) throw bad('Choose the employee this process is about.', { fields: { subject_person_id: 'Required' } });
    if (!(await one('select 1 from appointments where person_id = $1 and company_id = $2', [b.subject_person_id, b.company_id]))) throw bad('This person has no appointment in this company.');
  }
  const ids = [...implicated];
  const c = await tx(async (db) => {
    const row = await one(`insert into cases (company_id, kind, raised_by, subject_person_id, implicated_ids, summary, procedure_ref, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [b.company_id, b.kind, RAISED.includes(b.kind) ? a.personId : null, PROCESS.includes(b.kind) ? b.subject_person_id : null, ids, b.summary, b.procedure_ref ?? null, a.personId], db);
    for (const h of await handlers(db, b.company_id, [...ids, a.personId, b.subject_person_id ?? a.personId])) await notify(db, h, b.company_id, 'A confidential case needs acknowledging', `/concerns/${row.id}`);
    if (PROCESS.includes(b.kind)) await notify(db, b.subject_person_id!, b.company_id, `A ${b.kind} process has been opened with you`, `/concerns/${row.id}`);
    await audit(db, a.personId, b.company_id, 'case', row.id, 'open', { kind: b.kind }); // no summary text in the audit log
    return row;
  });
  res.status(201).json(c);
});

cases.patch('/cases/:id', async (req, res) => {
  const { c, role } = await loadCase(req.access, idParam(req.params.id));
  if (role !== 'handler') throw forbidden();
  const b = parse(z.object({ status: z.enum(['received', 'acknowledged', 'investigating', 'outcome_given', 'appeal', 'closed']), investigator_id: uuid.nullable(), outcome: text(8000).nullable(), outcome_on: isoDate.nullable(),
    appeal_outcome: text(8000).nullable(), procedure_ref: text(200).nullable(), add_implicated: z.array(uuid).max(10) }).partial().strict(), req.body);
  const imp = await one<{ implicated_ids: string[] }>('select implicated_ids from cases where id = $1', [c.id]);
  if (b.investigator_id && (imp!.implicated_ids.includes(b.investigator_id) || b.investigator_id === c.raised_by || b.investigator_id === c.subject_person_id)) throw bad('The investigator cannot be anyone involved in the case.', { fields: { investigator_id: 'Involved in the case' } });
  if (b.add_implicated?.includes(req.person.id)) throw bad('If you are involved, ask another handler to take over.');
  await tx(async (db) => {
    const { add_implicated, ...fields } = b;
    const keys = Object.keys(fields);
    if (keys.length) await q(`update cases set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, acknowledged_at = case when $${keys.length + 2} then coalesce(acknowledged_at, now()) else acknowledged_at end, updated_at = now() where id = $1`,
      [c.id, ...keys.map((k) => (fields as any)[k]), b.status === 'acknowledged'], db);
    if (add_implicated?.length) await q('update cases set implicated_ids = array(select distinct unnest(implicated_ids || $2::uuid[])) where id = $1', [c.id, add_implicated], db);
    await audit(db, req.person.id, c.company_id, 'case', c.id, 'update', { fields: Object.keys(b) });
    const party = c.raised_by ?? c.subject_person_id;
    if (b.status && party) await notify(db, party, c.company_id, `Your case is now: ${b.status.replace('_', ' ')}`, `/concerns/${c.id}`);
  });
  res.json({ ok: true });
});

cases.post('/cases/:id/updates', async (req, res) => {
  const { c, role } = await loadCase(req.access, idParam(req.params.id));
  const b = parse(z.object({ body: text(8000).min(2), shared: z.boolean().default(true) }), req.body);
  // The person who raised it, or the employee concerned, always writes shared updates.
  const shared = role === 'party' ? true : b.shared;
  await q('insert into case_updates (case_id, author_id, body, shared) values ($1,$2,$3,$4)', [c.id, req.person.id, b.body, shared]);
  res.status(201).json({ ok: true });
});
cases.post('/cases/:id/respond', async (req, res) => {
  const { c, role } = await loadCase(req.access, idParam(req.params.id));
  if (role !== 'party') throw forbidden();
  const b = parse(z.object({ employee_response: text(8000).optional(), appeal: text(8000).optional() }), req.body);
  if (b.appeal && c.status !== 'outcome_given') throw bad('You can appeal once an outcome has been given.');
  await q(`update cases set employee_response = coalesce($2, employee_response), appeal = coalesce($3, appeal), status = case when $3::text is not null then 'appeal' else status end, updated_at = now() where id = $1`,
    [c.id, b.employee_response ?? null, b.appeal ?? null]);
  if (b.appeal) for (const h of await handlers(pool, c.company_id, [c.raised_by, c.subject_person_id].filter(Boolean))) await notify(pool, h, c.company_id, 'An appeal has been lodged', `/concerns/${c.id}`);
  res.json({ ok: true });
});
cases.post('/cases/:id/files', upload.single('file'), async (req, res) => {
  const { c } = await loadCase(req.access, idParam(req.params.id));
  if (!req.file) throw bad('Choose a file.');
  const f = await tx((db) => saveFile(db, { companyId: c.company_id, entityType: 'case', entityId: c.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id }));
  res.status(201).json({ id: f.id });
});
export const caseRoleForFile = async (a: Access, caseId: string) => { try { return (await loadCase(a, caseId)).role; } catch { return null; } };

// ── Contract changes: proposal → communicated → approved (by someone else) → effective, with clear agreement status ──
cases.get('/contract-changes', async (req, res) => {
  const a = req.access;
  res.json(await q(`select cc.*, ap.job_title, ap.person_id, ${name('p')} as person_name, co.code as company_code, ${name('pb')} as proposed_by_name, ${name('ab')} as approved_by_name
                      from contract_changes cc join appointments ap on ap.id = cc.appointment_id join people p on p.id = ap.person_id join companies co on co.id = cc.company_id
                      join people pb on pb.id = cc.proposed_by left join people ab on ab.id = cc.approved_by
                     where cc.company_id = any($1::uuid[]) or (ap.person_id = $2 and cc.communicated_on is not null) order by cc.created_at desc`, [companiesWith(a, 'contracts.manage'), a.personId]));
});
cases.post('/contract-changes', async (req, res) => {
  const b = parse(z.object({ appointment_id: uuid, summary: text(500).min(5), details: text(8000).nullable().optional(), effective_on: isoDate.nullable().optional() }), req.body);
  const ap = await one('select * from appointments where id = $1', [b.appointment_id]);
  if (!ap || !req.access.perms.has(ap.company_id)) throw notFound();
  if (!can(req.access, 'contracts.manage', ap.company_id)) throw forbidden();
  if (ap.person_id === req.person.id) throw forbidden('You cannot propose changes to your own contract.');
  res.status(201).json(await one(`insert into contract_changes (appointment_id, company_id, summary, details, effective_on, proposed_by) values ($1,$2,$3,$4,$5,$6) returning *`,
    [ap.id, ap.company_id, b.summary, b.details ?? null, b.effective_on ?? null, req.person.id]));
});
cases.post('/contract-changes/:id/:step', async (req, res) => {
  const step = parse(z.enum(['communicate', 'approve', 'agreement']), req.params.step);
  const cc = await one('select cc.*, ap.person_id from contract_changes cc join appointments ap on ap.id = cc.appointment_id where cc.id = $1', [idParam(req.params.id)]);
  if (!cc) throw notFound();
  const a = req.access;
  if (step === 'communicate') {
    if (!can(a, 'contracts.manage', cc.company_id)) throw forbidden();
    const { communicated_on } = parse(z.object({ communicated_on: isoDate }), req.body);
    await q(`update contract_changes set communicated_on = $2, agreement = case when agreement = 'proposed' then 'communicated' else agreement end where id = $1`, [cc.id, communicated_on]);
    await notify(pool, cc.person_id, cc.company_id, `Proposed change to your contract: ${cc.summary}`, '/concerns?tab=contracts');
  } else if (step === 'approve') {
    if (!can(a, 'contracts.approve', cc.company_id)) throw forbidden();
    if (cc.proposed_by === a.personId || cc.person_id === a.personId) throw forbidden('Someone other than the proposer and the employee must approve.');
    await q('update contract_changes set approved_by = $2, approved_at = now() where id = $1', [cc.id, a.personId]);
  } else {
    const b = parse(z.object({ agreement: z.enum(['agreed', 'not_agreed', 'withdrawn']), employee_response: text(4000).optional() }), req.body);
    // The employee records agreement or disagreement themselves; only a manager can withdraw a proposal.
    if (b.agreement === 'withdrawn' ? !can(a, 'contracts.manage', cc.company_id) : cc.person_id !== a.personId) throw forbidden();
    if (b.agreement !== 'withdrawn' && !cc.communicated_on) throw bad('This change has not been communicated yet.');
    await q('update contract_changes set agreement = $2, employee_response = coalesce($3, employee_response) where id = $1', [cc.id, b.agreement, b.employee_response ?? null]);
  }
  await audit(pool, a.personId, cc.company_id, 'contract_change', cc.id, step, {});
  res.json({ ok: true });
});
