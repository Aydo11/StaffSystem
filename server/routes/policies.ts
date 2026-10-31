import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, myCompanies } from '../perm.ts';
import { deleteFile, saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const policies = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// The version each person should read: per company, the highest version that company approved/adopted,
// limited to their audience (everyone, or their job title) unless they can see all policies.
const PUBLISHED = `
  select distinct on (p.root_id, pp.company_id) p.*, pp.company_id as pub_company_id, pp.approved_at, ${name('ap')} as approved_by_name,
         co.code as company_code, co.name as company_name
    from policies p join policy_publications pp on pp.policy_id = p.id join companies co on co.id = pp.company_id join people ap on ap.id = pp.approved_by
   where pp.company_id = any($1::uuid[]) and p.status <> 'retired'
     and (pp.company_id = any($3::uuid[]) or p.audience is null or exists (
          select 1 from appointments a where a.person_id = $2 and a.company_id = pp.company_id and lower(a.job_title) = lower(p.audience) and ${ACTIVE_APPT('a')}))
   order by p.root_id, pp.company_id, p.version desc`;

const canManage = (a: Access, companyId: string | null) => (companyId ? can(a, 'policies.manage', companyId) : companiesWith(a, 'policies.manage').length > 0);

policies.get('/policies', async (req, res) => {
  const a = req.access;
  const cs = myCompanies(a).filter((c) => !req.query.company || c === req.query.company);
  const published = await q(PUBLISHED, [cs, a.personId, companiesWith(a, 'policies.view_all')]);
  // "Supplied" is recorded the first time a published version is listed for someone who should read it.
  for (const p of published) {
    await q(`insert into policy_receipts (policy_id, company_id, person_id) select $1, $2, $3
             where exists (select 1 from appointments a where a.person_id = $3 and a.company_id = $2 and ${ACTIVE_APPT('a')})
             on conflict do nothing`, [p.id, p.pub_company_id, a.personId]);
  }
  const receipts = await q('select * from policy_receipts where person_id = $1', [a.personId]);
  const drafts = await q(`select p.*, co.code as company_code, co.name as company_name from policies p left join companies co on co.id = p.company_id
                           where p.status = 'draft' or (p.status = 'approved' and not exists (select 1 from policy_publications pp where pp.policy_id = p.id and pp.company_id = any($1::uuid[])))
                           order by p.title`, [companiesWith(a, 'policies.manage').concat(companiesWith(a, 'policies.approve'))]);
  res.json({
    published: published.map((p) => ({ ...p, chapters: undefined, chapter_titles: p.chapters.map((c: any) => c.title), receipt: receipts.find((r) => r.policy_id === p.id && r.company_id === p.pub_company_id) ?? null })),
    // Work in progress for people who draft or approve: drafts, and approved versions not yet adopted by one of their companies.
    pending: drafts.filter((p) => (p.company_id ? a.perms.has(p.company_id) : true) && (canManage(a, p.company_id) || companiesWith(a, 'policies.approve').some((c) => !p.company_id || c === p.company_id)))
      .map((p) => ({ ...p, chapters: undefined })),
  });
});

policies.get('/policies/search', async (req, res) => {
  const a = req.access;
  const term = parse(text(80).min(2, 'Type at least 2 characters'), req.query.q);
  const published = await q(PUBLISHED, [myCompanies(a), a.personId, companiesWith(a, 'policies.view_all')]);
  const hits: object[] = [];
  for (const p of published) {
    const chapters = p.chapters.map((c: any, i: number) => ({ ...c, index: i })).filter((c: any) => `${c.title} ${c.body}`.toLowerCase().includes(term.toLowerCase()));
    if (chapters.length || p.title.toLowerCase().includes(term.toLowerCase())) hits.push({ id: p.id, title: p.title, company_code: p.company_code, pub_company_id: p.pub_company_id, chapters: chapters.slice(0, 5).map((c: any) => ({ index: c.index, title: c.title, snippet: snippet(c.body, term) })) });
  }
  res.json(hits);
});
function snippet(body: string, term: string) {
  const i = body.toLowerCase().indexOf(term.toLowerCase());
  return i < 0 ? body.slice(0, 160) : `${i > 60 ? '…' : ''}${body.slice(Math.max(0, i - 60), i + 100)}…`;
}

async function loadPolicy(a: Access, id: string, companyId: string | null, db: Db = pool) {
  const p = await one('select p.*, co.code as company_code, co.name as company_name, ' + name('o') + ' as owner_name from policies p left join companies co on co.id = p.company_id left join people o on o.id = p.owner_id where p.id = $1', [id], db);
  if (!p) throw notFound();
  if (companyId) {
    const pub = (await q(PUBLISHED, [[companyId], a.personId, companiesWith(a, 'policies.view_all')], db)).find((x) => x.root_id === p.root_id);
    // Readers may open the current published version, or older published versions (history); managers see everything in their companies.
    const published = await one('select 1 from policy_publications where policy_id = $1 and company_id = $2', [id, companyId], db);
    if (published && (pub || can(a, 'policies.view_all', companyId))) return { p, reader: true };
  }
  const manage = canManage(a, p.company_id) || companiesWith(a, 'policies.approve').some((c) => !p.company_id || c === p.company_id);
  if (!manage || (p.company_id && !a.perms.has(p.company_id))) throw notFound();
  return { p, reader: false };
}

policies.get('/policies/:id', async (req, res) => {
  const a = req.access;
  const companyId = req.query.company ? parse(uuid, req.query.company) : null;
  const { p } = await loadPolicy(a, idParam(req.params.id), companyId);
  if (companyId) await q('update policy_receipts set opened_at = coalesce(opened_at, now()) where policy_id = $1 and company_id = $2 and person_id = $3', [p.id, companyId, a.personId]);
  const [versions, publications, file, translations, receipt] = await Promise.all([
    q(`select p.id, p.version, p.status, p.revision_summary, p.effective_on, (select json_agg(json_build_object('company_code', co.code, 'approved_at', pp.approved_at)) from policy_publications pp join companies co on co.id = pp.company_id where pp.policy_id = p.id) as publications
         from policies p where p.root_id = $1 order by p.version desc`, [p.root_id]),
    q(`select pp.*, co.code as company_code, co.name as company_name, ${name('ap')} as approved_by_name from policy_publications pp join companies co on co.id = pp.company_id join people ap on ap.id = pp.approved_by where pp.policy_id = $1`, [p.id]),
    p.file_id ? one('select id, original_name, mime_type, size_bytes from files where id = $1', [p.file_id]) : null,
    q(`select distinct on (root_id) id, title, language from policies where translation_of_root = $1 and status = 'approved' order by root_id, version desc`, [p.root_id]),
    companyId ? one('select * from policy_receipts where policy_id = $1 and company_id = $2 and person_id = $3', [p.id, companyId, a.personId]) : null,
  ]);
  const manage = canManage(a, p.company_id);
  const approveCos = companiesWith(a, 'policies.approve').filter((c) => (!p.company_id || c === p.company_id) && !publications.some((x) => x.company_id === c));
  res.json({ policy: p, versions, publications, file, translations, receipt, can: { edit: manage && p.status === 'draft', newVersion: manage && p.status === 'approved', approve: p.created_by !== a.personId ? approveCos : [], receipts: companyId ? can(a, 'policies.view_all', companyId) : false } });
});

policies.post('/policies', async (req, res) => {
  const b = parse(z.object({ company_id: uuid.nullable(), kind: z.enum(['policy', 'handbook']), title: text(200).min(3), language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en-GB'), translation_of_root: uuid.nullable().optional() }), req.body);
  if (!canManage(req.access, b.company_id)) throw forbidden();
  const id = randomUUID();
  const p = await one(`insert into policies (id, root_id, company_id, kind, title, language, translation_of_root, owner_id, created_by) values ($1,$1,$2,$3,$4,$5,$6,$7,$7) returning *`,
    [id, b.company_id, b.kind, b.title, b.language, b.translation_of_root ?? null, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'policy', id, 'create', { title: b.title });
  res.status(201).json(p);
});

const policyFields = z.object({
  title: text(200).min(3), owner_id: uuid.nullable(), audience: text(120).nullable(), revision_summary: text(2000).nullable(),
  effective_on: isoDate.nullable(), review_on: isoDate.nullable(),
  chapters: z.array(z.object({ title: text(200).min(1), body: text(50000) })).max(200),
}).partial();
policies.patch('/policies/:id', async (req, res) => {
  const { p } = await loadPolicy(req.access, idParam(req.params.id), null);
  if (!canManage(req.access, p.company_id) || p.status !== 'draft') throw forbidden('Only a draft can be edited. Approved versions are kept as they were published.');
  const b = parse(policyFields.strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  res.json(await one(`update policies set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
    [p.id, ...keys.map((k) => (k === 'chapters' ? JSON.stringify((b as any)[k]) : (b as any)[k]))]));
});
// A draft was never published, so nobody has been sent it or acknowledged it: it can be deleted. Approved versions stay as the record.
policies.delete('/policies/:id', async (req, res) => {
  await tx(async (db) => {
    const { p } = await loadPolicy(req.access, idParam(req.params.id), null, db);
    if (!canManage(req.access, p.company_id) || p.status !== 'draft') throw forbidden('Only a draft can be deleted. Approved versions are kept as the record.');
    await q('delete from policies where id = $1', [p.id], db);
    // A new version copies the source document of the one before, so the file goes only when nothing else uses it.
    if (p.file_id && !(await one('select 1 from policies where file_id = $1', [p.file_id], db))) await deleteFile(db, p.file_id);
    await audit(db, req.person.id, p.company_id, 'policy', p.id, 'delete_draft', { title: p.title, version: p.version });
  });
  res.status(204).end();
});

// Source documents stay attached to the draft; publication still requires independent approval.
policies.post('/policies/:id/file', upload.single('file'), async (req, res) => {
  const { p } = await loadPolicy(req.access, idParam(req.params.id), null);
  if (!canManage(req.access, p.company_id) || p.status !== 'draft') throw forbidden();
  if (!req.file) throw bad('Choose a PDF or Word (.docx) document.');
  const f = await tx(async (db) => {
    const saved = await saveFile(db, { companyId: p.company_id, entityType: 'policy', entityId: p.root_id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, allowWord: true });
    if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(saved.mime_type)) throw bad('Policies can only have a PDF or Word (.docx) document attached.');
    await q('update policies set file_id = $2, updated_at = now() where id = $1', [p.id, saved.id], db);
    await audit(db, req.person.id, p.company_id, 'policy', p.id, 'attach_source', { file_id: saved.id, mime_type: saved.mime_type });
    return saved;
  });
  res.status(201).json({ id: f.id });
});

// Approve (company document) or adopt (shared document) for one company. The author cannot approve their own draft.
policies.post('/policies/:id/approve', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, note: text(500).optional() }), req.body);
  const out = await tx(async (db) => {
    const { p } = await loadPolicy(req.access, idParam(req.params.id), null, db);
    if (!can(req.access, 'policies.approve', b.company_id)) throw forbidden();
    if (p.company_id && p.company_id !== b.company_id) throw bad('This document belongs to another company.');
    if (p.created_by === req.person.id) throw forbidden('Someone other than the author must review and approve it.');
    if (!p.chapters.length && !p.file_id) throw bad('Add content or attach a source document before approving.');
    if (!p.effective_on || !p.review_on) throw bad('Set the effective date and the review date.', { fields: { effective_on: p.effective_on ? undefined : 'Required', review_on: p.review_on ? undefined : 'Required' } });
    if (p.status === 'draft') await q(`update policies set status = 'approved', updated_at = now() where id = $1`, [p.id], db);
    await q('insert into policy_publications (policy_id, company_id, approved_by, note) values ($1,$2,$3,$4)', [p.id, b.company_id, req.person.id, b.note ?? null], db);
    const people = await q<{ person_id: string }>(`insert into policy_receipts (policy_id, company_id, person_id)
             select distinct $1::uuid, $2::uuid, a.person_id from appointments a where a.company_id = $2 and ${ACTIVE_APPT('a')} and ($3::text is null or lower(a.job_title) = lower($3))
             on conflict do nothing returning person_id`, [p.id, b.company_id, p.audience], db);
    for (const x of people) await notify(db, x.person_id, b.company_id, `${p.kind === 'handbook' ? 'Handbook' : 'Policy'} to read: ${p.title}`, `/policies/${p.id}?company=${b.company_id}`);
    await audit(db, req.person.id, b.company_id, 'policy', p.id, p.company_id ? 'approve' : 'adopt', { version: p.version, supplied_to: people.length });
    return { supplied: people.length };
  });
  res.json(out);
});
policies.post('/policies/:id/new-version', async (req, res) => {
  const { p } = await loadPolicy(req.access, idParam(req.params.id), null);
  if (!canManage(req.access, p.company_id) || p.status !== 'approved') throw forbidden();
  const draft = await one(`select id from policies where root_id = $1 and status = 'draft'`, [p.root_id]);
  if (draft) return res.json(draft);
  const v = (await one<{ v: number }>('select max(version) + 1 v from policies where root_id = $1', [p.root_id]))!.v;
  res.status(201).json(await one(`insert into policies (root_id, version, company_id, kind, title, language, translation_of_root, owner_id, audience, chapters, file_id, review_on, created_by)
                                  select root_id, $2, company_id, kind, title, language, translation_of_root, owner_id, audience, chapters, file_id, review_on, $3 from policies where id = $1 returning id`, [p.id, v, req.person.id]));
});

// Acknowledgement records that the person has read it; it is not contractual agreement.
policies.post('/policies/:id/acknowledge', async (req, res) => {
  const { company_id } = parse(z.object({ company_id: uuid }), req.body);
  const r = await one(`update policy_receipts set acknowledged_at = coalesce(acknowledged_at, now()), opened_at = coalesce(opened_at, now()) where policy_id = $1 and company_id = $2 and person_id = $3 returning *`,
    [idParam(req.params.id), company_id, req.person.id]);
  if (!r) throw notFound();
  res.json(r);
});
policies.post('/policies/:id/explained', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, person_id: uuid, note: text(1000).min(3) }), req.body);
  if (!can(req.access, 'policies.view_all', b.company_id)) throw forbidden();
  if (b.person_id === req.person.id) throw forbidden('Someone else must record that they explained it to you.');
  const r = await one(`update policy_receipts set explained_at = now(), explained_by = $4, explained_note = $5 where policy_id = $1 and company_id = $2 and person_id = $3 returning *`,
    [idParam(req.params.id), b.company_id, b.person_id, req.person.id, b.note]);
  if (!r) throw bad('This person has not been supplied with this version.');
  await audit(pool, req.person.id, b.company_id, 'policy_receipt', null, 'explained', { policy_id: req.params.id, person_id: b.person_id });
  res.json(r);
});
policies.get('/policies/:id/receipts', async (req, res) => {
  const company = parse(uuid, req.query.company);
  if (!can(req.access, 'policies.view_all', company)) throw forbidden();
  const p = await one('select * from policies where id = $1', [idParam(req.params.id)]);
  if (!p) throw notFound();
  // Everyone in the audience is listed, including people not yet supplied (for example, not signed in since publication).
  res.json(await q(`select a.person_id, ${name('pe')} as person_name, a.job_title, r.supplied_at, r.opened_at, r.acknowledged_at, r.explained_at, r.explained_note, ${name('ex')} as explained_by_name
                      from (select distinct on (person_id) person_id, job_title from appointments a where a.company_id = $2 and ${ACTIVE_APPT('a')} and ($3::text is null or lower(a.job_title) = lower($3))) a
                      join people pe on pe.id = a.person_id left join policy_receipts r on r.policy_id = $1 and r.company_id = $2 and r.person_id = a.person_id left join people ex on ex.id = r.explained_by
                     order by pe.full_name`, [p.id, company, p.audience]));
});
