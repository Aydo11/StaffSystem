// House mood ratings and property complaints, recorded from a visit or the property page.
import { z } from 'zod';
import { type Db, one, q } from './db.ts';
import { audit, bad, LONDON_TODAY, notify, text } from './http.ts';
import { ACTIVE_APPT } from './perm.ts';

export const ASPECTS = ['kitchen', 'bathroom', 'bedrooms', 'living_areas', 'garden', 'communal'] as const;
const stars = z.coerce.number().int().min(1).max(5).nullable().optional();
export const ratingBody = z.object({ ...Object.fromEntries(ASPECTS.map((k) => [k, stars])) as Record<(typeof ASPECTS)[number], typeof stars>, note: text(1000).nullable().optional() })
  .refine((r) => ASPECTS.some((k) => r[k] != null), 'Rate at least one part of the home.');
export const complaintBody = z.object({
  source: z.enum(['resident', 'neighbour', 'visitor', 'staff', 'other']),
  category: z.enum(['noise', 'cleanliness', 'repairs', 'behaviour', 'staff_conduct', 'safety', 'other']),
  summary: text(4000).min(10, 'Describe the complaint in a sentence or two'),
});
type Property = { id: string; company_id: string; name: string; manager_person_id: string | null };

export async function saveRating(db: Db, personId: string, p: Property, visitId: string | null, r: z.infer<typeof ratingBody>) {
  const vals = ASPECTS.map((k) => r[k] ?? null);
  return one(`insert into condition_ratings (company_id, property_id, visit_id, rated_by, ${ASPECTS.join(', ')}, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                on conflict (visit_id) do update set ${ASPECTS.map((k) => `${k} = excluded.${k}`).join(', ')}, note = excluded.note, created_at = now() returning id`,
    [p.company_id, p.id, visitId, personId, ...vals, r.note || null], db);
}

// Complaints managers for the company (Governance → Leads and accountability). The task goes to the lead with the fewest
// open complaints (then a deputy, then the property's manager); every other complaints manager is told about it too.
async function complaintsHandlers(db: Db, p: Property) {
  const rows = await q<{ id: string; role: string }>(`select g.person_id as id, g.role from governance_leads g
      join appointments a on a.person_id = g.person_id and a.company_id = g.company_id and ${ACTIVE_APPT('a')}
     where g.company_id = $1 and g.area = 'complaints_oversight' and g.to_date is null
     group by g.person_id, g.role
     order by g.role = 'deputy', (select count(*) from property_complaints c join tasks t on t.id = c.task_id where t.owner_id = g.person_id and t.status <> 'completed'), min(g.created_at)`, [p.company_id], db);
  return { owner: rows[0]?.id ?? p.manager_person_id, others: rows.slice(1).filter((r) => r.role === 'lead').map((r) => r.id) };
}

export async function logComplaint(db: Db, personId: string, p: Property, visitId: string | null, b: z.infer<typeof complaintBody>) {
  const { owner, others } = await complaintsHandlers(db, p);
  const label = b.category.replace('_', ' ');
  const t = await one(`insert into tasks (company_id, property_id, title, description, owner_id, created_by, due_on, priority) values ($1,$2,$3,$4,$5,$6, ${LONDON_TODAY} + 10, 'high') returning id`,
    [p.company_id, p.id, `Complaint (${label}) at ${p.name}`, `Logged by staff from a ${b.source}.\n\n${b.summary}\n\nInvestigate, respond and record what was done, then complete this task to resolve the complaint.`, owner, personId], db);
  const c = await one(`insert into property_complaints (company_id, property_id, visit_id, raised_by, source, category, summary, task_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [p.company_id, p.id, visitId, personId, b.source, b.category, b.summary, t!.id], db);
  if (owner && owner !== personId) await notify(db, owner, p.company_id, `New complaint at ${p.name} (${label})`, `/tasks/${t!.id}`);
  for (const o of others) if (o !== personId) await notify(db, o, p.company_id, `Complaint at ${p.name} (${label}) — assigned to a colleague`, `/properties/${p.id}`);
  await audit(db, personId, p.company_id, 'property_complaint', c!.id, 'log', { category: b.category, task_id: t!.id }); // no complaint text in the audit log
  return c;
}

export async function propertyOf(db: Db, id: string): Promise<Property> {
  const p = await one<Property>('select id, company_id, name, manager_person_id from properties where id = $1', [id], db);
  if (!p) throw bad('Unknown property.');
  return p;
}
export const conditionLists = (db: Db, propertyId: string) => Promise.all([
  one(`select pc.*, (select note from condition_ratings r where r.property_id = $1 and r.note is not null order by r.created_at desc limit 1) as latest_note,
              (select count(*)::int from condition_ratings r where r.property_id = $1 and r.created_at > now() - interval '12 months') as ratings_count
         from (select $1::uuid as property_id) x left join property_condition pc using (property_id)`, [propertyId], db),
  q(`select c.id, c.source, c.category, c.summary, c.created_at, c.task_id, t.status as task_status, t.completed_at, coalesce(o.preferred_name, o.full_name) as handler_name, coalesce(rb.preferred_name, rb.full_name) as raised_by_name
       from property_complaints c join people rb on rb.id = c.raised_by left join tasks t on t.id = c.task_id left join people o on o.id = t.owner_id
      where c.property_id = $1 order by (t.status = 'completed'), c.created_at desc limit 50`, [propertyId], db),
  q(`select id, title, urgency, status, due_on from repairs where property_id = $1 and status <> 'closed' order by case urgency when 'emergency' then 0 when 'urgent' then 1 else 2 end, created_at limit 20`, [propertyId], db),
  // Fixed repairs, with how long they took (reported → work done) and whether that was on time.
  q(`select id, title, urgency, created_at, completed_on, verified_at, due_on, (completed_on - (created_at at time zone 'Europe/London')::date) as days_to_fix, completed_on <= due_on as on_time
       from repairs where property_id = $1 and status = 'closed' order by verified_at desc limit 20`, [propertyId], db),
]);
