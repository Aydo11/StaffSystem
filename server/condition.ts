// House mood ratings and property complaints, recorded from a visit or the property page.
import { z } from 'zod';
import { type Db, one, q } from './db.ts';
import { audit, bad, LONDON_TODAY, notify, text } from './http.ts';
import { ACTIVE_APPT } from './perm.ts';

export const ASPECTS = ['kitchen', 'bathroom', 'bedrooms', 'living_areas', 'garden', 'communal'] as const;
const stars = z.coerce.number().int().min(1).max(5).nullable().optional();
// channel: how findings or a complaint reached us when not logged on a visit (a visit always records 'visit').
export const ratingBody = z.object({ ...Object.fromEntries(ASPECTS.map((k) => [k, stars])) as Record<(typeof ASPECTS)[number], typeof stars>, note: text(1000).nullable().optional(), channel: z.enum(['phone', 'in_person', 'other']).optional() })
  .refine((r) => ASPECTS.some((k) => r[k] != null), 'Rate at least one part of the home.');
export const complaintBody = z.object({
  source: z.enum(['resident', 'neighbour', 'visitor', 'staff', 'family', 'professional', 'other']),
  category: z.enum(['noise', 'cleanliness', 'repairs', 'behaviour', 'staff_conduct', 'safety', 'service', 'communication', 'hr', 'other']),
  summary: text(4000).min(10, 'Describe the complaint in a sentence or two'),
  channel: z.enum(['phone', 'in_person', 'email', 'text', 'letter', 'other']).optional(),
});
export const CHANNEL_LABEL: Record<string, string> = { visit: 'on a visit', phone: 'by phone', in_person: 'in person', email: 'by email', text: 'by text message', letter: 'by letter', other: 'another way' };
type Property = { id: string; company_id: string; name: string; manager_person_id: string | null };

export async function saveRating(db: Db, personId: string, p: Property, visitId: string | null, r: z.infer<typeof ratingBody>) {
  const vals = ASPECTS.map((k) => r[k] ?? null);
  return one(`insert into condition_ratings (company_id, property_id, visit_id, rated_by, ${ASPECTS.join(', ')}, note, channel) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                on conflict (visit_id) do update set ${ASPECTS.map((k) => `${k} = excluded.${k}`).join(', ')}, note = excluded.note, created_at = now() returning id`,
    [p.company_id, p.id, visitId, personId, ...vals, r.note || null, visitId ? 'visit' : r.channel ?? 'other'], db);
}

// Complaints managers for the company (Governance → Leads and accountability). The case goes to the lead with the fewest
// open complaints (then a deputy, then the property's manager); every other complaints manager is told about it too.
async function complaintsHandlers(db: Db, companyId: string, fallback: string | null) {
  const rows = await q<{ id: string; role: string }>(`select g.person_id as id, g.role from governance_leads g
      join appointments a on a.person_id = g.person_id and a.company_id = g.company_id and ${ACTIVE_APPT('a')}
     where g.company_id = $1 and g.area = 'complaints_oversight' and g.to_date is null
     group by g.person_id, g.role
     order by g.role = 'deputy', (select count(*) from property_complaints c where c.owner_id = g.person_id and c.stage not in ('resolved','closed')), min(g.created_at)`, [companyId], db);
  return { owner: rows[0]?.id ?? fallback, others: rows.slice(1).filter((r) => r.role === 'lead').map((r) => r.id) };
}

export const CATEGORY_LABEL: Record<string, string> = { noise: 'noise', cleanliness: 'cleanliness', repairs: 'repairs', behaviour: 'behaviour', staff_conduct: 'staff conduct', safety: 'safety', service: 'service', communication: 'communication', hr: 'HR', other: 'other' };
const DEPT: Record<string, string> = { repairs: 'repairs', staff_conduct: 'hr', hr: 'hr', cleanliness: 'property', safety: 'property' };
const TASK_PRIORITY: Record<string, string> = { low: 'low', medium: 'normal', high: 'high', urgent: 'urgent' };
export type NewComplaint = z.infer<typeof complaintBody> & { title?: string | null; department?: string; priority?: string; owner_id?: string | null; due_on?: string | null; confidential?: boolean; complainant_name?: string | null };

// One complaint case: its reference, the handler's task (generic wording when confidential, so task lists never show
// the detail), a timeline entry and notifications. Used by the visit form, the property page and the Complaints page.
export async function createComplaint(db: Db, personId: string, companyId: string, p: Property | null, visitId: string | null, b: NewComplaint) {
  const picked = await complaintsHandlers(db, companyId, p?.manager_person_id ?? null);
  const owner = b.owner_id ?? (b.confidential ? personId : picked.owner); // confidential cases stay with the authorised person logging them unless they choose someone
  const priority = b.priority ?? 'high';
  const label = CATEGORY_LABEL[b.category] ?? b.category;
  const c = (await one(`insert into property_complaints (company_id, property_id, visit_id, raised_by, source, category, summary, title, department, priority, owner_id, due_on, confidential, complainant_name, stage, channel)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::date, ${LONDON_TODAY} + 10),$13,$14,$15,$16) returning *`,
    [companyId, p?.id ?? null, visitId, personId, b.source, b.category, b.summary, b.title || null, b.department ?? DEPT[b.category] ?? 'support', priority, owner, b.due_on || null, !!b.confidential, b.complainant_name || null, owner ? 'assigned' : 'new', visitId ? 'visit' : b.channel ?? null], db))!;
  const how = c.channel ? ` ${CHANNEL_LABEL[c.channel]}` : '';
  const where = p ? ` at ${p.name}` : '';
  const title = c.confidential ? `Complaint ${c.ref} (confidential)` : `Complaint ${c.ref} (${label})${where}`;
  const desc = c.confidential ? `A confidential complaint. Open it in Complaints: /complaints/${c.id}` : `Logged by staff from a ${b.source}${how}.\n\n${b.summary}\n\nWork the case in Complaints (/complaints/${c.id}): record what was done, then resolve it.`;
  const t = await one(`insert into tasks (company_id, property_id, title, description, owner_id, created_by, due_on, priority) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [companyId, c.confidential ? null : p?.id ?? null, title, desc, owner, personId, c.due_on, TASK_PRIORITY[priority]], db);
  await q('update property_complaints set task_id = $2 where id = $1', [c.id, t!.id], db);
  await q(`insert into complaint_events (complaint_id, actor_id, kind, body, created_at) values ($1,$2,'created',$3, clock_timestamp())`, [c.id, personId, `Complaint logged${how ? ` (received${how})` : ''}.`], db);
  if (owner) await q(`insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at) values ($1,$2,'assigned',null,jsonb_build_object('to',$3::uuid), clock_timestamp())`, [c.id, personId, owner], db);
  const short = c.confidential ? `Complaint ${c.ref}` : `${c.ref}: ${label}${where}`;
  if (owner && owner !== personId) await notify(db, owner, companyId, `New complaint assigned to you — ${short}`, `/complaints/${c.id}`);
  if (!c.confidential) for (const o of picked.others) if (o !== personId && o !== owner) await notify(db, o, companyId, `New complaint — ${short}`, `/complaints/${c.id}`);
  await audit(db, personId, companyId, 'property_complaint', c.id, 'log', { category: b.category, task_id: t!.id, confidential: c.confidential }); // no complaint text in the audit log
  return { ...c, task_id: t!.id };
}
export const logComplaint = (db: Db, personId: string, p: Property, visitId: string | null, b: z.infer<typeof complaintBody>) => createComplaint(db, personId, p.company_id, p, visitId, b);

export async function propertyOf(db: Db, id: string): Promise<Property> {
  const p = await one<Property>('select id, company_id, name, manager_person_id from properties where id = $1', [id], db);
  if (!p) throw bad('Unknown property.');
  return p;
}
export const conditionLists = (db: Db, propertyId: string) => Promise.all([
  one(`select pc.*, (select note from condition_ratings r where r.property_id = $1 and r.note is not null order by r.created_at desc limit 1) as latest_note,
              (select count(*)::int from condition_ratings r where r.property_id = $1 and r.created_at > now() - interval '12 months') as ratings_count
         from (select $1::uuid as property_id) x left join property_condition pc using (property_id)`, [propertyId], db),
  q(`select c.id, c.ref, c.stage, c.source, c.channel, c.category, c.summary, c.created_at, c.task_id, case when c.stage in ('resolved','closed') then 'completed' else t.status end as task_status, coalesce(c.resolved_at, t.completed_at) as completed_at, coalesce(o.preferred_name, o.full_name) as handler_name, coalesce(rb.preferred_name, rb.full_name) as raised_by_name
       from property_complaints c join people rb on rb.id = c.raised_by left join tasks t on t.id = c.task_id left join people o on o.id = c.owner_id
      where c.property_id = $1 and not c.confidential order by (c.stage in ('resolved','closed')), c.created_at desc limit 50`, [propertyId], db),
  q(`select id, title, urgency, status, due_on from repairs where property_id = $1 and status not in ('verified','closed','cancelled') order by case urgency when 'emergency' then 0 when 'urgent' then 1 else 2 end, created_at limit 20`, [propertyId], db),
  // Fixed repairs, with how long they took (reported → work done) and whether that was on time.
  q(`select id, title, urgency, created_at, completed_on, verified_at, due_on, (completed_on - reported_on) as days_to_fix, completed_on <= due_on as on_time
       from repairs where property_id = $1 and status in ('verified','closed') order by verified_at desc limit 20`, [propertyId], db),
]);
