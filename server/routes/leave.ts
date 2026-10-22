// Leave, cover and availability (§19). Leave belongs to a person; it is approved in one company where they work.
import { Router } from 'express';
import { z } from 'zod';
import { handOverTasks } from '../aiops.ts';
import { clearanceGate } from '../clearance.ts';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, can, companiesWith, need } from '../perm.ts';

export const leave = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const COLS = `l.*, ${name('p')} as person_name, c.name as company_name, c.code as company_code, ${name('d')} as decided_by_name,
              (l.end_date - l.start_date + 1) as days, (select count(*)::int from task_handovers h where h.leave_id = l.id) as handed_over`;
const FROM = `leave_requests l join people p on p.id = l.person_id join companies c on c.id = l.company_id left join people d on d.id = l.decided_by`;

// Someone on approved leave that day (any company: a person cannot work for one company while on leave from another).
export async function onLeave(personId: string, date: string, db = pool) {
  return !!(await one(`select 1 from leave_requests where person_id = $1 and status = 'approved' and $2::date between start_date and end_date`, [personId, date], db));
}

leave.get('/leave', async (req, res) => {
  const a = req.access;
  const approve = companiesWith(a, 'leave.approve');
  res.json({
    mine: await q(`select ${COLS} from ${FROM} where l.person_id = $1 order by l.start_date desc limit 100`, [a.personId]),
    toDecide: await q(`select ${COLS} from ${FROM} where l.status = 'requested' and l.company_id = any($1::uuid[]) and l.person_id <> $2 order by l.start_date`, [approve, a.personId]),
    // Team view: approved and requested leave from today, in companies whose staff list you can see.
    upcoming: await q(`select ${COLS} from ${FROM} where l.status in ('approved','requested') and l.end_date >= ${LONDON_TODAY} and l.company_id = any($1::uuid[]) order by l.start_date limit 200`,
      [[...new Set([...approve, ...companiesWith(a, 'staff.view')])]]),
    canApprove: approve,
  });
});

leave.post('/leave', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, kind: z.enum(['annual', 'sick', 'unpaid', 'training', 'compassionate', 'other']), start_date: isoDate, end_date: isoDate, note: text(500).optional(), handover_note: text(4000).optional() }), req.body);
  if (b.end_date < b.start_date) throw bad('The leave ends before it starts.', { fields: { end_date: 'Before the start' } });
  if (!(await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')}`, [req.person.id, b.company_id]))) throw bad('Choose a company where you currently work.', { fields: { company_id: 'No current role' } });
  if (await one(`select 1 from leave_requests where person_id = $1 and status in ('requested','approved') and daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`, [req.person.id, b.start_date, b.end_date]))
    throw conflict('You already have leave requested or approved on some of these days.');
  const row = await one(`insert into leave_requests (person_id, company_id, kind, start_date, end_date, note, handover_note) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [req.person.id, b.company_id, b.kind, b.start_date, b.end_date, b.note ?? null, b.handover_note ?? null]);
  await audit(pool, req.person.id, b.company_id, 'leave', row.id, 'request', { kind: b.kind, start_date: b.start_date, end_date: b.end_date });
  res.status(201).json(row);
});

async function loadLeave(a: Express.Request['access'], id: string) {
  const l = await one(`select ${COLS} from ${FROM} where l.id = $1`, [id]);
  if (!l || (l.person_id !== a.personId && !can(a, 'leave.approve', l.company_id) && !can(a, 'staff.view', l.company_id))) throw notFound();
  return l;
}

leave.post('/leave/:id/decide', async (req, res) => {
  const l = await loadLeave(req.access, idParam(req.params.id));
  need(req.access, 'leave.approve', l.company_id);
  if (l.person_id === req.person.id) throw forbidden('You cannot approve your own leave.');
  const b = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: text(500).optional() }), req.body);
  if (b.decision === 'rejected' && !b.note) throw bad('Say why, so they can plan around it.', { fields: { note: 'Required when rejecting' } });
  await tx(async (db) => {
    const r = await one(`update leave_requests set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and status = 'requested' returning id`, [l.id, b.decision, req.person.id, b.note ?? null], db);
    if (!r) throw conflict('This request has already been decided or cancelled.');
    await notify(db, l.person_id, l.company_id, `Your leave from ${l.start_date} was ${b.decision}`, '/leave', b.note);
    await audit(db, req.person.id, l.company_id, 'leave', l.id, b.decision, {});
  });
  // Approved leave hands the person's open tasks to colleagues straight away (AI-matched when the assistant is on).
  const handover = b.decision === 'approved' ? await handOverTasks(l.id, req.person.id) : [];
  res.json({ ok: true, handover });
});

leave.post('/leave/:id/cancel', async (req, res) => {
  const l = await loadLeave(req.access, idParam(req.params.id));
  const mine = l.person_id === req.person.id;
  if (!mine) need(req.access, 'leave.approve', l.company_id);
  const r = await one(`update leave_requests set status = 'cancelled' where id = $1 and status in ('requested','approved') and ($2 or end_date >= ${LONDON_TODAY}) returning id`, [l.id, !mine]);
  if (!r) throw conflict('This leave has already ended, been cancelled or been rejected.');
  if (!mine) await notify(pool, l.person_id, l.company_id, `Your leave from ${l.start_date} was cancelled by a manager`, '/leave');
  await audit(pool, req.person.id, l.company_id, 'leave', l.id, 'cancel', {});
  res.json({ ok: true });
});

// Cover: planned visits during the leave, and colleagues who could take them (current staff there, not on leave that day).
leave.get('/leave/:id/cover', async (req, res) => {
  const l = await loadLeave(req.access, idParam(req.params.id));
  need(req.access, 'visits.approve', l.company_id);
  const visits = await q(`select s.id, s.planned_start, s.planned_minutes, s.person_id, pr.name as property_name, ${name('w')} as person_name,
                                 (select coalesce(json_agg(json_build_object('person_id', ap.person_id, 'name', ${name('cp')}, 'clearance', coalesce((select cc.status from current_clearance cc where cc.person_id = ap.person_id and cc.company_id = s.company_id), 'none')) order by ${name('cp')}), '[]')
                                    from appointments ap join people cp on cp.id = ap.person_id
                                   where ap.company_id = s.company_id and ${ACTIVE_APPT('ap')} and ap.person_id <> $2
                                     and not exists (select 1 from leave_requests x where x.person_id = ap.person_id and x.status = 'approved'
                                                       and (s.planned_start at time zone 'Europe/London')::date between x.start_date and x.end_date)) as candidates
                            from scheduled_visits s join properties pr on pr.id = s.property_id join people w on w.id = s.person_id
                           where s.company_id = $1 and s.person_id = $2 and s.status = 'scheduled'
                             and (s.planned_start at time zone 'Europe/London')::date between $3 and $4 order by s.planned_start`, [l.company_id, l.person_id, l.start_date, l.end_date]);
  res.json({ visits });
});

leave.post('/scheduled-visits/:id/reassign', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ person_id: uuid, override_reason: text(500).optional() }), req.body);
  const s = await one(`select s.*, (s.planned_start at time zone 'Europe/London')::date::text as day from scheduled_visits s where s.id = $1 and s.status = 'scheduled'`, [id]);
  if (!s || !req.access.perms.has(s.company_id)) throw notFound();
  need(req.access, 'visits.approve', s.company_id);
  const warnings = await tx(async (db) => {
    const ap = await one<{ id: string }>(`select a.id from appointments a where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')} order by a.start_date limit 1`, [b.person_id, s.company_id], db);
    if (!ap) throw bad('Cover must come from someone who currently works for this company.', { fields: { person_id: 'Not current staff here' } });
    if (await onLeave(b.person_id, s.day, db as any)) throw conflict('That person is on approved leave that day.');
    const w = await clearanceGate(db, req.access, b.person_id, s.company_id, 'scheduled visit cover', b.override_reason);
    await q('update scheduled_visits set person_id = $2, appointment_id = $3 where id = $1', [id, b.person_id, ap.id], db);
    await notify(db, b.person_id, s.company_id, 'You have been asked to cover a planned visit', '/');
    await audit(db, req.person.id, s.company_id, 'scheduled_visit', id, 'reassign', { from: s.person_id, to: b.person_id });
    return w;
  });
  res.json({ ok: true, warnings });
});
