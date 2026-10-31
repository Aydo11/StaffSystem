-- Support hours from August 2026, added from Valor's weekly support schedule at the owner's request (31 Oct 2026).
-- They were not logged one by one (the Hub did not exist yet), so they are their own entry mode, `schedule`:
-- shown as "From the weekly support schedule"; counted in timesheets and KPIs (owner decision), kept out of the monthly pack visit count.
alter table visits drop constraint visits_entry_mode_check;
alter table visits add constraint visits_entry_mode_check check (entry_mode in ('live', 'manual', 'schedule'));

-- Adds the schedule for one person at one Valor property on one weekday (1 = Monday) from p_from to p_to.
-- Safe to run again: each visit has a fixed request id, and a day the person already has a visit, approved leave,
-- or no Valor role is skipped. A person or property not on the Hub is skipped, so it can be re-run once they are added.
create or replace function add_schedule_visits(p_name text, p_ref text, p_dow int, p_minutes int, p_slot int, p_from date, p_to date)
returns int language plpgsql as $$
declare
  person uuid; appt uuid; co uuid; prop uuid; approver uuid; d date; s timestamptz; n int := 0; vid uuid;
begin
  select c.id into co from companies c where c.code = 'VH';
  select p.id into person from people p where lower(p.full_name) = lower(p_name) or lower(p.preferred_name) = lower(p_name) limit 1;
  select pr.id into prop from properties pr where pr.ref = p_ref and pr.company_id = co;
  select a.id into appt from appointments a where a.person_id = person and a.company_id = co order by (a.status = 'ended'), a.start_date limit 1;
  select g.person_id into approver from role_grants g where g.role_key = 'super_admin' and g.revoked_at is null order by g.valid_from limit 1;
  if person is null or prop is null or appt is null then return 0; end if;
  for d in select g::date from generate_series(p_from, p_to, interval '1 day') g where extract(isodow from g) = p_dow loop
    -- Times are not known: the visits for one day are placed one after another from 9:00, and the Hub shows no times for them.
    s := (d + time '09:00')::timestamp at time zone 'Europe/London' + make_interval(mins => p_slot);
    continue when exists (select 1 from leave_requests l where l.person_id = person and l.status = 'approved' and d between l.start_date and l.end_date);
    continue when exists (select 1 from visits v where v.person_id = person and v.entry_mode <> 'schedule' and v.status not in ('cancelled', 'rejected')
                            and (v.started_at at time zone 'Europe/London')::date = d);
    insert into visits (person_id, appointment_id, company_id, property_id, entry_mode, status, started_at, ended_at, work_category, summary,
                        submitted_at, decided_by, decided_at, decision_note, client_request_id)
    values (person, appt, co, prop, 'schedule', 'approved', s, s + make_interval(mins => p_minutes), 'support_work',
            'From the weekly support schedule. Not individually logged; the detailed records are in RM Solutions.',
            now(), approver, now(), 'Added from the weekly support schedule',
            md5('schedule:' || person || ':' || prop || ':' || d)::uuid)
    on conflict (client_request_id) do nothing
    returning id into vid;
    if vid is not null then
      insert into visit_allocations (visit_id, company_id, appointment_id, minutes, allocated_by) values (vid, co, appt, p_minutes, approver);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function add_schedule_visits(text, text, int, int, int, date, date) from public;

-- The schedule as the owner gave it: Tuesday (2) and Thursday (4), hours split evenly across each person's properties;
-- Phillip works 5 hours a day Monday to Friday, one property a day; Daniel 6 hours on Tuesday and 7 on Thursday.
-- Period: 1 August 2026 to 30 October 2026.
select sum(add_schedule_visits(name, ref, dow, minutes, slot, date '2026-08-01', date '2026-10-30'))
from (values
  ('Natalie Clark', 'VH-MURDOCK-62', 2, 180, 0), ('Natalie Clark', 'VH-GROVE-119', 2, 180, 180),
  ('Natalie Clark', 'VH-MURDOCK-62', 4, 180, 0), ('Natalie Clark', 'VH-GROVE-119', 4, 180, 180),
  ('Phil smith', 'VH-CLARENCE-11', 1, 300, 0), ('Phil smith', 'VH-OXHILL-203', 2, 300, 0), ('Phil smith', 'VH-SHELDON-177', 3, 300, 0),
  ('Phil smith', 'VH-FARMER-52', 4, 300, 0), ('Phil smith', 'VH-FOXWELL-8', 5, 300, 0),
  ('Daniel Wasowicz', 'VH-CHURCH-32', 2, 120, 0), ('Daniel Wasowicz', 'VH-JAC1', 2, 120, 120), ('Daniel Wasowicz', 'VH-JAC2', 2, 120, 240),
  ('Daniel Wasowicz', 'VH-CHURCH-32', 4, 140, 0), ('Daniel Wasowicz', 'VH-JAC1', 4, 140, 140), ('Daniel Wasowicz', 'VH-JAC2', 4, 140, 280),
  ('Do Kieu', 'VH-RICKYARD-26', 2, 150, 0), ('Do Kieu', 'VH-RICKYARD-26', 4, 150, 0),
  ('Miraj Ali', 'VH-CHERRY-82', 2, 150, 0), ('Miraj Ali', 'VH-CHERRY-82', 4, 150, 0),
  ('Sunny Johal', 'VH-HOLLIDAY-106', 2, 180, 0), ('Sunny Johal', 'VH-HOLLIDAY-106', 4, 180, 0),
  ('Marc Ganza', 'VH-HAGLEY-179A', 2, 135, 0), ('Marc Ganza', 'VH-SHA005', 2, 135, 135),
  ('Marc Ganza', 'VH-HAGLEY-179A', 4, 135, 0), ('Marc Ganza', 'VH-SHA005', 4, 135, 135),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 2, 130, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 2, 130, 130), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 2, 130, 260),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 4, 130, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 4, 130, 130), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 4, 130, 260),
  ('Thania Begum', 'VH-WEST-227', 2, 120, 0), ('Thania Begum', 'VH-WEST-227', 4, 120, 0),
  ('Elina Veismane', 'VH-LUDLOW-37', 2, 120, 0), ('Elina Veismane', 'VH-LUDLOW-37', 4, 120, 0)
) as t(name, ref, dow, minutes, slot);
