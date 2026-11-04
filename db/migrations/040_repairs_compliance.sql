-- Phase 1 of the repairs, property safety and selective compliance work (owner request, 3 Nov 2026).
-- 1. Repairs: a fuller workflow (Reported → Under review → Assigned → In progress → Awaiting parts/access → Completed →
--    Verified → Closed, plus Cancelled and Reopened), categories, locations, completion evidence and configurable targets.
-- 2. Selective property compliance (Windrush): OFF for every property until an administrator turns it on for that
--    property. Nothing is switched on here and no compliance results are created.

-- ───────────── Repairs ─────────────
alter table repairs drop constraint repairs_status_check;
update repairs set status = 'under_review' where status = 'triaged';
update repairs set status = 'completed' where status = 'awaiting_verification';
alter table repairs add constraint repairs_status_check
  check (status in ('reported','under_review','assigned','in_progress','awaiting_parts','completed','verified','closed','cancelled','reopened'));
alter table repairs drop constraint repairs_urgency_check;
alter table repairs add constraint repairs_urgency_check check (urgency in ('emergency','urgent','routine','planned'));
update repair_updates set status_from = 'under_review' where status_from = 'triaged';
update repair_updates set status_to = 'under_review' where status_to = 'triaged';
update repair_updates set status_from = 'completed' where status_from = 'awaiting_verification';
update repair_updates set status_to = 'completed' where status_to = 'awaiting_verification';

alter table repairs
  add column category text check (category in ('plumbing','heating','electrical','appliances','locks','doors','windows','furniture','damp_mould','pest_control','gardening','communal','decoration','general')),
  add column location text check (length(location) <= 120),             -- room label or communal area, never a resident's name
  add column reported_on date,                                            -- the day the problem was reported (may be before it was logged)
  add column suggested_urgency text check (suggested_urgency in ('emergency','urgent','routine','planned')),
  add column urgency_reason text check (length(urgency_reason) <= 1000),  -- why the priority differs from the suggestion
  add column notes text check (length(notes) <= 4000),
  add column work_description text check (length(work_description) <= 4000),
  add column contractor_attended boolean,
  add column cost numeric(10,2) check (cost >= 0),
  add column resident_confirmed boolean,
  add column closed_at timestamptz,
  add column escalated_at timestamptz;
update repairs set reported_on = (created_at at time zone 'Europe/London')::date;
alter table repairs alter column reported_on set not null, alter column reported_on set default ((now() at time zone 'Europe/London')::date);
-- Existing closed repairs were verified when they closed.
update repairs set closed_at = coalesce(verified_at, updated_at) where status = 'closed';
create index repairs_property_category on repairs (property_id, category, reported_on);

-- Target days per priority, per company. Escalate once a repair is this many days past its target.
create table repair_sla (
  company_id uuid not null references companies,
  urgency text not null check (urgency in ('emergency','urgent','routine','planned')),
  target_days int not null check (target_days between 0 and 365),
  escalate_after_days int not null default 0 check (escalate_after_days between 0 and 90),
  updated_by uuid references people,
  updated_at timestamptz not null default now(),
  primary key (company_id, urgency)
);
-- The targets the Hub already used (1, 7 and 28 days), plus planned work.
insert into repair_sla (company_id, urgency, target_days)
select c.id, u, d from companies c, (values ('emergency', 1), ('urgent', 7), ('routine', 28), ('planned', 90)) v(u, d) on conflict do nothing;

-- Before / after labels for repair photos.
alter table files add column tag text check (tag in ('before','after'));

-- ───────────── Selective property compliance ─────────────
insert into permissions (key, description) values
  ('compliance.manage', 'Turn property compliance monitoring on or off, set frameworks, verify records and mark items not applicable'),
  ('compliance.record', 'Record compliance completions, evidence and notes on properties where monitoring is on'),
  ('compliance.view',   'See property compliance where monitoring is on')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin','compliance.manage'),('super_admin','compliance.record'),('super_admin','compliance.view'),
  ('company_admin','compliance.manage'),('company_admin','compliance.record'),('company_admin','compliance.view'),
  ('manager','compliance.record'),('manager','compliance.view'),
  ('property_officer','compliance.record'),('property_officer','compliance.view'),
  ('quality_lead','compliance.view'),('reviewer','compliance.view')
on conflict do nothing;

-- A framework is a reusable checklist (name + interval per item). Assigned per property.
create table compliance_frameworks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null check (length(name) between 2 and 200),
  description text check (length(description) <= 2000),
  items jsonb not null default '[]',   -- [{ key, name, interval_days }]
  created_by uuid references people,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

alter table properties
  add column compliance_enabled boolean not null default false,
  add column classification text check (classification in ('windrush','other_rsl','standard')),
  add column compliance_framework_id uuid references compliance_frameworks;

create table compliance_requirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  key text not null check (key ~ '^[a-z0-9_]{2,60}$'),
  name text not null check (length(name) between 2 and 200),
  interval_days int not null check (interval_days between 1 and 3660),
  reminder_days int not null default 30 check (reminder_days between 0 and 365),
  responsible_id uuid references people,
  responsible_text text check (length(responsible_text) <= 200),
  notes text check (length(notes) <= 4000),
  not_applicable boolean not null default false,
  na_reason text check (length(na_reason) <= 1000),
  custom boolean not null default false,
  retired_at timestamptz,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not not_applicable or length(na_reason) >= 3),
  unique (property_id, key)
);
-- Each completion: the date, outcome, evidence and when it is next due. Verification is by someone else.
create table compliance_records (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references compliance_requirements,
  completed_on date not null,
  next_due_on date not null,
  outcome text not null check (outcome in ('pass','advisory','fail')),
  done_by_text text check (length(done_by_text) <= 200),
  findings text check (length(findings) <= 4000),
  corrective_action text check (length(corrective_action) <= 2000),
  evidence_file_id uuid references files,
  recorded_by uuid not null references people,
  verified_by uuid references people,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (next_due_on >= completed_on)
);
create index compliance_records_req on compliance_records (requirement_id, completed_on desc);

alter table improvement_actions drop constraint improvement_actions_source_type_check;
alter table improvement_actions add constraint improvement_actions_source_type_check
  check (source_type in ('audit','risk','decision','safety_check','agent','meeting','other','compliance_record'));
alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn','compliance'));

alter table repair_sla enable row level security;
alter table compliance_frameworks enable row level security;
alter table compliance_requirements enable row level security;
alter table compliance_records enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
