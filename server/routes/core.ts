import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DEV_AUTH, devUsers, signDevToken } from '../auth.ts';
import { one, pool, q } from '../db.ts';
import { HttpError, LONDON_TODAY, notFound, parse, text, uuid, audit, idParam } from '../http.ts';
import { ACTIVE_APPT, companiesWith, myCompanies, need } from '../perm.ts';
import { personVisible, propertyVisible, taskVisible } from '../visibility.ts';
import { inboxFor } from './inbox.ts';
import { unreadMessages } from './messaging.ts';

// ── Public (no sign-in) ──
export const publicRoutes = Router();

publicRoutes.get('/auth/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    devAuth: DEV_AUTH,
    helpContact: process.env.HELP_CONTACT || null,
  });
});

if (DEV_AUTH) {
  const devLimit = rateLimit({ windowMs: 60_000, limit: 30 });
  publicRoutes.get('/dev/users', async (_req, res) => res.json(await devUsers()));
  publicRoutes.post('/dev/login', devLimit, async (req, res) => {
    const { email } = parse(z.object({ email: z.email() }), req.body);
    const p = await one<{ id: string; email: string }>(`select id, email from people where lower(email) = lower($1) and is_fictional and status <> 'left'`, [email]);
    if (!p) throw new HttpError(401, 'unauthenticated', 'That demo account does not exist.');
    res.json({ token: await signDevToken(p) });
  });
}

// ── Signed in ──
export const core = Router();

core.get('/me', async (req, res) => {
  const a = req.access;
  const companies = await q(`select id, code, name, legal_name, details_verified, logo_path, brand_primary, brand_accent, support_system_url, help_contact, clearance_rule
                               from companies where id = any($1::uuid[]) order by name`, [myCompanies(a)]);
  const appointments = await q(`select a.id, a.company_id, a.job_title, a.relationship, a.status, a.start_date, a.end_date, a.contracted_hours_per_week, c.name as company_name, c.code as company_code
                                  from appointments a join companies c on c.id = a.company_id
                                 where a.person_id = $1 order by (${ACTIVE_APPT('a')}) desc, a.start_date desc`, [a.personId]);
  const activeVisit = await one(`select v.id, v.started_at, v.expected_end_at, v.company_id, v.property_id, p.name as property_name, c.name as company_name, c.code as company_code
                                   from visits v join properties p on p.id = v.property_id join companies c on c.id = v.company_id
                                  where v.person_id = $1 and v.status = 'in_progress'`, [a.personId]);
  const unread = (await one<{ n: number }>('select count(*) n from notifications where person_id = $1 and read_at is null', [a.personId]))!.n;
  res.json({
    person: req.person,
    mfaRequired: req.mfaRequired,
    superAdmin: a.superAdmin,
    companies: companies.map((c) => ({ ...c, roles: [...(a.roles.get(c.id) ?? [])], perms: [...(a.perms.get(c.id) ?? [])] })),
    appointments,
    activeVisit: activeVisit ?? null,
    unread,
    unreadMessages: await unreadMessages(a.personId),
    agents: a.agentIds.length ? await q('select ag.id, ag.name, c.name as company_name, c.code as company_code from agents ag join companies c on c.id = ag.company_id where ag.id = any($1::uuid[])', [a.agentIds]) : [],
  });
});

core.get('/companies/:id', async (req, res) => {
  const id = idParam(req.params.id);
  if (!req.access.perms.has(id)) throw notFound();
  res.json(await one('select * from companies where id = $1', [id]));
});

const companyPatch = z.object({
  legal_name: text(200).optional(),
  company_number: text(20).nullable().optional(),
  registered_address: text(300).nullable().optional(),
  details_verified: z.boolean().optional(),
  brand_primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  brand_accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  support_system_url: z.url({ protocol: /^https$/ }).nullable().optional(),
  help_contact: text(200).nullable().optional(),
  clearance_rule: z.enum(['warn', 'block']).optional(),
}).strict();

core.patch('/companies/:id', async (req, res) => {
  const id = idParam(req.params.id);
  need(req.access, 'company.manage', id);
  const body = parse(companyPatch, req.body);
  const keys = Object.keys(body);
  if (!keys.length) return res.json(await one('select * from companies where id = $1', [id]));
  const before = await one('select * from companies where id = $1', [id]);
  const row = await one(`update companies set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [id, ...keys.map((k) => (body as any)[k])]);
  await audit(pool, req.person.id, id, 'company', id, 'update', { before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: body });
  res.json(row);
});

core.get('/search', async (req, res) => {
  const term = parse(text(80).min(2, 'Type at least 2 characters'), req.query.q);
  const like = `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const a = req.access;
  const [people, properties, tasks] = await Promise.all([
    q(`select p.id, coalesce(p.preferred_name, p.full_name) as label, p.staff_ref as sub from people p
        where ${personVisible('p', 1, 2)} and (p.full_name ilike $3 or p.preferred_name ilike $3 or p.staff_ref ilike $3) order by p.full_name limit 8`,
      [a.personId, companiesWith(a, 'staff.view'), like]),
    q(`select p.id, p.name as label, p.ref || ' · ' || c.name as sub from properties p join companies c on c.id = p.company_id
        where ${propertyVisible('p', 1, 2)} and (p.name ilike $3 or p.ref ilike $3 or p.address_line1 ilike $3 or p.postcode ilike $3) order by p.name limit 8`,
      [a.personId, companiesWith(a, 'properties.view'), like]),
    q(`select t.id, t.title as label, c.name as sub from tasks t join companies c on c.id = t.company_id
        where ${taskVisible('t', 1, 2)} and t.title ilike $3 order by t.due_on nulls last limit 8`,
      [a.personId, companiesWith(a, 'tasks.view_all'), like]),
  ]);
  res.json({ people, properties, tasks });
});

core.get('/notifications', async (req, res) => {
  res.json(await q('select n.*, c.name as company_name from notifications n left join companies c on c.id = n.company_id where n.person_id = $1 order by n.created_at desc limit 50', [req.person.id]));
});
core.post('/notifications/read', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(uuid).max(200).optional() }), req.body);
  await q(`update notifications set read_at = now() where person_id = $1 and read_at is null ${ids ? 'and id = any($2::uuid[])' : ''}`, ids ? [req.person.id, ids] : [req.person.id]);
  res.json({ ok: true });
});

core.get('/my-day', async (req, res) => {
  const me = req.person.id;
  const cs = myCompanies(req.access);
  const [scheduled, tasks, handover, inbox] = await Promise.all([
    q(`select s.id, s.planned_start, s.planned_minutes, s.status, s.property_id, s.company_id, p.name as property_name, c.name as company_name, c.code as company_code,
              (s.status = 'scheduled' and s.planned_start + make_interval(mins => s.planned_minutes) < now()) as missed
         from scheduled_visits s join properties p on p.id = s.property_id join companies c on c.id = s.company_id
        where s.person_id = $1 and s.status = 'scheduled' and s.planned_start >= now() - interval '7 days' and s.planned_start < now() + interval '7 days'
        order by s.planned_start`, [me]),
    q(`select t.id, t.title, t.due_on, t.priority, t.status, t.company_id, c.name as company_name, c.code as company_code, p.name as property_name,
              (t.due_on < ${LONDON_TODAY}) as overdue
         from tasks t join companies c on c.id = t.company_id left join properties p on p.id = t.property_id
        where t.owner_id = $1 and t.status <> 'completed' order by t.due_on nulls last, t.priority desc limit 20`, [me]),
    q(`select h.id, h.body, h.for_date, h.company_id, c.name as company_name, c.code as company_code, p.name as property_name, coalesce(a.preferred_name, a.full_name) as author
         from handover_notes h join companies c on c.id = h.company_id left join properties p on p.id = h.property_id join people a on a.id = h.author_id
        where h.company_id = any($1::uuid[]) and h.for_date = ${LONDON_TODAY} order by h.created_at desc`, [cs]),
    inboxFor(req.access),
  ]);
  res.json({ scheduled, tasks, handover, inboxCount: inbox.length });
});
