-- Valor supervisions held in August and October 2026 and kept on paper, recorded afterwards at the owner's request (1 Nov 2026).
-- The owner confirmed they took place: Phil Smith supervised the support workers and Ayden Yafai the managers.
-- Exact dates were not on the Hub, so they are set to the 8-weekly Monday cycle (17 Aug, 12 Oct) and each record says so.
-- No-op where the people are not present (for example a test database).
insert into supervisions (company_id, person_id, supervisor_id, kind, held_on, minutes, agenda, shared_notes, next_due, status, created_at, updated_at)
select c.id, p.id, s.id, 'supervision', v.held_on, 60,
       'Support delivered, using RM Solutions and online tools well, issues and difficulties.',
       'Recorded afterwards from paper notes; the date follows the 8-weekly Monday cycle. Covered: using RM Solutions and the internet to give higher-quality support, and any issues the staff member was finding.',
       v.held_on + 56, 'completed', now(), now()
from (values
  ('483f8b03-1527-4f94-ae30-23a652cc4974'::uuid, 'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa'::uuid), -- Daniel Wasowicz, by Phil Smith
  ('a5be3b35-3856-46ec-b832-9d3caa0eace7', 'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa'),        -- Baboucarr Cham, by Phil Smith
  ('6f17249f-6159-472f-91c2-d8487c5d309f', 'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa'),        -- Marc Ganza, by Phil Smith
  ('aed4a65d-ddfc-4a0d-99f0-4476fd0778aa', 'c5bb0ccc-ad78-45cf-9cfc-9ad654056038'),        -- Phil Smith, by Ayden Yafai
  ('e63d5643-b191-4eec-82fd-ebf7671d7afb', 'c5bb0ccc-ad78-45cf-9cfc-9ad654056038')         -- Miraj Ali, by Ayden Yafai
) as w(person, sup)
cross join (values (date '2026-08-17'), (date '2026-10-12')) as v(held_on)
join people p on p.id = w.person
join people s on s.id = w.sup
join companies c on c.code = 'VH'
where not exists (select 1 from supervisions x where x.person_id = p.id and x.company_id = c.id and x.held_on = v.held_on);

-- Their next supervision follows the same cycle (Monday 7 December), with Phil holding the support workers'.
update supervisions x set held_on = date '2026-12-07', next_due = date '2027-02-01', updated_at = now(),
       supervisor_id = case when x.person_id in ('483f8b03-1527-4f94-ae30-23a652cc4974', 'a5be3b35-3856-46ec-b832-9d3caa0eace7', '6f17249f-6159-472f-91c2-d8487c5d309f')
                            then 'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa'::uuid else x.supervisor_id end
 where x.status = 'draft' and x.held_on = date '2026-11-09' and x.company_id = (select id from companies where code = 'VH')
   and x.person_id in ('483f8b03-1527-4f94-ae30-23a652cc4974', 'a5be3b35-3856-46ec-b832-9d3caa0eace7', '6f17249f-6159-472f-91c2-d8487c5d309f',
                       'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa', 'e63d5643-b191-4eec-82fd-ebf7671d7afb')
   and exists (select 1 from people where id = 'aed4a65d-ddfc-4a0d-99f0-4476fd0778aa');
