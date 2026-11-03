-- Complaints from Valor's KPI operations tracker received from 1 August 2026 (owner request, 3 Nov 2026), with the
-- tracker's own dates, stages and outcomes. Tenant references are left out (resident data stays out of the Hub). The
-- tracker's property codes (VH-HW01 etc.) do not match the Hub's property register yet, so the cases are not linked
-- to a property; the code is kept in the summary so they can be linked later. Logged by the first super administrator.
-- Skipped on a database without Valor Housing or a super administrator, and never imported twice.
do $$
declare co uuid; who uuid; lead uuid; r record; cid uuid;
begin
  select id into co from companies where code = 'VH';
  select person_id into who from role_grants where role_key = 'super_admin' order by valid_from limit 1;
  if co is null or who is null then return; end if;
  -- The open case goes to the complaints lead (Governance → Accountability), if one is set.
  select person_id into lead from governance_leads where company_id = co and area = 'complaints_oversight' and to_date is null order by role = 'deputy', created_at limit 1;
  for r in select * from (values
    ('C-26-017', date '2026-08-04', 'VH-HW01', 'cleanliness',   'property', 'Stage 1', 'Shared kitchen left dirty by others',     date '2026-08-10', date '2026-08-18', 'Upheld',           'Yes',         'No further action'),
    ('C-26-018', date '2026-08-07', 'VH-HW02', 'repairs',       'repairs',  'Stage 1', 'Delay fixing heating',                    date '2026-08-13', date '2026-08-21', 'Upheld',           'No',          'Discussed at team meeting'),
    ('C-26-019', date '2026-08-20', 'VH-HW01', 'repairs',       'repairs',  'Stage 1', 'Delay fixing heating',                    date '2026-08-27', date '2026-09-03', 'Partially upheld', 'Yes',         'Contractor reminded of appointment SLA'),
    ('C-26-020', date '2026-09-12', 'VH-WG01', 'staff_conduct', 'hr',       'Stage 1', 'Felt spoken to rudely by staff member',   date '2026-09-15', date '2026-09-25', 'Partially upheld', 'Yes',         'Contractor reminded of appointment SLA'),
    ('C-26-021', date '2026-09-22', 'VH-WG01', 'repairs',       'repairs',  'Stage 1', 'Delay fixing heating',                    date '2026-09-24', date '2026-10-06', 'Partially upheld', 'Yes',         'Discussed at team meeting'),
    ('C-26-022', date '2026-10-05', 'VH-HW01', 'noise',         'support',  'Stage 2', 'Noise from another resident',             null,              date '2026-11-02', null,               null,          null)
  ) t(tref, received, pcode, category, dept, tstage, summary, resolved, due, outcome, satisfied, learning)
  loop
    continue when exists (select 1 from property_complaints where company_id = co and title like '%(' || r.tref || ')');
    insert into property_complaints (company_id, property_id, raised_by, owner_id, source, category, summary, title, department, priority, due_on, stage, escalated, escalation_reason,
                                     resolution, resolved_at, created_at, updated_at)
    values (co, null, who, case when r.resolved is null then lead end, 'resident', r.category,
            r.summary || '. Imported from the KPI operations tracker: ref ' || r.tref || ', property code ' || r.pcode || ', ' || r.tstage || '.',
            r.summary || ' (' || r.tref || ')', r.dept, case when r.tstage = 'Stage 2' then 'high' else 'medium' end, r.due,
            case when r.resolved is null then 'in_progress' else 'resolved' end,
            r.tstage = 'Stage 2', case when r.tstage = 'Stage 2' then 'Stage 2 complaint in the KPI tracker.' end,
            case when r.resolved is not null then 'Outcome: ' || r.outcome || '. Satisfied with handling: ' || r.satisfied || '. Learning / action: ' || r.learning || '.' end,
            r.resolved::timestamptz + interval '12 hours', r.received::timestamptz + interval '12 hours', coalesce(r.resolved, r.received)::timestamptz + interval '12 hours')
    returning id into cid;
    insert into complaint_events (complaint_id, actor_id, kind, body, created_at) values (cid, who, 'created', 'Imported from the KPI operations tracker (' || r.tref || ').', r.received::timestamptz + interval '12 hours');
    if r.resolved is not null then
      insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at)
      values (cid, who, 'stage', 'Resolved: ' || r.outcome || '.', jsonb_build_object('to', 'resolved'), r.resolved::timestamptz + interval '12 hours');
    end if;
  end loop;
end $$;
