import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, isoDate, localDateTime, notFound, parse, text, uuid, idParam } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need } from '../perm.ts';
import { deleteFile, readFile, saveFile } from '../storage.ts';
import { onLeave } from './leave.ts';
import { propertyVisible, taskVisible, visitVisible } from '../visibility.ts';
import { upload } from './people.ts';

export const properties = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// Appointments of the viewer that may be used to work at a property: allocated to it, or (for managers) any current
// appointment in the property's company or an authorised linked company.
const MY_APPTS = `
  coalesce((select json_agg(json_build_object('id', a.id, 'company_id', a.company_id, 'company_name', c2.name, 'company_code', c2.code, 'job_title', a.job_title) order by c2.name)
     from appointments a join companies c2 on c2.id = a.company_id
    where a.person_id = $1 and ${ACTIVE_APPT('a')}
      and (exists (select 1 from appointment_properties x where x.appointment_id = a.id and x.property_id = p.id and x.to_date is null)
           or (a.company_id = any($3::uuid[]) and (a.company_id = p.company_id or exists (select 1 from property_company_links l where l.property_id = p.id and l.company_id = a.company_id))))), '[]')`;

const MONTH = `date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London'`;

properties.get('/properties', async (req, res) => {
  const a = req.access;
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const mine = req.query.mine === 'true';
  const rows = await q(`
    select p.id, p.ref, p.name, p.address_line1, p.city, p.postcode, p.status, p.managing_agent, p.company_id, c.name as company_name, c.code as company_code,
           p.photo_path is not null as has_photo, ${name('m')} as manager_name,
           exists (select 1 from appointment_properties x join appointments ax on ax.id = x.appointment_id where x.property_id = p.id and x.to_date is null and ax.person_id = $1 and ${ACTIVE_APPT('ax')}) as allocated_to_me,
           ${MY_APPTS} as my_appointments,
           (select min(s.planned_start) from scheduled_visits s where s.property_id = p.id and s.status = 'scheduled' and s.planned_start > now()) as next_visit,
           (select max(v.started_at) from visits v where v.property_id = p.id and v.status in ('submitted','approved')) as last_visit,
           (select count(*) from tasks t where t.property_id = p.id and t.status <> 'completed' and ${taskVisible('t', 1, 4)}) as open_tasks,
           (select coalesce(sum(s.planned_minutes), 0) from scheduled_visits s where s.property_id = p.id and s.status <> 'cancelled' and s.planned_start >= ${MONTH}) as planned_minutes_month,
           (select coalesce(sum(extract(epoch from v.ended_at - v.started_at) / 60), 0)::int from visits v where v.property_id = p.id and v.status in ('submitted','approved') and v.started_at >= ${MONTH}) as recorded_minutes_month,
           (select coalesce(sum(va.minutes), 0) from visit_allocations va join visits v on v.id = va.visit_id where v.property_id = p.id and v.status = 'approved' and v.started_at >= ${MONTH}) as approved_minutes_month
      from properties p join companies c on c.id = p.company_id left join people m on m.id = p.manager_person_id
     where ${propertyVisible('p', 1, 2)} and ($5::uuid is null or p.company_id = $5) and p.status <> 'offboarded'
     order by allocated_to_me desc, p.ref`,
    [a.personId, companiesWith(a, 'properties.view'), companiesWith(a, 'visits.approve').concat(companiesWith(a, 'properties.manage')), companiesWith(a, 'tasks.view_all'), company]);
  res.json(mine ? rows.filter((r) => r.allocated_to_me) : rows);
});

async function visibleProperty(a: Access, id: string) {
  const p = await one(`select p.*, c.name as company_name, c.code as company_code from properties p join companies c on c.id = p.company_id where p.id = $1 and ${propertyVisible('p', 2, 3)}`, [id, a.personId, companiesWith(a, 'properties.view')]);
  if (!p) throw notFound();
  return p;
}

properties.get('/properties/:id', async (req, res) => {
  const a = req.access;
  const id = idParam(req.params.id);
  const p = await visibleProperty(a, id);
  const manage = can(a, 'properties.manage', p.company_id);
  const seeAlloc = manage || can(a, 'appointments.view', p.company_id);
  const [links, keys, allocations, tasks, visits, scheduled, mine] = await Promise.all([
    q('select l.*, c.name as company_name, c.code as company_code from property_company_links l join companies c on c.id = l.company_id where l.property_id = $1', [id]),
    can(a, 'properties.view', p.company_id) ? q(`select k.*, ${name('h')} as holder_name from property_keys k left join people h on h.id = k.holder_person_id where k.property_id = $1 order by k.label`, [id]) : [],
    seeAlloc ? q(`select x.id, x.from_date, x.to_date, ap.job_title, ap.company_id, c.code as company_code, ${name('pp')} as person_name, pp.id as person_id
                    from appointment_properties x join appointments ap on ap.id = x.appointment_id join people pp on pp.id = ap.person_id join companies c on c.id = ap.company_id
                   where x.property_id = $1 order by x.to_date is null desc, x.from_date desc`, [id]) : [],
    q(`select t.id, t.title, t.status, t.due_on, t.priority, ${name('o')} as owner_name from tasks t left join people o on o.id = t.owner_id where t.property_id = $1 and ${taskVisible('t', 2, 3)} order by t.status = 'completed', t.due_on nulls last limit 50`, [id, a.personId, companiesWith(a, 'tasks.view_all')]),
    q(`select v.id, v.started_at, v.ended_at, v.status, v.entry_mode, v.work_category, ${name('w')} as person_name, c.code as company_code from visits v join people w on w.id = v.person_id join companies c on c.id = v.company_id
        where v.property_id = $1 and ${visitVisible('v', 2, 3)} order by v.started_at desc limit 30`, [id, a.personId, companiesWith(a, 'visits.view_all')]),
    q(`select s.*, ${name('w')} as person_name, c.code as company_code from scheduled_visits s join people w on w.id = s.person_id join companies c on c.id = s.company_id
        where s.property_id = $1 and s.status = 'scheduled' and (s.person_id = $2 or s.company_id = any($3::uuid[])) order by s.planned_start limit 30`, [id, a.personId, companiesWith(a, 'visits.view_all')]),
    one(`select ${MY_APPTS} as my_appointments from properties p where p.id = $2`, [a.personId, id, companiesWith(a, 'visits.approve').concat(companiesWith(a, 'properties.manage'))]),
  ]);
  res.json({ property: { ...p, has_photo: !!p.photo_path, photo_path: undefined }, links, keys, allocations, tasks, visits, scheduled, my_appointments: mine?.my_appointments ?? [], can: { manage } });
});

const propBody = z.object({
  ref: text(20).min(2), name: text(120).min(2), address_line1: text(200).min(2), address_line2: text(200).nullable().optional(),
  city: text(80).min(2), postcode: text(10).min(3), status: z.enum(['active', 'void', 'under_works', 'offboarded']),
  managing_agent: text(200).nullable().optional(), manager_person_id: uuid.nullable().optional(),
  room_refs: z.array(text(30).regex(/^[\w .\-/]+$/, 'Room labels only — no names')).max(60).optional(),
  notes: text(1000).nullable().optional(),
});
const propCols = ['ref', 'name', 'address_line1', 'address_line2', 'city', 'postcode', 'status', 'managing_agent', 'manager_person_id', 'room_refs', 'notes'] as const;

properties.post('/properties', async (req, res) => {
  const b = parse(propBody.extend({ company_id: uuid, status: propBody.shape.status.default('active') }), req.body);
  need(req.access, 'properties.manage', b.company_id);
  const row = await one(`insert into properties (company_id, ${propCols.join(', ')}) values ($1, ${propCols.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
    [b.company_id, ...propCols.map((k) => (b as any)[k] ?? (k === 'room_refs' ? [] : null))]);
  await audit(pool, req.person.id, b.company_id, 'property', row.id, 'create', { ref: b.ref });
  res.status(201).json(row);
});

properties.patch('/properties/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visibleProperty(req.access, id);
  need(req.access, 'properties.manage', p.company_id);
  const b = parse(propBody.partial().strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  const row = await one(`update properties set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [id, ...keys.map((k) => (b as any)[k])]);
  await audit(pool, req.person.id, p.company_id, 'property', id, 'update', { before: Object.fromEntries(keys.map((k) => [k, p[k]])), after: b });
  res.json(row);
});

properties.post('/properties/:id/photo', upload.single('file'), async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visibleProperty(req.access, id);
  need(req.access, 'properties.manage', p.company_id);
  if (!req.file) throw bad('Choose a photo to upload.');
  const oldPath = await tx(async (db) => {
    const f = await saveFile(db, { companyId: p.company_id, entityType: 'property', entityId: id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true });
    await q('update properties set photo_path = $2 where id = $1', [id, f.id], db);
    return p.photo_path ? deleteFile(db, p.photo_path) : null;
  });
  res.status(201).json({ ok: true });
});
properties.get('/properties/:id/photo', async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visibleProperty(req.access, id);
  const f = p.photo_path && await one<{ storage_path: string; mime_type: string }>('select storage_path, mime_type from files where id = $1', [p.photo_path]);
  if (!f) throw notFound();
  res.set({ 'Content-Type': f.mime_type, 'Cache-Control': 'private, max-age=300' }).send(await readFile(f.storage_path));
});

// ── Keys and equipment (access codes are deliberately not stored here) ──
async function keyCompany(a: Access, keyId: string) {
  const k = await one('select k.*, p.company_id from property_keys k join properties p on p.id = k.property_id where k.id = $1', [keyId]);
  if (!k || !a.perms.has(k.company_id)) throw notFound();
  need(a, 'properties.manage', k.company_id);
  return k;
}
properties.post('/properties/:id/keys', async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visibleProperty(req.access, id);
  need(req.access, 'properties.manage', p.company_id);
  const b = parse(z.object({ label: text(120).min(2), notes: text(500).optional() }), req.body);
  const row = await one('insert into property_keys (property_id, label, notes) values ($1,$2,$3) returning *', [id, b.label, b.notes ?? null]);
  await audit(pool, req.person.id, p.company_id, 'property_key', row.id, 'create', { label: b.label });
  res.status(201).json(row);
});
properties.post('/keys/:id/:action', async (req, res) => {
  const id = idParam(req.params.id);
  const action = parse(z.enum(['issue', 'return', 'lost']), req.params.action);
  const k = await keyCompany(req.access, id);
  if (action === 'issue') {
    const { holder_person_id } = parse(z.object({ holder_person_id: uuid }), req.body);
    if (k.holder_person_id && !k.returned_at && !k.lost_reported_at) throw conflict('This key is already issued. Record its return first.');
    // Only current staff of the property's company, so keys appear on the right leaver checklist.
    if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [holder_person_id, k.company_id])))
      throw bad('Keys can only be issued to someone with a current appointment in this property’s company.', { fields: { holder_person_id: 'Not current staff here' } });
    await q('update property_keys set holder_person_id = $2, issued_at = now(), returned_at = null, lost_reported_at = null where id = $1', [id, holder_person_id]);
  } else if (action === 'return') {
    await q('update property_keys set returned_at = now() where id = $1 and holder_person_id is not null', [id]);
  } else {
    await q('update property_keys set lost_reported_at = now() where id = $1', [id]);
  }
  await audit(pool, req.person.id, k.company_id, 'property_key', id, action, { holder_person_id: req.body?.holder_person_id ?? k.holder_person_id });
  res.json({ ok: true });
});

// ── Scheduled visits (planning; expected duration is not actual duration) ──
properties.post('/scheduled-visits', async (req, res) => {
  const b = parse(z.object({ appointment_id: uuid, property_id: uuid, planned_start: localDateTime, planned_minutes: z.coerce.number().int().min(5).max(720), notes: text(300).optional() }), req.body);
  const ap = await one(`select a.* from appointments a where a.id = $1 and ${ACTIVE_APPT('a')}`, [b.appointment_id]);
  if (!ap || !req.access.perms.has(ap.company_id)) throw notFound();
  if (ap.person_id !== req.person.id) need(req.access, 'visits.approve', ap.company_id);
  const pr = await one(`select 1 from properties p where p.id = $1 and (p.company_id = $2 or exists (select 1 from property_company_links l where l.property_id = p.id and l.company_id = $2))`, [b.property_id, ap.company_id]);
  if (!pr) throw bad('This property is not part of the appointment’s company.', { fields: { property_id: 'Wrong company' } });
  if (await onLeave(ap.person_id, b.planned_start.slice(0, 10))) throw conflict('They are on approved leave that day. Plan the visit for someone else or another day.');
  const row = await one(`insert into scheduled_visits (company_id, property_id, person_id, appointment_id, planned_start, planned_minutes, notes, created_by)
                         values ($1,$2,$3,$4,($5::timestamp at time zone 'Europe/London'),$6,$7,$8) returning *`,
    [ap.company_id, b.property_id, ap.person_id, ap.id, b.planned_start, b.planned_minutes, b.notes ?? null, req.person.id]);
  await audit(pool, req.person.id, ap.company_id, 'scheduled_visit', row.id, 'create', {});
  res.status(201).json(row);
});
properties.post('/scheduled-visits/:id/cancel', async (req, res) => {
  const id = idParam(req.params.id);
  const s = await one('select * from scheduled_visits where id = $1', [id]);
  if (!s || !req.access.perms.has(s.company_id)) throw notFound();
  if (s.person_id !== req.person.id) need(req.access, 'visits.approve', s.company_id);
  await q(`update scheduled_visits set status = 'cancelled' where id = $1 and status = 'scheduled'`, [id]);
  await audit(pool, req.person.id, s.company_id, 'scheduled_visit', id, 'cancel', {});
  res.json({ ok: true });
});
properties.get('/schedule', async (req, res) => {
  const a = req.access;
  const from = parse(isoDate, req.query.from), to = parse(isoDate, req.query.to);
  res.json(await q(`select s.*, p.name as property_name, c.code as company_code, c.name as company_name, ${name('w')} as person_name,
                           (s.status = 'scheduled' and s.planned_start + make_interval(mins => s.planned_minutes) < now()) as missed
                      from scheduled_visits s join properties p on p.id = s.property_id join companies c on c.id = s.company_id join people w on w.id = s.person_id
                     where (s.person_id = $1 or s.company_id = any($2::uuid[])) and s.planned_start >= ($3::date::timestamp at time zone 'Europe/London')
                       and s.planned_start < (($4::date + 1)::timestamp at time zone 'Europe/London') and s.status <> 'cancelled' order by s.planned_start`,
    [a.personId, companiesWith(a, 'visits.view_all'), from, to]));
});
