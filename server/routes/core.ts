import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, pool, q } from '../db.ts';
import { HttpError, isoDate, LONDON_TODAY, notFound, parse, text, uuid, audit, idParam } from '../http.ts';
import { ACTIVE_APPT, companiesWith, myCompanies, need } from '../perm.ts';
import { personVisible, propertyVisible, taskVisible } from '../visibility.ts';
import { inboxFor } from './inbox.ts';
import { unreadMessages } from './messaging.ts';

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

// Activity summaries intentionally exclude audit detail payloads, personal values and sensitive record titles.
// Staff can read their own actions; company-wide activity requires the existing audit.view permission.
core.get('/activity-log', async (req, res) => {
  const a = req.access;
  const from = parse(isoDate, req.query.from), to = parse(isoDate, req.query.to);
  if (to < from) throw new HttpError(400, 'invalid', 'The end date is before the start date.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new HttpError(400, 'invalid', 'Choose a period of up to one year.');
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const before = req.query.before ? parse(z.string().regex(/^\d+$/).max(20), req.query.before) : null;
  const mine = req.query.mine === 'true';
  const cs = companiesWith(a, 'audit.view');
  res.json(await q(`select l.id::text, l.at, l.entity, l.action, l.company_id, c.code as company_code,
          coalesce(w.preferred_name, w.full_name) as actor_name, p.name as property_name
       from audit_log l
       left join people w on w.id = l.actor_person_id
       left join companies c on c.id = l.company_id
       left join visits v on l.entity = 'visit' and v.id::text = l.entity_id::text
       left join properties p on (l.entity = 'property' and p.id::text = l.entity_id::text)
                              or (l.entity = 'visit' and p.id = v.property_id)
      where (l.actor_person_id = $1 or (not $2 and (l.company_id = any($3::uuid[]) or ($4 and l.company_id is null))))
        and ($5::uuid is null or l.company_id = $5)
        and l.at >= ($6::date::timestamp at time zone 'Europe/London')
        and l.at < (($7::date + 1)::timestamp at time zone 'Europe/London')
        and ($8::bigint is null or l.id < $8::bigint)
      order by l.id desc limit 200`,
    [a.personId, mine, cs, a.superAdmin, company, from, to, before]));
});

