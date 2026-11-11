// House info packs and property routines (migration 049).
// Info pack: anyone who can see the property reads it; managers (properties.manage or tasks.manage) edit it and alone see `access`.
// Routines: repeating jobs that become a task on the day they are due (runRoutines, hourly and when a routine is added).
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, LONDON_TODAY, notFound, parse, text, uuid } from '../http.ts';
import { type Access, can } from '../perm.ts';
import { deleteFile, saveFile } from '../storage.ts';
import { visibleProperty } from './properties.ts';
import { upload } from './people.ts';

export const houseinfo = Router();

export const INFO_SECTIONS = ['water', 'electrics', 'heating', 'meters', 'bins', 'wifi', 'fire', 'house_rules', 'emergency', 'other'] as const;
const PHOTO_SECTIONS = [...INFO_SECTIONS, 'access'] as const;
export const canRunHouse = (a: Access, companyId: string) => can(a, 'properties.manage', companyId) || can(a, 'tasks.manage', companyId);

// ── Info pack ──
houseinfo.get('/properties/:id/info', async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  const manage = canRunHouse(a, p.company_id);
  const info = await one(`select i.sections, i.access, i.updated_at, coalesce(u.preferred_name, u.full_name) as updated_by_name
                            from property_info i left join people u on u.id = i.updated_by where i.property_id = $1`, [p.id]);
  const photos = await q(`select f.id, f.original_name, ph.section from property_info_photos ph join files f on f.id = ph.file_id
                           where ph.property_id = $1 and ($2 or ph.section <> 'access') order by f.uploaded_at`, [p.id, manage]);
  res.json({ sections: info?.sections ?? {}, access: manage ? (info?.access ?? '') : undefined, updated_at: info?.updated_at ?? null,
             updated_by_name: info?.updated_by_name ?? null, photos, can: { manage } });
});

houseinfo.put('/properties/:id/info', async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  if (!canRunHouse(a, p.company_id)) throw forbidden();
  const b = parse(z.object({ sections: z.object(Object.fromEntries(INFO_SECTIONS.map((k) => [k, text(4000).optional()]))), access: text(4000).optional() }), req.body);
  const sections = Object.fromEntries(Object.entries(b.sections).filter(([, v]) => v));
  await tx(async (db) => {
    await q(`insert into property_info (property_id, company_id, sections, access, updated_by, updated_at) values ($1,$2,$3,$4,$5, now())
             on conflict (property_id) do update set sections = excluded.sections, access = coalesce($4, property_info.access), updated_by = $5, updated_at = now()`,
      [p.id, p.company_id, JSON.stringify(sections), b.access ?? null, a.personId], db);
    // The codes themselves are never written to the audit log.
    await audit(db, a.personId, p.company_id, 'property', p.id, 'info_pack', { sections: Object.keys(sections), access_changed: b.access !== undefined });
  });
  res.json({ ok: true });
});

houseinfo.post('/properties/:id/info/photos', upload.single('file'), async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  if (!canRunHouse(a, p.company_id)) throw forbidden();
  const { section } = parse(z.object({ section: z.enum(PHOTO_SECTIONS) }), req.body);
  if (!req.file) throw bad('Choose a photo.');
  if (((await one<{ n: number }>('select count(*)::int n from property_info_photos where property_id = $1 and section = $2', [p.id, section]))!.n) >= 6)
    throw bad('Up to 6 photos for each section. Remove one first.');
  const f = await tx(async (db) => {
    const saved = await saveFile(db, { companyId: p.company_id, entityType: 'property_info', entityId: p.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: a.personId, imagesOnly: true });
    await q('insert into property_info_photos (file_id, property_id, section) values ($1,$2,$3)', [saved.id, p.id, section], db);
    await audit(db, a.personId, p.company_id, 'property', p.id, 'info_photo_add', { section });
    return saved;
  });
  res.status(201).json({ id: f.id, original_name: f.original_name, section });
});

houseinfo.delete('/properties/:id/info/photos/:fid', async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  if (!canRunHouse(a, p.company_id)) throw forbidden();
  const ph = await one('select section from property_info_photos where file_id = $1 and property_id = $2', [idParam(req.params.fid), p.id]);
  if (!ph) throw notFound();
  await tx(async (db) => { await deleteFile(db, req.params.fid); await audit(db, a.personId, p.company_id, 'property', p.id, 'info_photo_remove', { section: ph.section }); });
  res.json({ ok: true });
});

/** For GET /files/:id: may this person see this info-pack photo? */
export async function infoPhotoVisible(a: Access, fileId: string) {
  const ph = await one('select property_id, section from property_info_photos where file_id = $1', [fileId]);
  if (!ph) return false;
  const p = await visibleProperty(a, ph.property_id).catch(() => null);
  return !!p && (ph.section !== 'access' || canRunHouse(a, p.company_id));
}

// ── Routines ──
const routineBody = z.object({
  title: text(200).min(3), details: text(2000).nullable().optional(),
  frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly']),
  weekday: z.number().int().min(1).max(7).nullable().optional(), month_day: z.number().int().min(1).max(28).nullable().optional(),
  start_on: isoDate.optional(), owner_id: uuid.nullable().optional(),
  checklist: z.array(text(200).min(1)).max(20).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});
function shape(b: z.infer<typeof routineBody>) {
  const weekly = b.frequency === 'weekly' || b.frequency === 'fortnightly';
  if (weekly && !b.weekday) throw bad('Choose the day of the week.', { fields: { weekday: 'Required' } });
  if (b.frequency === 'monthly' && !b.month_day) throw bad('Choose the day of the month.', { fields: { month_day: 'Required' } });
  return { weekday: weekly ? b.weekday : null, month_day: b.frequency === 'monthly' ? b.month_day : null };
}
async function checkOwner(companyId: string, ownerId: string | null | undefined) {
  if (ownerId && !(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and a.status = 'active'`, [ownerId, companyId])))
    throw bad('Choose someone who works for this company.', { fields: { owner_id: 'Not current staff here' } });
}

houseinfo.get('/properties/:id/routines', async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  const rows = await q(`select r.*, coalesce(o.preferred_name, o.full_name) as owner_name,
      (select json_build_object('id', t.id, 'status', t.status, 'due_on', t.due_on) from tasks t where t.routine_id = r.id order by t.routine_date desc limit 1) as last_task,
      (select count(*) from tasks t where t.routine_id = r.id and t.status <> 'completed' and t.due_on < ${LONDON_TODAY})::int as overdue
    from property_routines r left join people o on o.id = r.owner_id where r.property_id = $1 and r.ended_at is null order by r.frequency, r.weekday nulls first, r.title`, [p.id]);
  res.json({ routines: rows, can: { manage: canRunHouse(a, p.company_id) } });
});

houseinfo.post('/properties/:id/routines', async (req, res) => {
  const a = req.access;
  const p = await visibleProperty(a, idParam(req.params.id));
  if (!canRunHouse(a, p.company_id)) throw forbidden();
  const b = parse(routineBody, req.body);
  const s = shape(b);
  await checkOwner(p.company_id, b.owner_id);
  const r = await tx(async (db) => {
    const row = await one(`insert into property_routines (company_id, property_id, title, details, frequency, weekday, month_day, start_on, owner_id, checklist, priority, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, ${LONDON_TODAY}),$9,$10,$11,$12) returning *`,
      [p.company_id, p.id, b.title, b.details ?? null, b.frequency, s.weekday, s.month_day, b.start_on ?? null, b.owner_id ?? null,
       JSON.stringify((b.checklist ?? []).map((t) => ({ text: t, done: false }))), b.priority ?? 'normal', a.personId], db);
    await audit(db, a.personId, p.company_id, 'property_routine', row.id, 'create', { property_id: p.id, title: b.title, frequency: b.frequency });
    return row;
  });
  await runRoutines(pool, r.id); // today's task straight away if it is due today
  res.status(201).json(r);
});

houseinfo.patch('/routines/:id', async (req, res) => {
  const a = req.access;
  const r = await one('select * from property_routines where id = $1 and ended_at is null', [idParam(req.params.id)]);
  if (!r) throw notFound();
  await visibleProperty(a, r.property_id);
  if (!canRunHouse(a, r.company_id)) throw forbidden();
  const b = parse(routineBody, req.body);
  const s = shape(b);
  await checkOwner(r.company_id, b.owner_id);
  // Changes apply from the next task; tasks already made keep what they were given.
  await q(`update property_routines set title = $2, details = $3, frequency = $4, weekday = $5, month_day = $6, owner_id = $7, checklist = $8, priority = $9 where id = $1`,
    [r.id, b.title, b.details ?? null, b.frequency, s.weekday, s.month_day, b.owner_id ?? null, JSON.stringify((b.checklist ?? []).map((t) => ({ text: t, done: false }))), b.priority ?? 'normal']);
  await audit(pool, a.personId, r.company_id, 'property_routine', r.id, 'update', { title: b.title, frequency: b.frequency });
  res.json({ ok: true });
});

houseinfo.post('/routines/:id/end', async (req, res) => {
  const a = req.access;
  const r = await one('select * from property_routines where id = $1 and ended_at is null', [idParam(req.params.id)]);
  if (!r) throw notFound();
  await visibleProperty(a, r.property_id);
  if (!canRunHouse(a, r.company_id)) throw forbidden();
  await q('update property_routines set ended_at = now(), ended_by = $2 where id = $1', [r.id, a.personId]);
  await audit(pool, a.personId, r.company_id, 'property_routine', r.id, 'end', { title: r.title });
  res.json({ ok: true });
});

/** Make today's task for every routine due today (London). Safe to run any number of times. */
export async function runRoutines(db: Db = pool, only?: string) {
  const made = await q<{ id: string; owner_id: string | null; company_id: string; title: string }>(`
    with today as (select ${LONDON_TODAY} as d)
    insert into tasks (company_id, property_id, title, description, owner_id, created_by, due_on, priority, checklist, routine_id, routine_date)
    select r.company_id, r.property_id, r.title, r.details,
           coalesce((select o.id from people o where o.id = r.owner_id and o.status <> 'left'), pr.manager_person_id),
           r.created_by, t.d, r.priority, r.checklist, r.id, t.d
      from property_routines r join properties pr on pr.id = r.property_id, today t
     where r.ended_at is null and r.start_on <= t.d and pr.status <> 'offboarded' and ($1::uuid is null or r.id = $1)
       and (r.frequency = 'daily'
         or (r.frequency = 'weekly' and r.weekday = extract(isodow from t.d))
         or (r.frequency = 'fortnightly' and r.weekday = extract(isodow from t.d) and ((t.d - r.start_on) / 7) % 2 = 0)
         or (r.frequency = 'monthly' and r.month_day = extract(day from t.d)))
    on conflict (routine_id, routine_date) where routine_id is not null do nothing
    returning id, owner_id, company_id, title`, [only ?? null], db);
  return made.length;
}
