import { Router } from 'express';
import { z } from 'zod';
import { clearanceGate } from '../clearance.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, HttpError, isoDate, LONDON_TODAY, localDateTime, notFound, notify, parse, text, uuid, idParam } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need, scope } from '../perm.ts';
import { deleteFile, saveFile } from '../storage.ts';
import { visitVisible } from '../visibility.ts';
import { geoBody, geotag } from '../geo.ts';
import { upload } from './people.ts';
import { complaintBody, logComplaint, propertyOf, ratingBody, saveRating } from '../condition.ts';
import { repairBody, reportRepair } from './estates.ts';

// Optional extras saved with a visit, all or nothing with the visit itself: a house mood rating, a complaint and a repair.
const extras = { rating: ratingBody.optional(), complaint: complaintBody.optional(), repair: repairBody.omit({ property_id: true }).optional() };
async function saveExtras(db: Db, personId: string, v: { id: string; property_id: string }, b: { rating?: any; complaint?: any; repair?: any }) {
  if (!b.rating && !b.complaint && !b.repair) return null;
  const p = await propertyOf(db, v.property_id);
  if (b.rating) await saveRating(db, personId, p, v.id, b.rating);
  if (b.complaint) await logComplaint(db, personId, p, v.id, b.complaint);
  return b.repair ? (await reportRepair(db, personId, p, b.repair)).id as string : null; // the repair id, so the form can add its photos
}

export const visits = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const MINUTES = (v: string) => `round(extract(epoch from (${v}.ended_at - ${v}.started_at)) / 60)::int`;
const LDATE = (col: string) => `(${col} at time zone 'Europe/London')::date`;
const workCategory = z.enum(['inspection', 'maintenance', 'cleaning', 'key_handover', 'property_check', 'administration', 'support_work', 'other']);
// Operational notes only. A short guard against resident narratives; the UI explains the rule too.
const summary = text(500).min(3, 'Add a brief summary of the work').refine((s) => !/\b(resident|tenant|service user|client)\s+(said|told|disclosed|was upset|appeared)/i.test(s),
  'Keep this to property work only — record resident support matters in the support system.');

// The viewer's appointment that may be used at this property (see properties.ts MY_APPTS for the same rule).
async function usableAppointment(db: Db, a: Access, appointmentId: string, propertyId: string) {
  const ap = await one(`select a.* from appointments a where a.id = $1 and a.person_id = $2 and ${ACTIVE_APPT('a')}`, [appointmentId, a.personId], db);
  if (!ap) throw bad('Choose one of your current roles.', { fields: { appointment_id: 'Not a current role of yours' } });
  const ok = await one(`select 1 from properties p where p.id = $1 and (
       exists (select 1 from appointment_properties x where x.appointment_id = $2 and x.property_id = p.id and x.to_date is null)
       or ($4 and (p.company_id = $3 or exists (select 1 from property_company_links l where l.property_id = p.id and l.company_id = $3))))`,
    [propertyId, ap.id, ap.company_id, can(a, 'visits.approve', ap.company_id) || can(a, 'properties.manage', ap.company_id)], db);
  if (!ok) throw bad('This property is not allocated to that role. Ask your manager to allocate it.', { fields: { property_id: 'Not allocated' } });
  return ap;
}

const VISIT_PHOTOS = `select f.id, f.original_name, f.uploaded_at, f.uploaded_by, coalesce(u.preferred_name, u.full_name) as uploaded_by_name
  from files f join people u on u.id = f.uploaded_by where f.entity_type = 'visit' and f.entity_id = $1 order by f.uploaded_at`;
const MAX_VISIT_PHOTOS = 20;

// Support work is approved as soon as it is submitted (the owner's rule): one allocation for the full duration, as on approval.
async function autoApproveSupportWork(db: Db, visitId: string) {
  const v = await one<{ company_id: string; appointment_id: string; person_id: string; minutes: number }>(
    `update visits set status = 'approved', decided_at = now(), decision_note = 'Support work: approved automatically'
      where id = $1 and status = 'submitted' and work_category = 'support_work' returning company_id, appointment_id, person_id, ${MINUTES('visits')} as minutes`, [visitId], db);
  if (!v) return false;
  if (v.minutes > 0) await q('insert into visit_allocations (visit_id, company_id, appointment_id, minutes) values ($1,$2,$3,$4)', [visitId, v.company_id, v.appointment_id, v.minutes], db);
  await audit(db, v.person_id, v.company_id, 'visit', visitId, 'auto_approve', { reason: 'support_work' });
  return true;
}

async function loadVisit(a: Access, id: string, db: Db = pool) {
  const v = await one(`select v.*, ${MINUTES('v')} as minutes from visits v where v.id = $1 and ${visitVisible('v', 2, 3)}`, [id, a.personId, companiesWith(a, 'visits.view_all')], db);
  if (!v) throw notFound();
  return v;
}

// Pay records stay in step with visits: a visit covered by a submitted or approved timesheet (for its own or a split
// appointment, at its current or proposed date) cannot be corrected until a timesheet approver returns that timesheet.
async function timesheetLock(db: Db, visitId: string, proposedStart: string | null) {
  const t = await one(`select t.status from visits v join timesheets t on t.status <> 'rejected'
                         and (t.appointment_id = v.appointment_id or t.appointment_id in (select appointment_id from visit_allocations where visit_id = v.id))
                         and (${LDATE('v.started_at')} between t.period_start and t.period_end or ${LDATE('$2::timestamptz')} between t.period_start and t.period_end)
                        where v.id = $1 limit 1`, [visitId, proposedStart], db);
  if (t) throw conflict(`A ${t.status} timesheet covers this visit. A timesheet approver must return it before the times can be corrected, so pay records stay in step with visits.`);
}

async function noOverlap(db: Db, personId: string, start: string, end: string, exceptId: string | null) {
  const clash = await one(`select v.id, p.name from visits v join properties p on p.id = v.property_id
                            where v.person_id = $1 and v.status not in ('cancelled','rejected') and ($4::uuid is null or v.id <> $4)
                              and tstzrange(v.started_at, coalesce(v.ended_at, now())) && tstzrange($2::timestamptz, $3::timestamptz)`, [personId, start, end, exceptId], db);
  if (clash) throw new HttpError(409, 'overlap', `These times overlap another visit you recorded at ${clash.name}.`);
}

// ── Live visit ──
visits.post('/visits/start', async (req, res) => {
  const b = parse(z.object({ property_id: uuid, appointment_id: uuid, client_request_id: uuid, planned_minutes: z.coerce.number().int().min(5).max(720).optional(), scheduled_visit_id: uuid.optional(), geo: geoBody }), req.body);
  const prior = await one('select id, person_id from visits where client_request_id = $1', [b.client_request_id]);
  if (prior) { // duplicate tap or retry after a network drop: return the same visit
    if (prior.person_id !== req.person.id) throw conflict('Duplicate request.');
    return res.json({ visit: await loadVisit(req.access, prior.id), warnings: [], duplicate: true });
  }
  const out = await tx(async (db) => {
    const ap = await usableAppointment(db, req.access, b.appointment_id, b.property_id);
    const warnings = await clearanceGate(db, req.access, req.person.id, ap.company_id, 'Start visit');
    try {
      // Geotag: where they were when they pressed Start (only then; nothing is tracked during the visit).
      const g = await geotag(db, b.property_id, b.geo);
      const v = await one(`insert into visits (person_id, appointment_id, company_id, property_id, entry_mode, status, started_at, expected_end_at, planned_minutes, client_request_id, scheduled_visit_id, start_lat, start_lng, start_accuracy_m, start_distance_m)
                           values ($1,$2,$3,$4,'live','in_progress', now(), case when $5::int is null then null else now() + make_interval(mins => $5::int) end, $5, $6, $7, $8, $9, $10, $11) returning *`,
        [req.person.id, ap.id, ap.company_id, b.property_id, b.planned_minutes ?? null, b.client_request_id, b.scheduled_visit_id ?? null, ...g], db);
      await audit(db, req.person.id, ap.company_id, 'visit', v.id, 'start', { property_id: b.property_id });
      return { visit: v, warnings };
    } catch (e: any) {
      if (e.code === '23505' && e.constraint === 'one_active_visit_per_person') throw conflict('You already have a visit in progress. Finish it before starting another.');
      throw e;
    }
  });
  res.status(201).json(out);
});

async function ownActive(db: Db, a: Access, id: string) {
  const v = await one(`select * from visits where id = $1 and person_id = $2 for update`, [id, a.personId], db);
  if (!v) throw notFound();
  if (v.status !== 'in_progress') throw conflict('This visit is no longer in progress.');
  return v;
}

visits.post('/visits/:id/finish', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ work_category: workCategory, summary, ...extras, geo: geoBody }), req.body);
  const v = await tx(async (db) => {
    const cur = await ownActive(db, req.access, id);
    const g = await geotag(db, cur.property_id, b.geo);
    // The finish time is the server's clock when Save is pressed. A visit under a minute is still stored to the second.
    const row = await one(`update visits set ended_at = greatest(now(), started_at + interval '1 second'), status = 'submitted', submitted_at = now(), work_category = $2, summary = $3, finish_lat = $4, finish_lng = $5, finish_accuracy_m = $6, finish_distance_m = $7 where id = $1 returning *, ${MINUTES('visits')} as minutes`, [id, b.work_category, b.summary, ...g], db);
    if (cur.scheduled_visit_id) await q(`update scheduled_visits set status = 'completed', visit_id = $2 where id = $1 and status = 'scheduled'`, [cur.scheduled_visit_id, id], db);
    await audit(db, req.person.id, cur.company_id, 'visit', id, 'finish', {});
    row.repair_id = await saveExtras(db, req.person.id, cur, b);
    if (await autoApproveSupportWork(db, id)) row.status = 'approved';
    return row;
  });
  res.json(v);
});

visits.post('/visits/:id/cancel', async (req, res) => {
  const id = idParam(req.params.id);
  const { reason } = parse(z.object({ reason: text(300).min(3) }), req.body);
  await tx(async (db) => {
    const cur = await ownActive(db, req.access, id);
    await q(`update visits set status = 'cancelled', decision_note = $2 where id = $1`, [id, `Cancelled by worker: ${reason}`], db);
    await audit(db, req.person.id, cur.company_id, 'visit', id, 'cancel', { reason });
  });
  res.json({ ok: true });
});

// Lone-worker check-in: the worker extends their expected finish, or a named contact records that they checked.
visits.post('/visits/:id/extend', async (req, res) => {
  const id = idParam(req.params.id);
  const { minutes } = parse(z.object({ minutes: z.coerce.number().int().min(5).max(480) }), req.body);
  await tx(async (db) => {
    const cur = await ownActive(db, req.access, id);
    await q(`update visits set expected_end_at = now() + make_interval(mins => $2::int), checkin_ack_at = null, checkin_ack_by = null where id = $1`, [id, minutes], db);
    await audit(db, req.person.id, cur.company_id, 'visit', id, 'check_in', { minutes });
  });
  res.json({ ok: true });
});
visits.post('/visits/:id/ack-checkin', async (req, res) => {
  const id = idParam(req.params.id);
  const { note } = parse(z.object({ note: text(300).min(3) }), req.body);
  const v = await loadVisit(req.access, id);
  const isManager = await one('select 1 from appointments where id = $1 and manager_person_id = $2', [v.appointment_id, req.person.id]);
  if (!isManager && !can(req.access, 'visits.view_all', v.company_id)) throw forbidden();
  await q('update visits set checkin_ack_by = $2, checkin_ack_at = now() where id = $1', [id, req.person.id]);
  await audit(pool, req.person.id, v.company_id, 'visit', id, 'check_in_acknowledged', { note });
  res.json({ ok: true });
});

// ── Completed visit logged afterwards ──
visits.post('/visits/manual', async (req, res) => {
  const b = parse(z.object({
    property_id: uuid, appointment_id: uuid, client_request_id: uuid, start_local: localDateTime,
    minutes: z.coerce.number().int().min(1, 'At least 1 minute').max(720, 'No more than 12 hours'), work_category: workCategory, summary, confirm_unusual: z.boolean().optional(), ...extras,
  }), req.body);
  const prior = await one('select id, person_id from visits where client_request_id = $1', [b.client_request_id]);
  if (prior) {
    if (prior.person_id !== req.person.id) throw conflict('Duplicate request.');
    return res.json({ visit: await loadVisit(req.access, prior.id), warnings: [], duplicate: true });
  }
  if (b.minutes > 240 && !b.confirm_unusual) throw new HttpError(422, 'unusual_duration', `${Math.floor(b.minutes / 60)} h ${b.minutes % 60} min is longer than usual. Please confirm it is correct.`);
  const out = await tx(async (db) => {
    const ap = await usableAppointment(db, req.access, b.appointment_id, b.property_id);
    const t = (await one<{ s: string; e: string; future: boolean; old: boolean }>(
      `select s, s + make_interval(mins => $2::int) as e, s + make_interval(mins => $2::int) > now() as future, s < now() - interval '62 days' as old
         from (select ($1::timestamp at time zone 'Europe/London') as s) x`, [b.start_local, b.minutes], db))!;
    if (t.future) throw bad('The visit cannot finish in the future. Use Start Visit for work happening now.', { fields: { start_local: 'In the future' } });
    if (t.old) throw bad('This is more than 62 days ago. Ask your manager to record it.', { fields: { start_local: 'Too long ago' } });
    await noOverlap(db, req.person.id, t.s, t.e, null);
    const warnings = await clearanceGate(db, req.access, req.person.id, ap.company_id, 'Log completed visit');
    const v = await one(`insert into visits (person_id, appointment_id, company_id, property_id, entry_mode, status, started_at, ended_at, work_category, summary, submitted_at, client_request_id)
                         values ($1,$2,$3,$4,'manual','submitted',$5,$6,$7,$8, now(), $9) returning *`,
      [req.person.id, ap.id, ap.company_id, b.property_id, t.s, t.e, b.work_category, b.summary, b.client_request_id], db);
    await audit(db, req.person.id, ap.company_id, 'visit', v.id, 'manual_entry', { minutes: b.minutes });
    v.repair_id = await saveExtras(db, req.person.id, v, b);
    if (await autoApproveSupportWork(db, v.id)) v.status = 'approved';
    return { visit: v, warnings };
  });
  res.status(201).json(out);
});

// ── Lists and detail ──
visits.get('/visits', async (req, res) => {
  const a = req.access;
  const from = parse(isoDate, req.query.from), to = parse(isoDate, req.query.to);
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const person = req.query.person === 'me' ? a.personId : req.query.person ? parse(uuid, req.query.person) : null;
  const status = req.query.status ? parse(z.enum(['in_progress', 'submitted', 'approved', 'rejected', 'cancelled']), req.query.status) : null;
  res.json(await q(`
    select v.id, v.started_at, v.ended_at, v.status, v.entry_mode, v.work_category, v.summary, v.submitted_at, v.created_at, v.expected_end_at, ${MINUTES('v')} as minutes, v.start_distance_m, (v.start_lat is not null) as geotagged,
           v.person_id, ${name('w')} as person_name, v.company_id, c.name as company_name, c.code as company_code, v.property_id, p.name as property_name, p.ref as property_ref,
           exists (select 1 from visit_corrections vc where vc.visit_id = v.id and vc.status = 'pending') as correction_pending,
           (v.status = 'in_progress' and v.started_at < now() - interval '12 hours') as missing_clock_out
      from visits v join people w on w.id = v.person_id join companies c on c.id = v.company_id join properties p on p.id = v.property_id
     where ${visitVisible('v', 1, 2)} and ${LDATE('v.started_at')} between $3 and $4
       and ($5::uuid is null or v.company_id = $5) and ($6::uuid is null or v.person_id = $6) and ($7::text is null or v.status = $7)
     order by v.started_at desc limit 1000`, [a.personId, companiesWith(a, 'visits.view_all'), from, to, company, person, status]));
});

visits.get('/visits/:id', async (req, res) => {
  const a = req.access;
  const v = await loadVisit(a, idParam(req.params.id));
  const [detail, corrections, allocations, appts, photos] = await Promise.all([
    one(`select ${name('w')} as person_name, c.name as company_name, c.code as company_code, p.name as property_name, p.ref as property_ref, p.latitude as property_lat, p.longitude as property_lng, ${name('d')} as decided_by_name, ap.job_title
           from visits v join people w on w.id = v.person_id join companies c on c.id = v.company_id join properties p on p.id = v.property_id
           join appointments ap on ap.id = v.appointment_id left join people d on d.id = v.decided_by where v.id = $1`, [v.id]),
    q(`select vc.*, ${name('r')} as requested_by_name, ${name('d')} as decided_by_name from visit_corrections vc join people r on r.id = vc.requested_by left join people d on d.id = vc.decided_by where vc.visit_id = $1 order by vc.created_at`, [v.id]),
    q(`select va.*, c.name as company_name, c.code as company_code, ap.job_title from visit_allocations va join companies c on c.id = va.company_id join appointments ap on ap.id = va.appointment_id where va.visit_id = $1`, [v.id]),
    // For splitting: the worker's other appointments in companies where the viewer may approve.
    q(`select a.id, a.company_id, a.job_title, c.name as company_name, c.code as company_code from appointments a join companies c on c.id = a.company_id where a.person_id = $1 and a.company_id = any($2::uuid[])`, [v.person_id, companiesWith(a, 'visits.approve')]),
    q(VISIT_PHOTOS, [v.id]),
  ]);
  const own = v.person_id === a.personId;
  res.json({
    visit: { ...v, ...detail }, corrections, allocations, splitAppointments: appts, photos,
    can: {
      decide: !own && v.status === 'submitted' && can(a, 'visits.approve', v.company_id),
      split: !own && v.status === 'approved' && can(a, 'visits.approve', v.company_id),
      correct: (own || can(a, 'visits.approve', v.company_id)) && v.status !== 'cancelled' && !corrections.some((c) => c.status === 'pending'),
      decideCorrections: !own && can(a, 'visits.approve', v.company_id),
      addPhotos: v.status !== 'cancelled' && (own || can(a, 'visits.approve', v.company_id)),
    },
  });
});

// ── Photos of the property taken on a visit (for tracking condition and work done) ──
visits.post('/visits/:id/photos', upload.single('file'), async (req, res) => {
  const v = await loadVisit(req.access, idParam(req.params.id));
  if (v.status === 'cancelled') throw conflict('Photos cannot be added to a cancelled visit.');
  if (v.person_id !== req.person.id) need(req.access, 'visits.approve', v.company_id);
  if (!req.file) throw bad('Choose a photo to upload.');
  const f = await tx(async (db) => {
    await q('select 1 from visits where id = $1 for update', [v.id], db); // serialise the count check
    const n = await one<{ n: number }>(`select count(*)::int as n from files where entity_type = 'visit' and entity_id = $1`, [v.id], db);
    if (n!.n >= MAX_VISIT_PHOTOS) throw conflict(`A visit can have up to ${MAX_VISIT_PHOTOS} photos.`);
    const saved = await saveFile(db, { companyId: v.company_id, entityType: 'visit', entityId: v.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true });
    await audit(db, req.person.id, v.company_id, 'visit', v.id, 'photo_add', { file_id: saved.id });
    return saved;
  });
  res.status(201).json({ ...f, storage_path: undefined });
});
visits.delete('/visits/:id/photos/:fileId', async (req, res) => {
  const v = await loadVisit(req.access, idParam(req.params.id));
  const f = await one(`select * from files where id = $1 and entity_type = 'visit' and entity_id = $2`, [idParam(req.params.fileId), v.id]);
  if (!f) throw notFound();
  if (f.uploaded_by !== req.person.id) throw forbidden();
  if (v.status === 'approved') throw conflict('Photos on an approved visit are kept as part of the record.');
  await tx(async (db) => { await deleteFile(db, f.id); await audit(db, req.person.id, v.company_id, 'visit', v.id, 'photo_remove', { file_id: f.id }); });
  res.json({ ok: true });
});

// ── Approval, splitting and corrections ──
visits.post('/visits/:id/decide', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ approve: z.boolean(), note: text(500).optional() }), req.body);
  if (!b.approve && !b.note) throw bad('Say why the visit is being returned.', { fields: { note: 'Required when rejecting' } });
  await tx(async (db) => {
    const v = await loadVisit(req.access, id, db);
    need(req.access, 'visits.approve', v.company_id);
    if (v.person_id === req.person.id) throw forbidden('You cannot approve your own visits.');
    const done = await one(`update visits set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and status = 'submitted' returning id`, [id, b.approve ? 'approved' : 'rejected', req.person.id, b.note ?? null], db);
    if (!done) throw conflict('This visit has already been decided or is not ready for review.');
    // One allocation for the full duration. It can later be split between companies, never duplicated.
    // A visit under a minute rounds to 0 and allocates nothing: time is never invented.
    if (b.approve && v.minutes > 0) await q('insert into visit_allocations (visit_id, company_id, appointment_id, minutes, allocated_by) values ($1,$2,$3,$4,$5)', [id, v.company_id, v.appointment_id, v.minutes, req.person.id], db);
    await audit(db, req.person.id, v.company_id, 'visit', id, b.approve ? 'approve' : 'reject', { note: b.note ?? null });
    await notify(db, v.person_id, v.company_id, b.approve ? 'Your visit was approved' : 'Your visit was returned', `/visits/${id}`, b.note);
  });
  res.json({ ok: true });
});

visits.post('/visits/:id/split', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ allocations: z.array(z.object({ appointment_id: uuid, minutes: z.coerce.number().int().min(1) })).min(1).max(3), reason: text(300).min(3) }), req.body);
  await tx(async (db) => {
    const v = await loadVisit(req.access, id, db);
    if (v.status !== 'approved') throw conflict('Only approved visits can be split.');
    if (v.person_id === req.person.id) throw forbidden('You cannot split your own visit.');
    const total = b.allocations.reduce((s, x) => s + x.minutes, 0);
    if (total !== v.minutes) throw bad(`The split must add up to exactly ${v.minutes} minutes (it adds up to ${total}).`);
    const rows: { appointment_id: string; minutes: number; company_id: string }[] = [];
    for (const x of b.allocations) {
      const ap = await one('select id, company_id, person_id from appointments where id = $1', [x.appointment_id], db);
      if (!ap || ap.person_id !== v.person_id) throw bad('Each part must use one of this worker’s appointments.');
      need(req.access, 'visits.approve', ap.company_id);
      rows.push({ ...x, company_id: ap.company_id });
    }
    if (new Set(rows.map((r) => r.company_id)).size !== rows.length) throw bad('Use each company once.');
    await q('delete from visit_allocations where visit_id = $1', [id], db);
    for (const r of rows) await q('insert into visit_allocations (visit_id, company_id, appointment_id, minutes, allocated_by) values ($1,$2,$3,$4,$5)', [id, r.company_id, r.appointment_id, r.minutes, req.person.id], db);
    await audit(db, req.person.id, v.company_id, 'visit', id, 'split', { reason: b.reason, allocations: rows });
  });
  res.json({ ok: true });
});

visits.post('/visits/:id/corrections', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ start_local: localDateTime, end_local: localDateTime, reason: text(500).min(5, 'Explain the reason (at least 5 characters)') }), req.body);
  const row = await tx(async (db) => {
    const v = await loadVisit(req.access, id, db);
    if (v.person_id !== req.person.id) need(req.access, 'visits.approve', v.company_id);
    if (v.status === 'cancelled') throw conflict('Cancelled visits cannot be corrected.');
    const t = (await one<{ s: string; e: string; future: boolean }>(`select ($1::timestamp at time zone 'Europe/London') s, ($2::timestamp at time zone 'Europe/London') e, ($2::timestamp at time zone 'Europe/London') > now() future`, [b.start_local, b.end_local], db))!;
    if (new Date(t.e) <= new Date(t.s)) throw bad('The finish must be after the start.', { fields: { end_local: 'Before start' } });
    if (t.future) throw bad('The finish cannot be in the future.', { fields: { end_local: 'In the future' } });
    if ((new Date(t.e).getTime() - new Date(t.s).getTime()) / 60000 > 720) throw bad('A visit cannot be longer than 12 hours.');
    await noOverlap(db, v.person_id, t.s, t.e, id);
    await timesheetLock(db, id, t.s);
    const r = await one(`insert into visit_corrections (visit_id, requested_by, reason, original, proposed) values ($1,$2,$3,$4,$5) returning *`,
      [id, req.person.id, b.reason, { started_at: v.started_at, ended_at: v.ended_at, status: v.status }, { started_at: t.s, ended_at: t.e }], db);
    await audit(db, req.person.id, v.company_id, 'visit_correction', r.id, 'request', { visit_id: id });
    return r;
  });
  res.status(201).json(row);
});

visits.post('/corrections/:id/decide', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ approve: z.boolean(), note: text(500).optional() }), req.body);
  if (!b.approve && !b.note) throw bad('Say why the correction is not approved.', { fields: { note: 'Required' } });
  await tx(async (db) => {
    const c = await one('select vc.*, v.company_id, v.person_id from visit_corrections vc join visits v on v.id = vc.visit_id where vc.id = $1 for update of vc', [id], db);
    if (!c || !req.access.perms.has(c.company_id)) throw notFound();
    need(req.access, 'visits.approve', c.company_id);
    if (c.requested_by === req.person.id || c.person_id === req.person.id) throw forbidden('Someone else must decide this correction.');
    if (c.status !== 'pending') throw conflict('This correction has already been decided.');
    if (b.approve) await timesheetLock(db, c.visit_id, c.proposed.started_at);
    await q('update visit_corrections set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, b.approve ? 'approved' : 'rejected', req.person.id, b.note ?? null], db);
    if (b.approve) {
      // The original stays in the correction record; the visit goes back for approval with the corrected times.
      await q(`update visits set started_at = $2, ended_at = $3, status = 'submitted', submitted_at = coalesce(submitted_at, now()), decided_by = null, decided_at = null, decision_note = null where id = $1`,
        [c.visit_id, c.proposed.started_at, c.proposed.ended_at], db);
      await q('delete from visit_allocations where visit_id = $1', [c.visit_id], db);
      await autoApproveSupportWork(db, c.visit_id);
    }
    await audit(db, req.person.id, c.company_id, 'visit_correction', id, b.approve ? 'approve' : 'reject', { visit_id: c.visit_id, original: c.original, proposed: c.proposed });
    await notify(db, c.requested_by, c.company_id, `Visit correction ${b.approve ? 'approved — visit returned for approval' : 'not approved'}`, `/visits/${c.visit_id}`, b.note);
  });
  res.json({ ok: true });
});

// ── Attendance ──
visits.get('/attendance/heatmap', async (req, res) => {
  const a = req.access;
  const year = parse(z.coerce.number().int().min(2020).max(2100), req.query.year);
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const person = req.query.person === 'me' ? a.personId : req.query.person ? parse(uuid, req.query.person) : null;
  res.json(await q(`
    select ${LDATE('v.started_at')}::text as day, count(*)::int as visits,
           coalesce(sum(${MINUTES('v')}) filter (where v.status in ('submitted','approved')), 0)::int as recorded_minutes,
           coalesce(sum(${MINUTES('v')}) filter (where v.status = 'approved'), 0)::int as approved_minutes,
           count(*) filter (where v.status = 'in_progress')::int as in_progress
      from visits v where ${visitVisible('v', 1, 2)} and extract(year from v.started_at at time zone 'Europe/London') = $3 and v.status <> 'cancelled'
       and ($4::uuid is null or v.company_id = $4) and ($5::uuid is null or v.person_id = $5)
     group by 1 order by 1`, [a.personId, companiesWith(a, 'visits.view_all'), year, company, person]));
});

// Contracted vs scheduled vs recorded vs approved, per appointment, for a week.
visits.get('/workload', async (req, res) => {
  const a = req.access;
  const week = parse(isoDate, req.query.week_start);
  const cs = scope(a, 'visits.view_all', req.query.company);
  res.json(await q(`
    with w as (select ($1::date::timestamp at time zone 'Europe/London') s, (($1::date + 7)::timestamp at time zone 'Europe/London') e)
    select ap.id as appointment_id, ${name('p')} as person_name, p.id as person_id, ap.job_title, c.name as company_name, c.code as company_code, ap.contracted_hours_per_week,
           (select count(*) from generate_series($1::date, $1::date + 6, interval '1 day') d
             where extract(isodow from d) < 6 and exists (select 1 from leave_requests l where l.person_id = p.id and l.status = 'approved' and d::date between l.start_date and l.end_date))::int as leave_days,
           (select coalesce(sum(s.planned_minutes), 0) from scheduled_visits s, w where s.appointment_id = ap.id and s.status <> 'cancelled' and s.planned_start >= w.s and s.planned_start < w.e)::int as scheduled_minutes,
           ((select coalesce(sum(${MINUTES('v')}), 0) from visits v, w where v.appointment_id = ap.id and v.status in ('submitted','approved') and v.started_at >= w.s and v.started_at < w.e)
            + (select coalesce(sum(t.minutes), 0) from time_entries t where t.appointment_id = ap.id and t.status <> 'rejected' and t.work_date >= $1::date and t.work_date < $1::date + 7))::int as recorded_minutes,
           ((select coalesce(sum(va.minutes), 0) from visit_allocations va join visits v on v.id = va.visit_id, w where va.appointment_id = ap.id and v.started_at >= w.s and v.started_at < w.e)
            + (select coalesce(sum(t.minutes), 0) from time_entries t where t.appointment_id = ap.id and t.status = 'approved' and t.work_date >= $1::date and t.work_date < $1::date + 7))::int as approved_minutes
      from appointments ap join people p on p.id = ap.person_id join companies c on c.id = ap.company_id
     where ap.company_id = any($2::uuid[]) and ${ACTIVE_APPT('ap')} order by c.name, p.full_name`, [week, cs]));
});

// ── Other working time (not visits) ──
visits.post('/time-entries', async (req, res) => {
  const b = parse(z.object({ appointment_id: uuid, work_date: isoDate, category: z.enum(['travel', 'administration', 'training', 'supervision', 'coaching', 'other']), minutes: z.coerce.number().int().min(5).max(720), note: text(300).optional() }), req.body);
  const ap = await one(`select * from appointments a where a.id = $1 and a.person_id = $2 and ${ACTIVE_APPT('a')}`, [b.appointment_id, req.person.id]);
  if (!ap) throw bad('Choose one of your current roles.');
  const future = (await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} f`, [b.work_date]))!.f;
  if (future) throw bad('Time cannot be logged for a future date.', { fields: { work_date: 'In the future' } });
  const dayTotal = (await one<{ m: number }>(`select coalesce(sum(minutes), 0)::int m from time_entries where person_id = $1 and work_date = $2 and status <> 'rejected'`, [req.person.id, b.work_date]))!.m;
  if (dayTotal + b.minutes > 960) throw bad('That would be more than 16 hours of other time on one day. Please check.');
  const row = await one('insert into time_entries (person_id, appointment_id, company_id, work_date, category, minutes, note) values ($1,$2,$3,$4,$5,$6,$7) returning *', [req.person.id, ap.id, ap.company_id, b.work_date, b.category, b.minutes, b.note ?? null]);
  await audit(pool, req.person.id, ap.company_id, 'time_entry', row.id, 'create', { minutes: b.minutes });
  res.status(201).json(row);
});
visits.get('/time-entries', async (req, res) => {
  const a = req.access;
  const from = parse(isoDate, req.query.from), to = parse(isoDate, req.query.to);
  res.json(await q(`select t.*, ${name('p')} as person_name, c.name as company_name, c.code as company_code from time_entries t join people p on p.id = t.person_id join companies c on c.id = t.company_id
                     where (t.person_id = $1 or t.company_id = any($2::uuid[])) and t.work_date between $3 and $4 order by t.work_date desc limit 500`, [a.personId, companiesWith(a, 'visits.view_all'), from, to]));
});
visits.post('/time-entries/:id/decide', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ approve: z.boolean(), note: text(300).optional() }), req.body);
  const t = await one('select * from time_entries where id = $1', [id]);
  if (!t || !req.access.perms.has(t.company_id)) throw notFound();
  need(req.access, 'visits.approve', t.company_id);
  if (t.person_id === req.person.id) throw forbidden('You cannot approve your own time.');
  const done = await one(`update time_entries set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = 'submitted' returning id`, [id, b.approve ? 'approved' : 'rejected', req.person.id]);
  if (!done) throw conflict('Already decided.');
  await audit(pool, req.person.id, t.company_id, 'time_entry', id, b.approve ? 'approve' : 'reject', { note: b.note ?? null });
  await notify(pool, t.person_id, t.company_id, `Your ${t.category} time was ${b.approve ? 'approved' : 'not approved'}`, '/timesheets', b.note);
  res.json({ ok: true });
});

// ── Timesheets: approved hours for one appointment and period, with a cost ESTIMATE (not payroll) ──
export async function timesheetCalc(db: Db, appointmentId: string, from: string, to: string) {
  const days = await q(`
    with d as (select g::date as day from generate_series($2::date, $3::date, interval '1 day') g),
    vm as (select ${LDATE('v.started_at')} as day, sum(va.minutes)::int m from visit_allocations va join visits v on v.id = va.visit_id
            where va.appointment_id = $1 and v.status = 'approved' and ${LDATE('v.started_at')} between $2 and $3 group by 1),
    tm as (select work_date as day, sum(minutes)::int m from time_entries where appointment_id = $1 and status = 'approved' and work_date between $2 and $3 group by 1)
    select d.day::text, coalesce(vm.m, 0) as visit_minutes, coalesce(tm.m, 0) as other_minutes, r.rate_type, r.amount,
           case when coalesce(vm.m, 0) + coalesce(tm.m, 0) = 0 then 0
                when r.rate_type = 'hourly' then round((coalesce(vm.m, 0) + coalesce(tm.m, 0)) * r.amount / 60, 2)
                when r.rate_type = 'daily' then r.amount end as cost
      from d left join vm on vm.day = d.day left join tm on tm.day = d.day
      left join appointment_rates r on r.appointment_id = $1 and d.day between r.effective_from and coalesce(r.effective_to, 'infinity'::date)
     order by d.day`, [appointmentId, from, to], db);
  const worked = days.filter((d) => d.visit_minutes + d.other_minutes > 0);
  const uncosted = worked.filter((d) => d.cost === null);
  const total = (await one<{ t: string | null }>(`select sum(x::numeric)::text t from unnest($1::text[]) x`, [worked.map((d) => d.cost ?? '0')], db))!.t;
  const pending = (await one<{ n: number }>(`
    select (select count(*) from visits v where v.appointment_id = $1 and v.status in ('submitted','in_progress') and ${LDATE('v.started_at')} between $2 and $3)
         + (select count(*) from time_entries t where t.appointment_id = $1 and t.status = 'submitted' and t.work_date between $2 and $3) as n`, [appointmentId, from, to], db))!.n;
  return {
    days,
    minutes: worked.reduce((s, d) => s + d.visit_minutes + d.other_minutes, 0),
    cost_estimate: worked.length && !uncosted.length ? (total ?? '0.00') : worked.length ? null : '0.00',
    cost_note: uncosted.length ? `No hourly or daily rate covers ${uncosted.length} worked day(s), so no estimate is shown.` : 'Estimate from effective-dated rates. This is not payroll.',
    pending_records: pending,
    rates: await q('select rate_type, amount, effective_from, effective_to from appointment_rates where appointment_id = $1 and effective_from <= $3 and coalesce(effective_to, $2) >= $2 order by effective_from', [appointmentId, from, to], db),
  };
}

async function timesheetAppt(a: Access, appointmentId: string, perm: string) {
  const ap = await one('select * from appointments where id = $1', [appointmentId]);
  if (!ap || !a.perms.has(ap.company_id) || (ap.person_id !== a.personId && !can(a, perm, ap.company_id))) throw notFound();
  return ap;
}

visits.get('/timesheets/preview', async (req, res) => {
  const ap = await timesheetAppt(req.access, parse(uuid, req.query.appointment_id), 'timesheets.view_all');
  const from = parse(isoDate, req.query.from), to = parse(isoDate, req.query.to);
  if (to < from) throw bad('The end date is before the start date.');
  const calc = await timesheetCalc(pool, ap.id, from, to);
  // Rates are restricted: only the worker and rates.view holders see money.
  if (ap.person_id !== req.person.id && !can(req.access, 'rates.view', ap.company_id)) Object.assign(calc, { cost_estimate: null, cost_note: 'Hidden — you do not have access to rates.', rates: [], days: calc.days.map((d: any) => ({ ...d, amount: null, cost: null })) });
  res.json(calc);
});

visits.post('/timesheets', async (req, res) => {
  const b = parse(z.object({ appointment_id: uuid, period_start: isoDate, period_end: isoDate }), req.body);
  if (b.period_end < b.period_start) throw bad('The end date is before the start date.');
  if ((Date.parse(b.period_end) - Date.parse(b.period_start)) / 86400000 > 31) throw bad('A timesheet can cover up to 31 days.');
  const ap = await one(`select * from appointments where id = $1 and person_id = $2`, [b.appointment_id, req.person.id]);
  if (!ap) throw bad('Choose one of your roles.');
  const row = await tx(async (db) => {
    const overlap = await one(`select id, status from timesheets where appointment_id = $1 and status <> 'rejected' and daterange(period_start, period_end, '[]') && daterange($2, $3, '[]')`, [ap.id, b.period_start, b.period_end], db);
    if (overlap) throw conflict('A timesheet already covers some of these dates for this role.');
    const calc = await timesheetCalc(db, ap.id, b.period_start, b.period_end);
    if (!calc.minutes) throw bad('There are no approved hours in this period yet.');
    const r = await one(`insert into timesheets (person_id, appointment_id, company_id, period_start, period_end, submitted_minutes) values ($1,$2,$3,$4,$5,$6)
                         on conflict (appointment_id, period_start, period_end) do update set status = 'submitted', submitted_at = now(), submitted_minutes = excluded.submitted_minutes, decided_by = null, decided_at = null, decision_note = null
                           where timesheets.status = 'rejected' returning *`, [req.person.id, ap.id, ap.company_id, b.period_start, b.period_end, calc.minutes], db);
    if (!r) throw conflict('This timesheet has already been submitted.');
    await audit(db, req.person.id, ap.company_id, 'timesheet', r.id, 'submit', { minutes: calc.minutes, pending_records: calc.pending_records });
    return { ...r, pending_records: calc.pending_records };
  });
  res.status(201).json(row);
});

visits.get('/timesheets', async (req, res) => {
  const a = req.access;
  const showMoney = companiesWith(a, 'rates.view');
  const rows = await q(`select t.*, ${name('p')} as person_name, c.name as company_name, c.code as company_code, ap.job_title, ${name('d')} as decided_by_name
                          from timesheets t join people p on p.id = t.person_id join companies c on c.id = t.company_id join appointments ap on ap.id = t.appointment_id left join people d on d.id = t.decided_by
                         where (t.person_id = $1 or t.company_id = any($2::uuid[])) and ($3::uuid is null or t.company_id = $3) order by t.submitted_at desc limit 300`,
    [a.personId, companiesWith(a, 'timesheets.view_all'), req.query.company ? parse(uuid, req.query.company) : null]);
  res.json(rows.map((r) => (r.person_id === a.personId || showMoney.includes(r.company_id) ? r : { ...r, cost_estimate: null, rate_snapshot: null })));
});

visits.post('/timesheets/:id/decide', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ approve: z.boolean(), note: text(500).optional() }), req.body);
  if (!b.approve && !b.note) throw bad('Say why the timesheet is being returned.', { fields: { note: 'Required' } });
  await tx(async (db) => {
    const t = await one('select * from timesheets where id = $1 for update', [id], db);
    if (!t || !req.access.perms.has(t.company_id)) throw notFound();
    need(req.access, 'timesheets.approve', t.company_id);
    if (t.person_id === req.person.id) throw forbidden('You cannot approve your own timesheet.');
    // An approved timesheet can be returned (for example so a visit can be corrected); its old figures stay in the audit log.
    if (t.status === 'rejected' || (t.status === 'approved' && b.approve)) throw conflict('Already decided.');
    const calc = await timesheetCalc(db, t.appointment_id, t.period_start, t.period_end);
    // The calculation is frozen at approval: later rate changes do not alter historical timesheets.
    await q(`update timesheets set status = $2, decided_by = $3, decided_at = now(), decision_note = $4, approved_minutes = $5, cost_estimate = $6::numeric, rate_snapshot = $7 where id = $1`,
      [id, b.approve ? 'approved' : 'rejected', req.person.id, b.note ?? null, b.approve ? calc.minutes : null, b.approve ? calc.cost_estimate : null, b.approve ? JSON.stringify({ rates: calc.rates, note: calc.cost_note }) : null], db);
    await audit(db, req.person.id, t.company_id, 'timesheet', id, b.approve ? 'approve' : 'reject', { minutes: calc.minutes, submitted_minutes: t.submitted_minutes, previous_status: t.status, previous_approved_minutes: t.approved_minutes, previous_cost_estimate: t.cost_estimate });
    await notify(db, t.person_id, t.company_id, `Your timesheet was ${b.approve ? 'approved' : 'returned'}`, '/timesheets', b.note);
  });
  res.json({ ok: true });
});
