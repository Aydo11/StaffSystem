-- Repairs: a "Repairs manager" area, a task for each repair, and KPIs for how fast repairs and complaints are resolved.
alter table governance_leads drop constraint governance_leads_area_check;
alter table governance_leads add constraint governance_leads_area_check check (area in ('staffing','quality','safeguarding_oversight','property_safety','complaints_oversight','repairs','finance','data_protection'));

-- Each new repair becomes a task for the repairs manager; closing the repair (verified) completes the task.
alter table repairs add column task_id uuid references tasks;

alter table kpi_definitions drop constraint kpi_definitions_key_check;
alter table kpi_definitions add constraint kpi_definitions_key_check check (key in ('approved_hours','on_time_starts','visit_coverage','tasks_on_time','clearance','supervision_on_time','development_actions','coaching_hours','training_current','repairs_on_time','complaints_on_time'));
insert into kpi_definitions (key, version, title, purpose, formula, sources, unit, direction, target, min_data, owner, limitations, next_step, effective_from) values
 ('repairs_on_time', 1, 'Repairs fixed on time', 'Shows how quickly reported repairs are fixed against their urgency (emergency 1 day, urgent 7 days, routine 28 days).',
  'Repairs due in the month whose work was completed on or before the due date ÷ repairs due in the month that are completed or already overdue.', 'Repairs', 'percent', 'higher', 90, 3, 'Repairs manager',
  'Counts the date the work was marked complete, not when it was verified. Repairs waiting on parts or contractors are not separated out.', 'Look at overdue repairs by property and contractor, and agree realistic due dates or a faster contractor.', '2025-01-01'),
 ('complaints_on_time', 1, 'Complaints resolved on time', 'Shows whether complaints are investigated and resolved within 10 days.',
  'Complaints whose task was due in the month and completed on or before the due date ÷ complaints due in the month that are resolved or already overdue.', 'Property complaints and their tasks', 'percent', 'higher', 90, 3, 'Complaints manager',
  'Resolution is when the complaints manager completes the task. The complainant''s satisfaction is not recorded.', 'Review open complaints weekly and agree who will respond and by when.', '2025-01-01');
