-- Valor Housing complaints and repairs, 26 October to 11 November 2026 (21 complaints, 21 repairs, all closed), added on
-- 11 Nov 2026 at the owner's request from Valor_Housing_Sample_Registers.xlsx. The owner confirmed the workbook was built
-- from a template, that its "sample", "fictional" and "illustrative" labels are left over from it, and that the cases,
-- dates and staff named are real. The template's S-C/S-R references are kept only in a timeline note (never added twice).
-- The owner confirmed "5 Shakespeare Crescent" (code VERIFY) is 5 Shakespear Crescent, VH-SHA005.
-- Staff are matched to Hub people by name (full or preferred name, else first name and surname initial when only one
-- person fits); anyone not matched is still named in the text. Complaints: owner = Stage 1 owner, logged by whoever
-- received it, Stage 2 cases escalated with the reviewer recorded. Repairs: assigned to the repair coordinator, with
-- attended and completed updates. The workbook's "example evidence" column is not imported: no evidence is attached.
-- Closed repairs are not marked verified in the Hub, as with the earlier register import (043).
create or replace function pg_temp.staff(n text) returns uuid language sql stable as $$
  with exact as (select id from people where lower(full_name) = lower(trim(n)) or lower(preferred_name) = lower(trim(n))),
       loose as (select id from people
                  where (lower(split_part(full_name, ' ', 1)) = lower(split_part(trim(n), ' ', 1)) or lower(preferred_name) = lower(split_part(trim(n), ' ', 1)))
                    and lower(full_name) like '% ' || lower(left(split_part(trim(n), ' ', 2), 1)) || '%')
  select case when (select count(*) from exact) = 1 then (select id from exact)
              when (select count(*) from exact) = 0 and (select count(*) from loose) = 1 then (select id from loose) end
$$;

do $$
declare co uuid; who uuid; r record; pid uuid; cid uuid; rid uuid; owner uuid; recv uuid; coord uuid; t_open timestamptz; t_done timestamptz;
begin
  select id into co from companies where code = 'VH';
  select person_id into who from role_grants where role_key = 'super_admin' order by valid_from limit 1;
  if co is null or who is null then return; end if;

  for r in select * from (values
    ('S-C-001', 'VH-ARTHUR-6', date '2026-10-26', date '2026-10-26', 'Stage 1', 'Bash C', 'Yvan Ruronona', null, 'Cleaning rota unclear', null, null, null, date '2026-10-28', date '2026-10-30', 'Upheld', 'Posted a dated rota and explained who handles missed cleaning.', 'cleanliness', 'property'),
    ('S-C-002', 'VH-CHERRY-82', date '2026-10-27', date '2026-10-28', 'Stage 1', 'Miraj Ali', 'Marc Ganza', null, 'No update on an appointment', null, null, null, date '2026-10-29', date '2026-11-02', 'Upheld', 'Agreed a named contact and confirmed the revised slot in writing.', 'communication', 'support'),
    ('S-C-003', 'VH-CHURCH-32', date '2026-10-28', date '2026-10-29', 'Stage 2', 'Baboucarr Cham', 'Petrina Morgan', 'Ayden Yafai', 'Unclear laundry access times', date '2026-11-02', date '2026-11-03', date '2026-11-03', date '2026-10-30', date '2026-11-05', 'Partly upheld', 'Reviewed shared access and posted the agreed times.', 'service', 'property'),
    ('S-C-004', 'VH-CLARENCE-11', date '2026-10-29', date '2026-10-29', 'Stage 1', 'Daniel Wasowicz', 'Do Kieu', null, 'Missed callback about communal cleaning', null, null, null, date '2026-11-02', date '2026-11-04', 'Upheld', 'Acknowledged the missed call and introduced a callback reminder.', 'communication', 'property'),
    ('S-C-005', 'VH-CROMPTON-33', date '2026-10-30', date '2026-11-02', 'Stage 1', 'Bash C', 'Phil Smith', null, 'Unclear recycling arrangements', null, null, null, date '2026-11-03', date '2026-11-05', 'Upheld', 'Issued a bin guide and added labels to the containers.', 'cleanliness', 'property'),
    ('S-C-006', 'VH-DAVEY-96', date '2026-11-02', date '2026-11-03', 'Stage 1', 'Miraj Ali', 'Yvan Ruronona', null, 'Contractor arrival window was too broad', null, null, null, date '2026-11-04', date '2026-11-06', 'Upheld', 'Agreed a shorter window and an arrival call for future visits.', 'communication', 'repairs'),
    ('S-C-007', 'VH-FARMER-52', date '2026-11-03', date '2026-11-03', 'Stage 1', 'Bash C', 'Marc Ganza', null, 'Support visit rearranged at short notice', null, null, null, date '2026-11-05', date '2026-11-09', 'Partly upheld', 'Agreed a preferred contact method and confirmed a replacement visit.', 'service', 'support'),
    ('S-C-008', 'VH-FOXWELL-8', date '2026-11-04', date '2026-11-05', 'Stage 1', 'Yvan Ruronona', 'Petrina Morgan', null, 'Repair update was difficult to understand', null, null, null, date '2026-11-06', date '2026-11-10', 'Upheld', 'Sent a plain-English update with the appointment and next step.', 'communication', 'repairs'),
    ('S-C-009', 'VH-GROVE-119', date '2026-11-05', date '2026-11-06', 'Stage 1', 'Phil Smith', 'Do Kieu', null, 'Communal fridge shelf allocations unclear', null, null, null, date '2026-11-09', date '2026-11-10', 'Upheld', 'Introduced shelf labels and discussed the revised arrangement.', 'cleanliness', 'property'),
    ('S-C-010', 'VH-HAGLEY-179A', date '2026-10-26', date '2026-10-26', 'Stage 2', 'Petrina Morgan', 'Phil Smith', 'Ayden Yafai', 'Visitor arrangements explained inconsistently', date '2026-10-29', date '2026-10-30', date '2026-10-30', date '2026-10-28', date '2026-11-03', 'Upheld', 'Clarified the house guidance and shared a written copy.', 'service', 'support'),
    ('S-C-011', 'VH-HOLLIDAY-106', date '2026-10-27', date '2026-10-28', 'Stage 1', 'Do Kieu', 'Yvan Ruronona', null, 'No confirmation after reporting a fault', null, null, null, date '2026-10-29', date '2026-11-02', 'Partly upheld', 'Confirmed receipt and agreed when the resident would hear again.', 'communication', 'repairs'),
    ('S-C-012', 'VH-JAC1', date '2026-10-28', date '2026-10-29', 'Stage 1', 'Marc Ganza', 'Marc Ganza', null, 'Appointment reminder sent by the wrong method', null, null, null, date '2026-10-30', date '2026-11-03', 'Upheld', 'Updated contact preference and confirmed the next reminder by text.', 'communication', 'support'),
    ('S-C-013', 'VH-JAC2', date '2026-10-29', date '2026-10-29', 'Stage 1', 'Ayden Yafai', 'Petrina Morgan', null, 'Waste collection instructions unclear', null, null, null, date '2026-11-02', date '2026-11-04', 'Upheld', 'Provided collection days and a location guide.', 'cleanliness', 'property'),
    ('S-C-014', 'VH-LUDLOW-37', date '2026-10-30', date '2026-11-02', 'Stage 1', 'Natalie Clark', 'Do Kieu', null, 'Cleaning supplies ran out between checks', null, null, null, date '2026-11-03', date '2026-11-05', 'Upheld', 'Restocked supplies and assigned a weekly check.', 'cleanliness', 'property'),
    ('S-C-015', 'VH-MURDOCK-62', date '2026-11-02', date '2026-11-03', 'Stage 1', 'Florent Kenmegne', 'Phil Smith', null, 'Resident reported late evening communal noise', null, null, null, date '2026-11-04', date '2026-11-06', 'Partly upheld', 'Reviewed the report and agreed a reminder and follow-up contact.', 'noise', 'support'),
    ('S-C-016', 'VH-OXHILL-203', date '2026-11-03', date '2026-11-03', 'Stage 1', 'Baboucarr Cham', 'Yvan Ruronona', null, 'Support session time conflicted with an appointment', null, null, null, date '2026-11-05', date '2026-11-09', 'Upheld', 'Agreed a suitable time and updated the schedule.', 'service', 'support'),
    ('S-C-017', 'VH-RICKYARD-26', date '2026-11-04', date '2026-11-05', 'Stage 1', 'Do Kieu', 'Marc Ganza', null, 'Update on a cleaning issue took too long', null, null, null, date '2026-11-06', date '2026-11-10', 'Upheld', 'Confirmed the revised routine and agreed a named contact.', 'communication', 'property'),
    ('S-C-018', 'VH-SHA005', date '2026-11-05', date '2026-11-06', 'Stage 1', 'Elina Veismane', 'Petrina Morgan', null, 'Communal supplies storage unclear', null, null, null, date '2026-11-09', date '2026-11-10', 'Upheld', 'Labelled the storage area and explained the replenishment process.', 'cleanliness', 'property'),
    ('S-C-019', 'VH-SHELDON-177', date '2026-10-26', date '2026-10-26', 'Stage 2', 'Miraj Ali', 'Do Kieu', 'Ayden Yafai', 'Resident unhappy with a missed visit update', date '2026-10-29', date '2026-10-30', date '2026-10-30', date '2026-10-28', date '2026-11-03', 'Partly upheld', 'Acknowledged the missed update and agreed an alternative contact route.', 'communication', 'support'),
    ('S-C-020', 'VH-WEST-227', date '2026-10-27', date '2026-10-28', 'Stage 1', 'Bash C', 'Phil Smith', null, 'Appointment outcome was unclear', null, null, null, date '2026-10-29', date '2026-11-02', 'Upheld', 'Confirmed completed and outstanding items in a written update.', 'communication', 'repairs'),
    ('S-C-021', 'VH-SHA005', date '2026-10-28', date '2026-10-29', 'Stage 1', 'Yvan Ruronona', 'Yvan Ruronona', null, 'Request for a written response after a verbal discussion', null, null, null, date '2026-10-30', date '2026-11-03', 'Upheld', 'Provided a written summary and confirmed the preferred contact route.', 'communication', 'support')
  ) t(ref, pref, received, acked, final_stage, received_by, owner_name, reviewer, issue, esc_req, s2_ack, s2_assigned, s1_response, resolved, decision, conclusion, category, dept)
  loop
    continue when exists (select 1 from complaint_events e join property_complaints c on c.id = e.complaint_id
                           where c.company_id = co and e.body like '%(register ref ' || r.ref || ')%');
    pid := (select id from properties where company_id = co and ref = r.pref);
    owner := pg_temp.staff(r.owner_name);
    recv := pg_temp.staff(r.received_by);
    t_open := (r.received + time '09:00') at time zone 'Europe/London';
    t_done := (r.resolved + time '17:00') at time zone 'Europe/London';
    insert into property_complaints (company_id, property_id, raised_by, source, category, summary, title, department, priority, stage, owner_id,
                                     resolution, resolved_at, closed_at, escalated, escalation_reason, created_at, updated_at)
    values (co, pid, coalesce(recv, who), 'resident', r.category,
            'Resident complaint: ' || lower(left(r.issue, 1)) || substr(r.issue, 2) || '. Received by ' || r.received_by || '; Stage 1 owner ' || r.owner_name
              || case when r.reviewer is not null then '; Stage 2 review by ' || r.reviewer else '' end || '.',
            r.issue, r.dept, case when r.final_stage = 'Stage 2' then 'medium' else 'low' end, 'closed', owner,
            r.decision || '. ' || r.conclusion || ' Outcome given to the resident in writing on ' || to_char(r.resolved, 'FMDD Mon YYYY') || '.',
            t_done, t_done, r.final_stage = 'Stage 2',
            case when r.final_stage = 'Stage 2' then 'Resident asked for a Stage 2 review on ' || to_char(r.esc_req, 'FMDD Mon YYYY') || '.' end,
            t_open, t_done)
    returning id into cid;
    insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at) values
      (cid, coalesce(recv, who), 'created', 'Complaint received by ' || r.received_by || '.', '{}', t_open),
      (cid, coalesce(owner, who), 'note', 'Acknowledged at Stage 1.', '{}', (r.acked + time '10:00') at time zone 'Europe/London'),
      (cid, who, 'assigned', 'Stage 1 owner: ' || r.owner_name || '.', jsonb_build_object('to', owner), (r.acked + time '10:05') at time zone 'Europe/London'),
      (cid, coalesce(owner, who), 'note', 'Stage 1 response given.', '{}', (r.s1_response + time '15:00') at time zone 'Europe/London');
    if r.final_stage = 'Stage 2' then
      insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at) values
        (cid, who, 'escalated', 'Resident asked for a Stage 2 review.', '{}', (r.esc_req + time '11:00') at time zone 'Europe/London'),
        (cid, coalesce(pg_temp.staff(r.reviewer), who), 'note', 'Stage 2 acknowledged; reviewer ' || r.reviewer || '.', jsonb_build_object('reviewer', pg_temp.staff(r.reviewer)),
         (r.s2_ack + time '11:00') at time zone 'Europe/London');
    end if;
    insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at) values
      (cid, coalesce(case when r.final_stage = 'Stage 2' then pg_temp.staff(r.reviewer) end, owner, who), 'stage',
       r.decision || '. ' || r.conclusion, jsonb_build_object('from', 'new', 'to', 'closed'), t_done),
      (cid, who, 'note', 'Added to the Hub on 11 Nov 2026 from Valor''s complaints and repairs register (register ref ' || r.ref || '). '
         || 'The owner confirmed the template''s sample labels were left in by mistake and this case is real.', '{}', now());
  end loop;

  for r in select * from (values
    ('S-R-001', 'VH-ARTHUR-6', date '2026-10-26', 'routine', 'Bash C', 'Kitchen cupboard hinge loose', date '2026-10-29', date '2026-10-27', date '2026-10-27', 'Replaced hinge and tested the door.', 'furniture', 'Kitchen'),
    ('S-R-002', 'VH-CHERRY-82', date '2026-10-27', 'routine', 'Miraj Ali', 'Bathroom extractor weak', date '2026-10-30', date '2026-10-28', date '2026-10-29', 'Cleared the vent and verified airflow.', 'electrical', 'Bathroom'),
    ('S-R-003', 'VH-CHURCH-32', date '2026-10-28', 'routine', 'Yvan Ruronona', 'Laundry door handle loose', date '2026-11-02', date '2026-10-29', date '2026-11-02', 'Secured handle and checked latch operation.', 'doors', 'Laundry'),
    ('S-R-004', 'VH-CLARENCE-11', date '2026-10-29', 'routine', 'Florent Kenmegne', 'Hallway lamp flickering', date '2026-11-03', date '2026-10-30', date '2026-10-30', 'Replaced failed lamp and tested the fitting.', 'electrical', 'Hallway'),
    ('S-R-005', 'VH-CROMPTON-33', date '2026-10-30', 'routine', 'Bash C', 'Kitchen drawer runners sticking', date '2026-11-04', date '2026-11-02', date '2026-11-03', 'Adjusted runners and checked smooth travel.', 'furniture', 'Kitchen'),
    ('S-R-006', 'VH-DAVEY-96', date '2026-11-02', 'routine', 'Florent Kenmegne', 'Basin waste dripping', date '2026-11-05', date '2026-11-03', date '2026-11-05', 'Replaced washer and checked for leaks under flow.', 'plumbing', 'Bathroom'),
    ('S-R-007', 'VH-FARMER-52', date '2026-11-03', 'routine', 'Yvan Ruronona', 'Bedroom blind cord damaged', date '2026-11-06', date '2026-11-04', date '2026-11-04', 'Fitted a suitable replacement blind and checked safe operation.', 'furniture', 'Bedroom'),
    ('S-R-008', 'VH-FOXWELL-8', date '2026-11-04', 'urgent', 'Florent Kenmegne', 'Communal cupboard catch sticking', date '2026-11-05', date '2026-11-04', date '2026-11-05', 'Adjusted the catch and tested the door.', 'communal', 'Communal area'),
    ('S-R-009', 'VH-GROVE-119', date '2026-11-05', 'routine', 'Yvan Ruronona', 'Loose kitchen tap handle', date '2026-11-10', date '2026-11-06', date '2026-11-10', 'Secured the handle and tested hot and cold flow.', 'plumbing', 'Kitchen'),
    ('S-R-010', 'VH-HAGLEY-179A', date '2026-11-06', 'routine', 'Florent Kenmegne', 'Shower hose leaking at fitting', date '2026-11-11', date '2026-11-09', date '2026-11-09', 'Replaced the hose and tested at normal pressure.', 'plumbing', 'Bathroom'),
    ('S-R-011', 'VH-HOLLIDAY-106', date '2026-10-26', 'routine', 'Yvan Ruronona', 'Bathroom basin draining slowly', date '2026-10-29', date '2026-10-27', date '2026-10-28', 'Cleared waste trap and verified free drainage.', 'plumbing', 'Bathroom'),
    ('S-R-012', 'VH-JAC1', date '2026-10-27', 'routine', 'Florent Kenmegne', 'Kitchen kickboard loose', date '2026-10-30', date '2026-10-28', date '2026-10-30', 'Refitted kickboard clips and checked stability.', 'furniture', 'Kitchen'),
    ('S-R-013', 'VH-JAC2', date '2026-10-28', 'routine', 'Yvan Ruronona', 'Toilet cistern refilling slowly', date '2026-11-02', date '2026-10-29', date '2026-10-29', 'Replaced the fill valve and verified repeat flushes.', 'plumbing', 'Bathroom'),
    ('S-R-014', 'VH-LUDLOW-37', date '2026-10-29', 'routine', 'Florent Kenmegne', 'Bathroom cabinet catch loose', date '2026-11-03', date '2026-10-30', date '2026-11-02', 'Replaced catch and tested closure.', 'furniture', 'Bathroom'),
    ('S-R-015', 'VH-MURDOCK-62', date '2026-10-30', 'urgent', 'Yvan Ruronona', 'Radiator in one bedroom cool while others work', date '2026-11-02', date '2026-10-30', date '2026-11-02', 'Attended and restored heat, then verified the radiator warmed up.', 'heating', 'Bedroom'),
    ('S-R-016', 'VH-OXHILL-203', date '2026-11-02', 'urgent', 'Florent Kenmegne', 'Shower screen seal leaking onto floor', date '2026-11-03', date '2026-11-02', date '2026-11-03', 'Replaced seal and checked the floor stayed dry during testing.', 'plumbing', 'Bathroom'),
    ('S-R-017', 'VH-RICKYARD-26', date '2026-11-03', 'routine', 'Do Kieu', 'Kitchen sink plug assembly faulty', date '2026-11-06', date '2026-11-04', date '2026-11-05', 'Replaced assembly and checked the sink held and drained water.', 'plumbing', 'Kitchen'),
    ('S-R-018', 'VH-SHA005', date '2026-11-04', 'routine', 'Florent Kenmegne', 'Internal wardrobe hinge loose', date '2026-11-09', date '2026-11-05', date '2026-11-09', 'Refixed hinge and checked the door alignment.', 'furniture', 'Bedroom'),
    ('S-R-019', 'VH-SHELDON-177', date '2026-11-05', 'routine', 'Yvan Ruronona', 'WC handle loose', date '2026-11-10', date '2026-11-06', date '2026-11-06', 'Refitted and tested the handle and flush.', 'plumbing', 'Bathroom'),
    ('S-R-020', 'VH-WEST-227', date '2026-11-06', 'routine', 'Florent Kenmegne', 'Communal kitchen splashback seal lifting', date '2026-11-11', date '2026-11-09', date '2026-11-10', 'Renewed sealant and checked the finished joint.', 'general', 'Communal kitchen'),
    ('S-R-021', 'VH-SHA005', date '2026-10-26', 'routine', 'Yvan Ruronona', 'Bedroom curtain track bracket loose', date '2026-10-29', date '2026-10-27', date '2026-10-29', 'Refixed the bracket and tested curtain travel.', 'furniture', 'Bedroom')
  ) t(ref, pref, reported, urgency, coord_name, fault, target, attended, resolved, conclusion, category, location)
  loop
    pid := (select id from properties where company_id = co and ref = r.pref);
    continue when pid is null or exists (select 1 from repairs where property_id = pid and title = r.fault and reported_on = r.reported);
    coord := pg_temp.staff(r.coord_name);
    t_done := (r.resolved + time '17:00') at time zone 'Europe/London';
    insert into repairs (company_id, property_id, title, description, urgency, status, assignee_id, due_on, completed_on, closed_at, reported_by, reported_on,
                         category, location, work_description, contractor_attended, notes, created_at, updated_at)
    values (co, pid, r.fault, r.fault || '. Repair coordinator: ' || r.coord_name || '.', r.urgency, 'closed', coord, r.target, r.resolved, t_done, who, r.reported,
            r.category, r.location, r.conclusion, true,
            'Added on 11 Nov 2026 from Valor''s complaints and repairs register (register ref ' || r.ref || '); the owner confirmed the template''s sample labels '
              || 'were left in by mistake and this repair is real. Recorded there as completed, verified and the resident updated; not verified in the Hub.',
            (r.reported + time '09:00') at time zone 'Europe/London', t_done)
    returning id into rid;
    insert into repair_updates (repair_id, author_id, body, status_from, status_to, created_at) values
      (rid, who, 'Assigned to ' || r.coord_name || ' to coordinate.', 'reported', 'assigned', (r.reported + time '09:30') at time zone 'Europe/London'),
      (rid, coalesce(coord, who), 'Attended.', 'assigned', 'in_progress', (r.attended + time '12:00') at time zone 'Europe/London'),
      (rid, coalesce(coord, who), r.conclusion, 'in_progress', 'completed', (r.resolved + time '16:00') at time zone 'Europe/London'),
      (rid, who, 'Closed: completion checked and the resident updated.', 'completed', 'closed', t_done);
  end loop;
end $$;
