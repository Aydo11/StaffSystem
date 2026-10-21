-- FICTIONAL DEMONSTRATION DATA. Every person and property here is invented.
-- Company legal names are as supplied; numbers, addresses and bank details are left blank until verified.

insert into companies (id, code, name, legal_name, details_verified, brand_primary, brand_accent, support_system_url, help_contact) values
  ('00000000-0000-4000-8000-0000000000c1', 'VH',  'Valor Housing',     'Valor Housing Ltd',     false, '#17324D', '#0E8A7D', null, null),
  ('00000000-0000-4000-8000-0000000000c2', 'WHM', 'Wellbeing Homes',   'Wellbeing Homes Ltd',   false, '#17324D', '#0E8A7D', null, null),
  ('00000000-0000-4000-8000-0000000000c3', 'WHS', 'Wellbeing Housing', 'Wellbeing Housing Ltd', false, '#17324D', '#0E8A7D', null, null);

insert into people (id, email, full_name, preferred_name, staff_ref, professional_summary, skills, languages, status, is_fictional) values
  ('00000000-0000-4000-8000-000000000a01', 'alex.admin@example.test',   'Alex Morgan (fictional)',  'Alex',  'VWH-0001', 'Platform administrator for the demonstration.', '{}', '{English}', 'active', true),
  ('00000000-0000-4000-8000-000000000a02', 'sam.rivers@example.test',   'Sam Rivers (fictional)',   'Sam',   'VWH-0002', 'Property operations worker with experience across inspections, maintenance coordination and key handovers.', '{"Property inspections","Basic maintenance","First aid"}', '{English,Polish}', 'active', true),
  ('00000000-0000-4000-8000-000000000a03', 'priya.shah@example.test',   'Priya Shah (fictional)',   'Priya', 'VWH-0003', 'Operations manager.', '{"Team leadership","Rota planning"}', '{English,Gujarati}', 'active', true),
  ('00000000-0000-4000-8000-000000000a04', 'jordan.lee@example.test',   'Jordan Lee (fictional)',   'Jordan','VWH-0004', 'Property manager.', '{"Property safety"}', '{English}', 'active', true),
  ('00000000-0000-4000-8000-000000000a05', 'morgan.hale@example.test',  'Morgan Hale (fictional)',  'Morgan','VWH-0005', 'HR administrator.', '{"Recruitment","Employment checks"}', '{English}', 'active', true),
  ('00000000-0000-4000-8000-000000000a06', 'casey.brook@example.test',  'Casey Brook (fictional)',  'Casey', 'VWH-0006', 'New starter, onboarding in progress.', '{}', '{English}', 'active', true),
  ('00000000-0000-4000-8000-000000000a07', 'taylor.quinn@example.test', 'Taylor Quinn (fictional)', 'Taylor','VWH-0007', 'Maintenance and cleaning.', '{"Cleaning","Minor repairs"}', '{English,Somali}', 'active', true),
  ('00000000-0000-4000-8000-000000000a08', 'robin.ash@example.test',    'Robin Ash (fictional)',    'Robin', 'VWH-0008', 'Quality and governance lead.', '{"Auditing"}', '{English}', 'active', true);

insert into person_restricted (person_id, personal_phone, home_address, emergency_contact_name, emergency_contact_phone) values
  ('00000000-0000-4000-8000-000000000a02', '07700 900002', '1 Fictional Close, Exampletown', 'Pat Rivers (fictional)', '07700 900102');

insert into qualifications (person_id, title, issuer, awarded_on, verified_by, verified_at) values
  ('00000000-0000-4000-8000-000000000a02', 'Level 2 Certificate in Health and Safety (fictional)', 'Example Awarding Body', '2024-05-10', '00000000-0000-4000-8000-000000000a05', '2025-01-15'),
  ('00000000-0000-4000-8000-000000000a02', 'Emergency First Aid at Work (fictional)', 'Example Training Ltd', '2025-09-01', null, null);

insert into role_grants (person_id, role_key, company_id, granted_by, reason) values
  ('00000000-0000-4000-8000-000000000a01', 'super_admin', null, null, 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a03', 'manager', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a04', 'manager', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a04', 'property_officer', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a05', 'hr_admin', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a05', 'hr_admin', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a05', 'hr_admin', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a08', 'quality_lead', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a08', 'quality_lead', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000a01', 'Demo setup'),
  ('00000000-0000-4000-8000-000000000a08', 'quality_lead', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000a01', 'Demo setup');

-- 17 fictional properties
insert into properties (id, company_id, ref, name, address_line1, city, postcode, status, managing_agent, manager_person_id, room_refs, is_fictional)
select ('00000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       case when n <= 7 then '00000000-0000-4000-8000-0000000000c1'::uuid when n <= 12 then '00000000-0000-4000-8000-0000000000c2'::uuid else '00000000-0000-4000-8000-0000000000c3'::uuid end,
       case when n <= 7 then 'VH-' when n <= 12 then 'WHM-' else 'WHS-' end || lpad(n::text, 3, '0'),
       (array['Alder','Birch','Cedar','Damson','Elm','Fir','Hazel','Juniper','Larch','Maple','Oak','Pine','Rowan','Spruce','Willow','Yew','Aspen'])[n] || ' House',
       n || ' Sample Street (fictional)', 'Exampletown', 'ZZ' || n || ' 1AA',
       case when n = 5 then 'void' when n = 11 then 'under_works' else 'active' end,
       case when n % 3 = 0 then 'Example Lettings Agent (fictional)' else null end,
       case when n <= 7 then '00000000-0000-4000-8000-000000000a03'::uuid else '00000000-0000-4000-8000-000000000a04'::uuid end,
       array['Room A','Room B','Room C'],
       true
from generate_series(1, 17) n;

insert into property_keys (property_id, label, holder_person_id, issued_at) values
  ('00000000-0000-4000-8000-000000000101', 'Front door key set 1', '00000000-0000-4000-8000-000000000a02', now() - interval '30 days'),
  ('00000000-0000-4000-8000-000000000101', 'Front door key set 2', null, null);

-- Appointments. Sam holds one in each company; only one is with the legal employer of the same name.
insert into appointments (id, person_id, company_id, relationship, legal_employer_company_id, legal_employer_name, job_title, responsibilities, manager_person_id, start_date, status, contracted_hours_per_week) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'Property Operations Worker', 'Inspections, key handovers, maintenance reporting.', '00000000-0000-4000-8000-000000000a03', '2025-10-01', 'active', 24),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c2', 'contractor', null, 'Sam Rivers Services (fictional sole trader)', 'Maintenance Contractor', 'Minor repairs at allocated properties.', '00000000-0000-4000-8000-000000000a04', '2026-01-05', 'active', 8),
  ('00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c3', 'secondment', '00000000-0000-4000-8000-0000000000c1', null, 'Property Assistant (secondment)', 'Property checks.', '00000000-0000-4000-8000-000000000a04', '2026-06-01', 'active', 6),
  ('00000000-0000-4000-8000-000000000b04', '00000000-0000-4000-8000-000000000a03', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'Operations Manager', 'Team leadership.', null, '2024-04-01', 'active', 37.5),
  ('00000000-0000-4000-8000-000000000b05', '00000000-0000-4000-8000-000000000a04', '00000000-0000-4000-8000-0000000000c2', 'employee',   '00000000-0000-4000-8000-0000000000c2', null, 'Property Manager', 'Property safety and repairs.', null, '2024-09-01', 'active', 37.5),
  ('00000000-0000-4000-8000-000000000b06', '00000000-0000-4000-8000-000000000a05', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'HR Administrator', 'Recruitment and checks for all three companies.', null, '2024-04-01', 'active', 30),
  ('00000000-0000-4000-8000-000000000b07', '00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'Property Operations Worker', 'Onboarding.', '00000000-0000-4000-8000-000000000a03', '2026-10-12', 'active', 20),
  ('00000000-0000-4000-8000-000000000b08', '00000000-0000-4000-8000-000000000a07', '00000000-0000-4000-8000-0000000000c3', 'agency',     null, 'Example Staffing Agency (fictional)', 'Cleaning Operative', 'Cleaning of communal areas.', '00000000-0000-4000-8000-000000000a04', '2026-03-01', 'active', 15),
  ('00000000-0000-4000-8000-000000000b09', '00000000-0000-4000-8000-000000000a08', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'Quality Lead', 'Assurance across the group.', null, '2025-01-06', 'active', 30),
  ('00000000-0000-4000-8000-000000000b10', '00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000000c1', 'employee',   '00000000-0000-4000-8000-0000000000c1', null, 'Platform Administrator', null, null, '2024-04-01', 'active', 10);

insert into appointment_rates (appointment_id, rate_type, amount, effective_from, effective_to) values
  ('00000000-0000-4000-8000-000000000b01', 'hourly', 12.80, '2025-10-01', '2026-03-31'),
  ('00000000-0000-4000-8000-000000000b01', 'hourly', 13.50, '2026-04-01', null),
  ('00000000-0000-4000-8000-000000000b02', 'hourly', 18.00, '2026-01-05', null),
  ('00000000-0000-4000-8000-000000000b03', 'hourly', 13.50, '2026-06-01', null),
  ('00000000-0000-4000-8000-000000000b07', 'hourly', 13.00, '2026-10-12', null),
  ('00000000-0000-4000-8000-000000000b08', 'hourly', 14.25, '2026-03-01', null);

insert into appointment_properties (appointment_id, property_id, from_date) values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000101', '2025-10-01'),
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000102', '2025-10-01'),
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000103', '2026-02-01'),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000108', '2026-01-05'),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000109', '2026-01-05'),
  ('00000000-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-000000000113', '2026-06-01'),
  ('00000000-0000-4000-8000-000000000b08', '00000000-0000-4000-8000-000000000114', '2026-03-01'),
  ('00000000-0000-4000-8000-000000000b08', '00000000-0000-4000-8000-000000000115', '2026-03-01');

insert into clearance_decisions (person_id, company_id, status, restrictions, evidence_summary, decided_by, decided_at, review_date) values
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c1', 'cleared', null, 'Checks verified by HR.', '00000000-0000-4000-8000-000000000a05', '2025-09-28', '2027-09-28'),
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c2', 'cleared', null, 'Contractor checks verified.', '00000000-0000-4000-8000-000000000a05', '2026-01-02', '2027-01-02'),
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c3', 'cleared_with_restrictions', 'Daytime property checks only until induction complete.', 'Secondment from Valor Housing.', '00000000-0000-4000-8000-000000000a05', '2026-05-28', '2026-11-30'),
  ('00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-0000000000c1', 'pending', null, 'Awaiting references.', '00000000-0000-4000-8000-000000000a05', '2026-10-12', '2026-10-26'),
  ('00000000-0000-4000-8000-000000000a07', '00000000-0000-4000-8000-0000000000c3', 'cleared', null, 'Agency confirmation on file.', '00000000-0000-4000-8000-000000000a05', '2026-02-26', '2027-02-26');

insert into employment_checks (person_id, company_id, check_type, label, status, requested_on, issued_on, verified_on, reviewer_id, follow_up_on, next_review_on, actions) values
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c1', 'dbs', 'Enhanced DBS', 'verified', '2025-09-01', '2025-09-20', '2025-09-25', '00000000-0000-4000-8000-000000000a05', null, '2027-09-25', null),
  ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c1', 'right_to_work', 'Right to work', 'verified', '2025-09-01', null, '2025-09-02', '00000000-0000-4000-8000-000000000a05', null, null, null),
  ('00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-0000000000c1', 'reference', 'Reference 1 — previous employer', 'requested', '2026-10-05', null, null, null, '2026-10-22', null, 'Chase by phone if no reply.'),
  ('00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-0000000000c1', 'dbs', 'Enhanced DBS', 'awaiting_verification', '2026-10-05', '2026-10-15', null, null, '2026-10-21', null, 'Certificate seen; verify on update service.');

-- A few historic visits for Sam (times stored in UTC).
insert into visits (id, person_id, appointment_id, company_id, property_id, entry_mode, status, started_at, ended_at, work_category, summary, submitted_at, decided_by, decided_at) values
  ('00000000-0000-4000-8000-000000000d01', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000101', 'live',   'approved',  '2026-10-12 08:00Z', '2026-10-12 09:30Z', 'inspection', 'Weekly communal area check. Fire doors closing correctly.', '2026-10-12 09:30Z', '00000000-0000-4000-8000-000000000a03', '2026-10-12 12:00Z'),
  ('00000000-0000-4000-8000-000000000d02', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000108', 'manual', 'approved',  '2026-10-13 13:00Z', '2026-10-13 14:00Z', 'maintenance', 'Replaced kitchen cupboard hinge.', '2026-10-13 17:00Z', '00000000-0000-4000-8000-000000000a04', '2026-10-14 09:00Z'),
  ('00000000-0000-4000-8000-000000000d03', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000102', 'live',   'submitted', '2026-10-19 09:00Z', '2026-10-19 09:45Z', 'key_handover', 'Spare key returned to safe.', '2026-10-19 09:45Z', null, null);
insert into visit_allocations (visit_id, company_id, appointment_id, minutes) values
  ('00000000-0000-4000-8000-000000000d01', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000b01', 90),
  ('00000000-0000-4000-8000-000000000d02', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000b02', 60);

insert into tasks (company_id, property_id, title, description, owner_id, reviewer_id, created_by, due_on, priority, status, checklist, recurrence) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000101', 'Test fire alarm call point', 'Weekly test; record which call point was used.', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', '00000000-0000-4000-8000-000000000a03', current_date + 2, 'high', 'not_started', '[{"text":"Notify building users","done":false},{"text":"Activate call point","done":false},{"text":"Reset panel","done":false}]', 'weekly'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000102', 'Photograph damp patch in hallway', null, '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', '00000000-0000-4000-8000-000000000a03', current_date - 1, 'normal', 'in_progress', '[]', 'none'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000108', 'Quote for bathroom extractor fan', null, '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a04', '00000000-0000-4000-8000-000000000a04', current_date + 7, 'normal', 'not_started', '[]', 'none'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000114', 'Deep clean communal kitchen', null, '00000000-0000-4000-8000-000000000a07', '00000000-0000-4000-8000-000000000a04', '00000000-0000-4000-8000-000000000a04', current_date + 1, 'normal', 'submitted', '[]', 'none'),
  ('00000000-0000-4000-8000-0000000000c1', null, 'Upload induction certificate', null, '00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-000000000a05', '00000000-0000-4000-8000-000000000a05', current_date + 5, 'normal', 'not_started', '[]', 'none');

insert into handover_notes (company_id, property_id, author_id, for_date, body) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000a03', current_date, 'Contractor attending Alder House at 2pm for boiler service. Key set 2 is in the office safe.');

-- Scheduled visits for the demo (planned, not actual).
insert into scheduled_visits (company_id, property_id, person_id, appointment_id, planned_start, planned_minutes, created_by) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b01', date_trunc('day', now()) + interval '1 day 9 hours', 60, '00000000-0000-4000-8000-000000000a03'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000108', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b02', date_trunc('day', now()) + interval '2 days 13 hours', 90, '00000000-0000-4000-8000-000000000a04'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000b01', date_trunc('day', now()) - interval '2 days' + interval '10 hours', 45, '00000000-0000-4000-8000-000000000a03');

-- Stage 4 demo: a published review, a draft review, supervision records and recognition (all fictional).
insert into reviews (id, company_id, person_id, author_id, kind, period_start, period_end, status, objectives, achievements, development, feedback, published_at) values
  ('00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', 'periodic', '2026-04-01', '2026-09-30', 'published',
   'Complete weekly fire checks at allocated properties. Improve photo evidence on maintenance tasks.', 'All weekly checks completed. Spotted a faulty fire door closer early.', 'Shadow the property manager on a safety inspection.', 'Reliable and thorough. Evidence photos could show the whole area, not just close-ups.', '2026-10-05 10:00Z'),
  ('00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a06', '00000000-0000-4000-8000-000000000a03', 'probation', '2026-10-12', '2027-01-11', 'draft',
   'Complete induction and shadow Sam for four weeks.', null, null, null, null);
insert into supervisions (company_id, person_id, supervisor_id, kind, held_on, minutes, agenda, shared_notes, restricted_notes, support_agreed, status) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', 'supervision', '2026-09-15', 60, 'Workload; safety checks; development.', 'Workload is manageable. Wants more inspection experience.', 'Manager note (fictional): monitor overtime pattern across the three companies.', 'Arrange inspection shadowing.', 'completed'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', 'coaching', '2026-10-06', 30, 'Taking better evidence photos.', 'Practised wide and close photos; agreed a checklist.', null, null, 'completed');
insert into tasks (company_id, title, owner_id, reviewer_id, created_by, due_on, review_id) values
  ('00000000-0000-4000-8000-0000000000c1', 'Shadow property manager on a safety inspection', '00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000a03', '00000000-0000-4000-8000-000000000a03', current_date + 14, '00000000-0000-4000-8000-000000000e01');
insert into recognitions (company_id, person_id, category, note, proposed_by, status, decided_by, decided_at) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a02', 'quality', 'Spotted a faulty fire door closer and reported it the same day.', '00000000-0000-4000-8000-000000000a03', 'approved', '00000000-0000-4000-8000-000000000a05', '2026-09-20 12:00Z');

-- Stage 5 demo: a shared fire-safety course required by Valor Housing and adopted by Wellbeing Homes, one completion, a policy and a handbook.
insert into courses (id, root_id, version, company_id, title, summary, lessons, questions, pass_mark, attempt_limit, time_limit_minutes, status, created_by, published_by, published_at) values
 ('00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000f01', 1, null, 'Fire safety awareness (fictional)', 'What to check on a property visit and what to do if you find a problem.',
  '[{"title":"Why fire checks matter","body":"Fire doors, alarms and escape routes protect everyone in a building.\n\nOn each visit you check that they work, and you report problems the same day."},
    {"title":"Fire doors","body":"A fire door must close fully on its own and must never be wedged open.\n\nCheck the gap and the seals, and that the closer works.","scenario":"You find a fire door wedged open with a fire extinguisher. What do you do?"},
    {"title":"Reporting","body":"Report a defect as a task with a photo. If there is immediate danger, follow your company''s emergency procedure first."}]',
  '[{"id":"q1","type":"single","prompt":"A fire door is wedged open. What should you do first?","marks":1,"options":[{"id":"a","text":"Remove the wedge and let the door close","correct":true},{"id":"b","text":"Leave it and mention it next week","correct":false},{"id":"c","text":"Take the door off its hinges","correct":false}]},
    {"id":"q2","type":"true_false","prompt":"A fire door should close fully on its own.","marks":1,"options":[{"id":"t","text":"True","correct":true},{"id":"f","text":"False","correct":false}]},
    {"id":"q3","type":"multiple","prompt":"Which should you check on a fire door? Choose all that apply.","marks":2,"options":[{"id":"a","text":"The closer works","correct":true},{"id":"b","text":"The seals are intact","correct":true},{"id":"c","text":"The colour of the paint","correct":false}]},
    {"id":"q4","type":"written","prompt":"Describe how you would report a broken alarm call point.","marks":2,"options":[]}]',
  70, 3, 20, 'published', '00000000-0000-4000-8000-000000000a08', '00000000-0000-4000-8000-000000000a01', '2025-01-10 10:00Z');
insert into training_requirements (company_id, course_root_id, due_within_days, refresher_months, created_by) values
 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000f01', 28, 12, '00000000-0000-4000-8000-000000000a05'),
 ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000f01', 28, 12, '00000000-0000-4000-8000-000000000a05');
insert into training_records (person_id, course_root_id, course_id, title, source, completed_on, created_by) values
 ('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000f01', 'Fire safety awareness (fictional)', 'course', '2025-11-03', '00000000-0000-4000-8000-000000000a02');

insert into policies (id, root_id, version, company_id, kind, title, owner_id, chapters, revision_summary, effective_on, review_on, status, created_by) values
 ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f11', 1, '00000000-0000-4000-8000-0000000000c1', 'policy', 'Lone working policy (fictional)', '00000000-0000-4000-8000-000000000a03',
  '[{"title":"Purpose","body":"This policy explains how we keep staff safe when they work alone at a property."},{"title":"Before a visit","body":"Set an expected finish time when you start a visit. Your named contact sees an alert if you do not check in."},{"title":"In an emergency","body":"Call 999. Hub notifications are not a monitored emergency service."}]',
  'First version.', '2026-01-01', '2027-01-01', 'approved', '00000000-0000-4000-8000-000000000a05'),
 ('00000000-0000-4000-8000-000000000f12', '00000000-0000-4000-8000-000000000f12', 1, null, 'handbook', 'Staff handbook (fictional)', '00000000-0000-4000-8000-000000000a05',
  '[{"title":"Welcome","body":"This handbook explains how we work across Valor Housing, Wellbeing Homes and Wellbeing Housing."},{"title":"Your working time","body":"Record visits with Start Visit and Finish Visit. Other working time is logged on the Timesheets page."},{"title":"Getting help","body":"Use Request Help in the Hub, or speak to your manager. For a grievance, contact HR."}]',
  'First version.', '2026-01-01', '2027-01-01', 'approved', '00000000-0000-4000-8000-000000000a05');
insert into policy_publications (policy_id, company_id, approved_by, approved_at) values
 ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', '2025-12-20 10:00Z'),
 ('00000000-0000-4000-8000-000000000f12', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', '2025-12-20 10:00Z');
insert into policy_receipts (policy_id, company_id, person_id, supplied_at)
select p.policy_id, p.company_id, a.person_id, p.approved_at from policy_publications p join appointments a on a.company_id = p.company_id where a.status = 'active';

-- Stage 6 demo: leads, a meeting with a decision, a risk, an audit with a finding, safety schedules, a repair, an agent with a portal user, a quality summary.
insert into governance_leads (company_id, area, person_id, role, delegated_authority, created_by) values
 ('00000000-0000-4000-8000-0000000000c1', 'quality', '00000000-0000-4000-8000-000000000a08', 'lead', 'May approve audit plans and close standard actions.', '00000000-0000-4000-8000-000000000a01'),
 ('00000000-0000-4000-8000-0000000000c1', 'quality', '00000000-0000-4000-8000-000000000a03', 'deputy', null, '00000000-0000-4000-8000-000000000a01'),
 ('00000000-0000-4000-8000-0000000000c1', 'property_safety', '00000000-0000-4000-8000-000000000a03', 'lead', 'May commission urgent safety repairs up to the agreed limit.', '00000000-0000-4000-8000-000000000a01'),
 ('00000000-0000-4000-8000-0000000000c1', 'complaints_oversight', '00000000-0000-4000-8000-000000000a08', 'lead', 'Investigates and responds to complaints about Valor properties.', '00000000-0000-4000-8000-000000000a01'),
 ('00000000-0000-4000-8000-0000000000c1', 'complaints_oversight', '00000000-0000-4000-8000-000000000a03', 'deputy', null, '00000000-0000-4000-8000-000000000a01');
insert into meetings (id, title, company_ids, held_on, chair_id, agenda, attendance, minutes, minutes_status, minutes_version, created_by) values
 ('00000000-0000-4000-8000-000000000f21', 'Joint quality meeting (fictional)', array['00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000c2']::uuid[], '2026-10-01', '00000000-0000-4000-8000-000000000a08',
  '[{"item":"Fire door checks across properties"},{"item":"Supervision coverage"}]', '[{"person_id":"00000000-0000-4000-8000-000000000a08","name":"Robin Ash","status":"present"},{"person_id":"00000000-0000-4000-8000-000000000a03","name":"Priya Shah","status":"present"},{"person_id":"00000000-0000-4000-8000-000000000a04","name":"Jordan Lee","status":"apologies"}]',
  'Fire door checks reviewed. Agreed monthly sampling for Valor Housing.', 'approved', 1, '00000000-0000-4000-8000-000000000a08');
insert into meeting_minutes_versions (meeting_id, version, minutes, approved_by) values ('00000000-0000-4000-8000-000000000f21', 1, 'Fire door checks reviewed. Agreed monthly sampling for Valor Housing.', '00000000-0000-4000-8000-000000000a08');
insert into decisions (meeting_id, company_id, title, evidence, options, rationale, authoriser_id, decided_on, review_on, created_by) values
 ('00000000-0000-4000-8000-000000000f21', '00000000-0000-4000-8000-0000000000c1', 'Sample fire door checks monthly', 'Two doors found wedged in September.', 'Weekly sampling; monthly sampling; no change.', 'Monthly sampling is proportionate to two findings.', '00000000-0000-4000-8000-000000000a08', '2026-10-01', '2027-01-01', '00000000-0000-4000-8000-000000000a08');
insert into risks (id, company_id, title, description, owner_id, controls, likelihood, impact, target_score, review_on, created_by) values
 ('00000000-0000-4000-8000-000000000f31', '00000000-0000-4000-8000-0000000000c1', 'Lone working at night (fictional)', 'Staff visiting properties alone after dark.', '00000000-0000-4000-8000-000000000a03', 'Expected finish times and check-ins in the Hub.', 3, 5, 6, '2026-12-01', '00000000-0000-4000-8000-000000000a08');
insert into risk_assessments (risk_id, likelihood, impact, note, assessed_by) values ('00000000-0000-4000-8000-000000000f31', 3, 5, 'Initial assessment', '00000000-0000-4000-8000-000000000a08');
insert into audits (id, company_id, area, title, scope, sample, reviewer_id, rubric, planned_on, completed_on, status, summary, created_by) values
 ('00000000-0000-4000-8000-000000000f41', '00000000-0000-4000-8000-0000000000c1', 'staff_files', 'Staff file audit Q3 (fictional)', 'Recruitment checks and clearance records.', '3 of 6 current staff files.', '00000000-0000-4000-8000-000000000a08',
  '[{"criterion":"Right to work recorded","result":"met"},{"criterion":"References verified before start","result":"partly_met","note":"One reference still awaited for a new starter."}]', '2026-09-20', '2026-09-30', 'completed', 'Generally sound. One gap.', '00000000-0000-4000-8000-000000000a08');
insert into improvement_actions (id, company_id, source_type, source_id, finding, action, significance, owner_id, due_on, effectiveness_review_on, created_by) values
 ('00000000-0000-4000-8000-000000000f42', '00000000-0000-4000-8000-0000000000c1', 'audit', '00000000-0000-4000-8000-000000000f41', 'A new starter began before both references were verified.', 'Chase the outstanding reference and add a reference check to onboarding.', 'significant', '00000000-0000-4000-8000-000000000a05', '2026-10-31', '2027-01-15', '00000000-0000-4000-8000-000000000a08');
insert into safety_requirements (id, company_id, property_id, name, interval_days, responsible, created_by) values
 ('00000000-0000-4000-8000-000000000f51', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000101', 'Fire alarm test', 7, 'Property operations worker', '00000000-0000-4000-8000-000000000a03'),
 ('00000000-0000-4000-8000-000000000f52', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000103', 'Gas safety inspection', 365, 'Managing agent', '00000000-0000-4000-8000-000000000a03');
insert into safety_checks (requirement_id, done_on, done_by_text, result, recorded_by) values ('00000000-0000-4000-8000-000000000f51', '2026-10-12', 'Sam Rivers', 'pass', '00000000-0000-4000-8000-000000000a02');
insert into agents (id, company_id, name, contact, responsibilities, required_evidence, escalation) values
 ('00000000-0000-4000-8000-000000000f61', '00000000-0000-4000-8000-0000000000c1', 'Example Lettings Agent (fictional)', 'agent@example.test', 'Gas safety, boiler servicing, structural repairs.', 'Gas safety certificates within 7 days of inspection.', 'Escalate to the property safety lead after 2 missed deadlines.');
insert into agent_properties (agent_id, property_id) values ('00000000-0000-4000-8000-000000000f61', '00000000-0000-4000-8000-000000000103'), ('00000000-0000-4000-8000-000000000f61', '00000000-0000-4000-8000-000000000106');
insert into people (id, email, full_name, staff_ref, status, is_fictional) values ('00000000-0000-4000-8000-000000000a09', 'agent.user@example.test', 'Alex Lettings (fictional agent)', 'AGT-0001', 'active', true);
insert into agent_users (agent_id, person_id, granted_by) values ('00000000-0000-4000-8000-000000000f61', '00000000-0000-4000-8000-000000000a09', '00000000-0000-4000-8000-000000000a04');
insert into repairs (id, company_id, property_id, title, description, urgency, status, agent_id, reported_by, due_on) values
 ('00000000-0000-4000-8000-000000000f62', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000103', 'Boiler pressure dropping', 'Boiler loses pressure overnight.', 'urgent', 'assigned', '00000000-0000-4000-8000-000000000f61', '00000000-0000-4000-8000-000000000a02', current_date + 5);
insert into quality_summaries (company_id, measure, period_start, period_end, value, definition, source, entered_by) values
 ('00000000-0000-4000-8000-0000000000c1', 'missed_contacts', '2026-09-01', '2026-09-30', 3, 'Planned support contacts not completed in the month.', 'Support system monthly report (fictional)', '00000000-0000-4000-8000-000000000a08');

-- Stage 7 demo: a finance administrator, an issued invoice, cash flow, a continuity plan, news and a conversation (all fictional).
insert into role_grants (person_id, role_key, company_id, granted_by, reason) values
  ('00000000-0000-4000-8000-000000000a05', 'finance_admin', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000a01', 'Demo setup');
update company_finance_settings set invoice_prefix = 'VH', payment_instructions = 'Bank details to be entered and verified by finance (demo).' where company_id = '00000000-0000-4000-8000-0000000000c1';
update company_finance_settings set invoice_prefix = 'WHM' where company_id = '00000000-0000-4000-8000-0000000000c2';
insert into cashflow_settings (company_id, opening_balance, opening_month) values ('00000000-0000-4000-8000-0000000000c1', 25000.00, '2026-10-01');
insert into cashflow_lines (company_id, month, kind, label, forecast) values
  ('00000000-0000-4000-8000-0000000000c1', '2026-10-01', 'income', 'Contract income (fictional)', 18000.00),
  ('00000000-0000-4000-8000-0000000000c1', '2026-10-01', 'expense', 'Staffing', 14500.00),
  ('00000000-0000-4000-8000-0000000000c1', '2026-11-01', 'income', 'Contract income (fictional)', 18000.00),
  ('00000000-0000-4000-8000-0000000000c1', '2026-11-01', 'expense', 'Staffing', 14500.00);
insert into finance_scenarios (company_id, name, kind, assumptions, adjustments, response, created_by) values
  ('00000000-0000-4000-8000-0000000000c1', 'November income paid a month late', 'delayed_income', 'The main contract payment for November arrives in December.',
   '[{"month":"2026-11-01","label":"November income delayed","amount":"-18000.00"},{"month":"2026-12-01","label":"Delayed income received","amount":"18000.00"}]', 'Delay non-urgent premises spend; agree an overdraft buffer in advance.', '00000000-0000-4000-8000-000000000a05');
insert into continuity_plans (company_id, scenario, title, plan, deputies, fallback, next_test_on, updated_by) values
  ('00000000-0000-4000-8000-0000000000c1', 'it_failure', 'Hub or internet unavailable (fictional)', 'Record visits on the paper form kept in each office and enter them as completed visits when the Hub is back.',
   array['00000000-0000-4000-8000-000000000a03']::uuid[], 'Phone the duty manager for check-ins.', '2026-12-01', '00000000-0000-4000-8000-000000000a01');
insert into news_posts (company_ids, category, title, body, pinned, status, author_id, published_at) values
  (array['00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000c2']::uuid[], 'announcement', 'Welcome to the Hub (fictional)', 'This is where you will find news for your companies.', true, 'published', '00000000-0000-4000-8000-000000000a01', '2026-10-01 09:00Z');
insert into conversations (id, company_id, kind, title, created_by) values ('00000000-0000-4000-8000-000000000f71', '00000000-0000-4000-8000-0000000000c1', 'team', 'Valor Housing property team', '00000000-0000-4000-8000-000000000a03');
insert into conversation_members (conversation_id, person_id) values ('00000000-0000-4000-8000-000000000f71', '00000000-0000-4000-8000-000000000a03'), ('00000000-0000-4000-8000-000000000f71', '00000000-0000-4000-8000-000000000a02');
insert into messages (conversation_id, author_id, body) values ('00000000-0000-4000-8000-000000000f71', '00000000-0000-4000-8000-000000000a03', 'Please remember the fire alarm test at Alder House this week.');
