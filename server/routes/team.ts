// Staff assignments (migration 046): managers and support managers are assigned the staff they look after.
// Managers already oversee everyone in their company; a support manager sees and approves only their assigned staff's work.
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../db.ts';
import { audit, bad, LONDON_TODAY, notFound, notify, parse, idParam, uuid } from '../http.ts';
import { ACTIVE_APPT, can, need, scope } from '../perm.ts';

export const team = Router();
const name = (a: string) => `coalesce(${a}.preferred_name, ${a}.full_name)`;

// Who can be given staff: a current role whose job role is manager or support manager level, or a manager grant.
const ELIGIBLE_MANAGER = (p: string, c: string) => `(exists (select 1 from appointments ea join job_roles ej on ej.key = ea.job_role_key
     where ea.person_id = ${p} and ea.company_id = ${c} and ${ACTIVE_APPT('ea')} and ej.access_role_key in ('manager', 'support_manager'))
  or exists (select 1 from role_grants g where g.person_id = ${p} and g.company_id = ${c} and g.role_key in ('manager', 'support_manager')
     and g.revoked_at is null and g.valid_from <= now() and (g.expires_at is null or g.expires_at > now())))`;
// Who can be assigned: support staff, meaning a current role at staff level (support workers, seniors, leads, admin) or an old free-text title,
// and no manager or admin grant.
const SUPPORT_STAFF = (p: string, c: string) => `exists (select 1 from appointments sa2 left join job_roles sj on sj.key = sa2.job_role_key
     where sa2.person_id = ${p} and sa2.company_id = ${c} and ${ACTIVE_APPT('sa2')} and coalesce(sj.access_role_key, 'staff') = 'staff')
  and not exists (select 1 from role_grants sg where sg.person_id = ${p} and (sg.company_id = ${c} or sg.company_id is null) and sg.revoked_at is null
     and (sg.expires_at is null or sg.expires_at > now()) and sg.role_key in ('super_admin', 'company_admin', 'hr_admin', 'manager', 'support_manager'))`;

team.get('/team', async (req, res) => {
  const a = req.access;
  const mine = scope(a, null, req.query.company);
  // My team, with what is waiting on each person.
  const members = await q(`select s.id as assignment_id, s.company_id, co.code as company_code, co.name as company_name, p.id, ${name('p')} as name, p.full_name,
         p.photo_path is not null as has_photo,
         (select string_agg(ap.job_title, ', ') from appointments ap where ap.person_id = p.id and ap.company_id = s.company_id and ${ACTIVE_APPT('ap')}) as job_title,
         (select count(*) from visits v where v.person_id = p.id and v.company_id = s.company_id and v.status = 'submitted')::int as visits_to_review,
         ((select count(*) from timesheets t where t.person_id = p.id and t.company_id = s.company_id and t.status = 'submitted')
          + (select count(*) from time_entries t where t.person_id = p.id and t.company_id = s.company_id and t.status = 'submitted'))::int as time_to_review,
         (select count(*) from leave_requests l where l.person_id = p.id and l.company_id = s.company_id and l.status = 'requested')::int as leave_to_decide,
         (select count(*) from tasks t where t.owner_id = p.id and t.company_id = s.company_id and t.status <> 'completed')::int as open_tasks,
         (select count(*) from tasks t where t.owner_id = p.id and t.company_id = s.company_id and t.status in ('not_started','in_progress') and t.due_on < ${LONDON_TODAY})::int as overdue_tasks,
         (select count(*) from training_matrix(${LONDON_TODAY}) m where m.person_id = p.id and m.company_id = s.company_id and m.status = 'overdue')::int as training_overdue,
         exists (select 1 from leave_requests l where l.person_id = p.id and l.status = 'approved' and ${LONDON_TODAY} between l.start_date and l.end_date) as away
    from staff_assignments s join people p on p.id = s.person_id join companies co on co.id = s.company_id
   where s.manager_id = $1 and s.ended_at is null and s.company_id = any($2::uuid[]) and p.status <> 'left'
   order by co.name, p.full_name`, [a.personId, mine]);
  // People who manage me.
  const managedBy = await q(`select ${name('m')} as name, m.id, co.code as company_code from staff_assignments s join people m on m.id = s.manager_id join companies co on co.id = s.company_id
    where s.person_id = $1 and s.ended_at is null order by co.code, m.full_name`, [a.personId]);
  // Assignment board for people who can assign.
  const assignable = scope(a, 'staff.assign', req.query.company);
  const managers = assignable.length ? await q(`select ap.company_id, co.code as company_code, co.name as company_name, p.id, ${name('p')} as name,
         (select string_agg(x.job_title, ', ') from appointments x where x.person_id = p.id and x.company_id = ap.company_id and ${ACTIVE_APPT('x')}) as job_title,
         coalesce((select json_agg(json_build_object('assignment_id', s.id, 'id', sp.id, 'name', ${name('sp')}) order by sp.full_name)
                     from staff_assignments s join people sp on sp.id = s.person_id where s.manager_id = p.id and s.company_id = ap.company_id and s.ended_at is null and sp.status <> 'left'), '[]') as staff
    from (select distinct a2.person_id, a2.company_id from appointments a2 where a2.company_id = any($1::uuid[]) and ${ACTIVE_APPT('a2')}
          union select g.person_id, g.company_id from role_grants g where g.company_id = any($1::uuid[]) and g.role_key in ('manager','support_manager') and g.revoked_at is null) ap
    join people p on p.id = ap.person_id join companies co on co.id = ap.company_id
   where p.status <> 'left' and ${ELIGIBLE_MANAGER('p.id', 'ap.company_id')}
   order by co.name, p.full_name`, [assignable]) : [];
  const staff = assignable.length ? await q(`select distinct on (ap.company_id, p.id) ap.company_id, p.id, ${name('p')} as name, p.full_name, ap.job_title
    from appointments ap join people p on p.id = ap.person_id
   where ap.company_id = any($1::uuid[]) and ${ACTIVE_APPT('ap')} and p.status <> 'left' and ${SUPPORT_STAFF('p.id', 'ap.company_id')}
   order by ap.company_id, p.id, p.full_name`, [assignable]) : [];
  res.json({ members, managedBy, managers, staff, canAssign: assignable });
});

team.post('/staff-assignments', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, manager_id: uuid, person_ids: z.array(uuid).min(1).max(100) }), req.body);
  need(req.access, 'staff.assign', b.company_id);
  if (!(await one(`select 1 where ${ELIGIBLE_MANAGER('$1', '$2')}`, [b.manager_id, b.company_id])))
    throw bad('Choose a manager or support manager who currently works for this company.', { fields: { manager_id: 'Not a current manager or support manager here' } });
  const added = await tx(async (db) => {
    const out: string[] = [];
    for (const pid of new Set(b.person_ids)) {
      if (pid === b.manager_id) throw bad('Someone cannot be assigned to themselves.');
      if (!(await one(`select 1 where ${SUPPORT_STAFF('$1', '$2')}`, [pid, b.company_id], db)))
        throw bad('Only current support staff in this company can be assigned.', { fields: { person_ids: 'Includes someone who is not current support staff here' } });
      const r = await one(`insert into staff_assignments (company_id, manager_id, person_id, assigned_by) values ($1,$2,$3,$4) on conflict do nothing returning id`,
        [b.company_id, b.manager_id, pid, req.person.id], db);
      if (r) { out.push(pid); await audit(db, req.person.id, b.company_id, 'staff_assignment', r.id, 'assign', { manager_id: b.manager_id, person_id: pid }); }
    }
    if (out.length) await notify(db, b.manager_id, b.company_id, out.length === 1 ? 'A member of staff has been assigned to you' : `${out.length} members of staff have been assigned to you`, '/team');
    return out;
  });
  res.status(201).json({ added });
});

team.post('/staff-assignments/:id/end', async (req, res) => {
  const s = await one('select * from staff_assignments where id = $1 and ended_at is null', [idParam(req.params.id)]);
  if (!s || !can(req.access, 'staff.assign', s.company_id)) throw notFound();
  await tx(async (db) => {
    await q('update staff_assignments set ended_at = now(), ended_by = $2 where id = $1', [s.id, req.person.id], db);
    await audit(db, req.person.id, s.company_id, 'staff_assignment', s.id, 'end', { manager_id: s.manager_id, person_id: s.person_id });
  });
  res.json({ ok: true });
});

