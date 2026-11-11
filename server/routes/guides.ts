// Staff guides, "How do I…?" (migration 049). Published guides are for everyone in the company (company_id null = all).
// guides.manage writes, publishes and sees drafts.
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q } from '../db.ts';
import { audit, forbidden, idParam, notFound, parse, text, uuid } from '../http.ts';
import { type Access, can, companiesWith, myCompanies } from '../perm.ts';

export const guides = Router();
const CATEGORIES = ['getting_started', 'visits_time', 'houses', 'repairs_complaints', 'training', 'emergencies', 'other'] as const;

const managesAny = (a: Access) => companiesWith(a, 'guides.manage').length > 0;
const canManage = (a: Access, companyId: string | null) => (companyId ? can(a, 'guides.manage', companyId) : managesAny(a));

guides.get('/guides', async (req, res) => {
  const a = req.access;
  const manage = managesAny(a);
  res.json({
    guides: await q(`select g.id, g.company_id, c.code as company_code, g.category, g.title, g.summary, g.status, g.updated_at, length(g.body) as length
                       from guides g left join companies c on c.id = g.company_id
                      where (g.company_id is null or g.company_id = any($1::uuid[])) and (g.status = 'published' or (g.company_id is null and $2) or g.company_id = any($3::uuid[]))
                      order by g.category, g.title`, [myCompanies(a), manage, companiesWith(a, 'guides.manage')]),
    can: { manage, companies: companiesWith(a, 'guides.manage') },
  });
});

/** Published guides this person may read, for Ask the Hub. */
export async function guidesFor(a: Access) {
  return q<{ title: string; body: string }>(`select title, body from guides where status = 'published' and (company_id is null or company_id = any($1::uuid[])) order by category, title`, [myCompanies(a)]);
}

async function load(a: Access, id: string) {
  const g = await one(`select g.*, c.code as company_code, coalesce(u.preferred_name, u.full_name) as updated_by_name
                         from guides g left join companies c on c.id = g.company_id left join people u on u.id = g.updated_by where g.id = $1`, [id]);
  if (!g || (g.company_id && !a.perms.has(g.company_id))) throw notFound();
  if (g.status !== 'published' && !canManage(a, g.company_id)) throw notFound();
  return g;
}
guides.get('/guides/:id', async (req, res) => {
  const g = await load(req.access, idParam(req.params.id));
  res.json({ ...g, can: { manage: canManage(req.access, g.company_id) } });
});

const body = z.object({
  company_id: uuid.nullable().optional(), category: z.enum(CATEGORIES), title: text(200).min(3),
  summary: text(300).nullable().optional(), body: text(20000).min(3), status: z.enum(['draft', 'published']),
});
guides.post('/guides', async (req, res) => {
  const a = req.access;
  const b = parse(body, req.body);
  if (!canManage(a, b.company_id ?? null)) throw forbidden();
  const g = await one(`insert into guides (company_id, category, title, summary, body, status, created_by, updated_by, published_at)
                       values ($1,$2,$3,$4,$5,$6,$7,$7, case when $6 = 'published' then now() end) returning id`,
    [b.company_id ?? null, b.category, b.title, b.summary || null, b.body, b.status, a.personId]);
  await audit(pool, a.personId, b.company_id ?? null, 'guide', g.id, 'create', { title: b.title, status: b.status });
  res.status(201).json(g);
});
guides.put('/guides/:id', async (req, res) => {
  const a = req.access;
  const g = await load(a, idParam(req.params.id));
  if (!canManage(a, g.company_id)) throw forbidden();
  const b = parse(body.omit({ company_id: true }), req.body);
  await q(`update guides set category = $2, title = $3, summary = $4, body = $5, status = $6, updated_by = $7, updated_at = now(),
                  published_at = case when $6 = 'published' then coalesce(published_at, now()) end where id = $1`,
    [g.id, b.category, b.title, b.summary || null, b.body, b.status, a.personId]);
  await audit(pool, a.personId, g.company_id, 'guide', g.id, 'update', { title: b.title, status: b.status });
  res.json({ ok: true });
});
guides.delete('/guides/:id', async (req, res) => {
  const a = req.access;
  const g = await load(a, idParam(req.params.id));
  if (!canManage(a, g.company_id)) throw forbidden();
  await q('delete from guides where id = $1', [g.id]);
  await audit(pool, a.personId, g.company_id, 'guide', g.id, 'delete', { title: g.title });
  res.json({ ok: true });
});
