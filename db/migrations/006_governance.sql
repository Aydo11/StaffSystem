-- Stage 6: governance (leads, meetings, decisions), risks, audits, one connected improvement-action framework,
-- employee concerns and HR processes, contract changes, property safety, repairs, managing agents,
-- external quality summaries, assessment-framework mapping.

insert into permissions (key, description) values
  ('governance.view',   'See governance: leads, meetings, decisions, risks, audits, actions and management packs'),
  ('governance.manage', 'Record meetings, decisions, risks, audits, leads and framework mapping'),
  ('cases.handle',      'Handle grievances, concerns and HR processes (never where you are implicated)'),
  ('contracts.manage',  'Propose and track contract changes'),
  ('contracts.approve', 'Approve contract changes'),
  ('safety.manage',     'Set property safety schedules and record checks'),
  ('repairs.manage',    'Triage, assign and verify repairs'),
  ('agents.manage',     'Manage managing agents, their properties, reviews and access'),
  ('quality.view',      'See non-identifiable quality summaries from the support system'),
  ('quality.manage',    'Enter and verify quality summaries')
on conflict do nothing;

insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','governance.view'),('super_admin','governance.manage'),('super_admin','cases.handle'),('super_admin','contracts.manage'),('super_admin','contracts.approve'),('super_admin','safety.manage'),('super_admin','repairs.manage'),('super_admin','agents.manage'),('super_admin','quality.view'),('super_admin','quality.manage'),
  ('company_admin','governance.view'),('company_admin','governance.manage'),('company_admin','cases.handle'),('company_admin','contracts.manage'),('company_admin','contracts.approve'),('company_admin','safety.manage'),('company_admin','repairs.manage'),('company_admin','agents.manage'),('company_admin','quality.view'),('company_admin','quality.manage'),
  ('hr_admin','cases.handle'),('hr_admin','contracts.manage'),('hr_admin','governance.view'),
  ('quality_lead','governance.view'),('quality_lead','governance.manage'),('quality_lead','quality.view'),('quality_lead','quality.manage'),('quality_lead','agents.manage'),
  ('manager','governance.view'),('manager','repairs.manage'),('manager','safety.manage'),
  ('property_officer','safety.manage'),('property_officer','repairs.manage'),('property_officer','agents.manage'),
  ('reviewer','governance.view')
) v(r, p) on conflict do nothing;

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit'));

-- ───────────── Accountability ─────────────
-- Responsibility is recorded separately from access: naming someone a lead grants them no permissions.
create table governance_leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  area text not null check (area in ('staffing','quality','safeguarding_oversight','property_safety','complaints_oversight','finance','data_protection')),
  lead_person_id uuid references people,
  deputy_person_id uuid references people,
  delegated_authority text,
  from_date date not null default current_date,
  to_date date,
  created_by uuid references people,
  created_at timestamptz not null default now()
);
create unique index one_current_lead on governance_leads (company_id, area) where to_date is null;

-- ───────────── Meetings and decisions ─────────────
create table meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  company_ids uuid[] not null check (cardinality(company_ids) >= 1),   -- joint meetings list every company
  held_on date not null,
  chair_id uuid references people,
  agenda jsonb not null default '[]',         -- [{item, paper_file_id}]
  attendance jsonb not null default '[]',     -- [{person_id, name, role, status: present|apologies|absent}]
  conflicts text,
  minutes text,
  minutes_status text not null default 'draft' check (minutes_status in ('draft','approved')),
  minutes_version int not null default 0,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Every approved version of the minutes, with the reason for any amendment.
create table meeting_minutes_versions (
  meeting_id uuid not null references meetings,
  version int not null,
  minutes text not null,
  amendment_reason text,
  approved_by uuid not null references people,
  approved_at timestamptz not null default now(),
  primary key (meeting_id, version)
);
create table decisions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references meetings,
  company_id uuid not null references companies,   -- the company each decision affects, even in a joint meeting
  title text not null,
  evidence text,
  options text,
  rationale text not null,
  resources text,
  authoriser_id uuid not null references people,
  decided_on date not null,
  review_on date,
  created_by uuid references people,
  created_at timestamptz not null default now()
);

-- ───────────── Risks ─────────────
create table risks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  title text not null,
  description text,
  category text,
  owner_id uuid references people,
  controls text,
  likelihood int not null check (likelihood between 1 and 5),
  impact int not null check (impact between 1 and 5),
  target_score int check (target_score between 1 and 25),
  review_on date,
  status text not null default 'open' check (status in ('open','closed')),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table risk_assessments (
  id uuid primary key default gen_random_uuid(),
  risk_id uuid not null references risks,
  likelihood int not null check (likelihood between 1 and 5),
  impact int not null check (impact between 1 and 5),
  note text,
  assessed_by uuid not null references people,
  assessed_at timestamptz not null default now()
);

-- ───────────── Audits ─────────────
create table audits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  area text not null check (area in ('staff_files','recruitment','training','supervision','governance','agents','information_security','property_safety')),
  title text not null,
  scope text,
  sample text,
  reviewer_id uuid references people,
  rubric jsonb not null default '[]',      -- [{criterion, result: met|partly_met|not_met|not_applicable, note}]
  planned_on date not null,
  completed_on date,
  summary text,
  status text not null default 'planned' check (status in ('planned','in_progress','completed')),
  created_by uuid references people,
  created_at timestamptz not null default now()
);

-- ───────────── One connected improvement framework ─────────────
-- Finding → Action → Owner → Deadline → Evidence → Verification → Effectiveness review.
create table improvement_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  source_type text not null check (source_type in ('audit','risk','decision','safety_check','agent','meeting','other')),
  source_id uuid,
  finding text not null,
  action text not null,
  significance text not null default 'standard' check (significance in ('standard','significant')),
  owner_id uuid references people,
  due_on date,
  status text not null default 'open' check (status in ('open','evidence_submitted','verified','closed','reopened')),
  evidence_note text,
  evidence_at timestamptz,
  verified_by uuid references people,
  verified_at timestamptz,
  verification_note text,
  effectiveness_review_on date,
  effectiveness text check (effectiveness in ('effective','partly_effective','not_effective')),
  effectiveness_note text,
  recurred boolean,
  reviewed_by uuid references people,
  reviewed_at timestamptz,
  closed_at timestamptz,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  -- A significant action cannot be closed until it has been verified and its effectiveness reviewed.
  check (status <> 'closed' or significance = 'standard' or (verified_at is not null and effectiveness is not null))
);
create index improvement_actions_company on improvement_actions (company_id, status);

-- ───────────── Employee concerns and HR processes (restricted) ─────────────
create table cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  kind text not null check (kind in ('grievance','bullying_harassment','whistleblowing','concern_about_manager','development','capability','conduct')),
  raised_by uuid references people,                -- the person raising a concern (null for HR-opened processes)
  subject_person_id uuid references people,        -- the employee a development/capability/conduct process is about
  implicated_ids uuid[] not null default '{}',     -- never shown the case and never able to handle it
  summary text not null,
  procedure_ref text,                              -- the approved procedure followed
  status text not null default 'received' check (status in ('received','acknowledged','investigating','outcome_given','appeal','closed')),
  acknowledged_at timestamptz,
  investigator_id uuid references people,
  outcome text,
  outcome_on date,
  appeal text,
  appeal_outcome text,
  employee_response text,
  created_by uuid not null references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind in ('development','capability','conduct')) = (subject_person_id is not null)),
  check (investigator_id is null or not (investigator_id = any(implicated_ids)))
);
create table case_updates (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases,
  author_id uuid not null references people,
  body text not null,
  shared boolean not null default false,          -- shared with the person who raised it / the subject
  created_at timestamptz not null default now()
);

create table contract_changes (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments,
  company_id uuid not null references companies,
  summary text not null,
  details text,
  proposed_by uuid not null references people,
  communicated_on date,
  approved_by uuid references people,
  approved_at timestamptz,
  effective_on date,
  agreement text not null default 'proposed' check (agreement in ('proposed','communicated','agreed','not_agreed','withdrawn')),
  employee_response text,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> proposed_by)
);

-- ───────────── Property safety, repairs, managing agents ─────────────
create table safety_requirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  name text not null,
  interval_days int not null check (interval_days between 1 and 3660),
  responsible text not null,            -- for example "Managing agent" or a named contractor
  notes text,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table safety_checks (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references safety_requirements,
  done_on date not null,
  done_by_text text,
  result text not null check (result in ('pass','advisory','fail')),
  findings text,
  evidence_file_id uuid,
  recorded_by uuid not null references people,
  verified_by uuid references people,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null,
  contact text,
  contract_start date,
  contract_end date,
  responsibilities text,
  required_evidence text,
  escalation text,
  created_at timestamptz not null default now()
);
create table agent_properties (agent_id uuid not null references agents on delete cascade, property_id uuid not null references properties, primary key (agent_id, property_id));
-- An agent user sees only their agent's properties, repairs and safety records — never staff, HR or other data.
create table agent_users (agent_id uuid not null references agents on delete cascade, person_id uuid not null references people, granted_by uuid references people, expires_at timestamptz, primary key (agent_id, person_id));
create table agent_reviews (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents,
  period_start date not null,
  period_end date not null,
  scores jsonb not null default '[]',   -- [{criterion, score 1-5, evidence}]
  summary text,
  reviewer_id uuid not null references people,
  created_at timestamptz not null default now()
);

create table repairs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  title text not null,
  description text,
  impact text,
  urgency text not null check (urgency in ('emergency','urgent','routine')),
  immediate_action text,
  status text not null default 'reported' check (status in ('reported','triaged','assigned','in_progress','awaiting_verification','closed')),
  assignee_id uuid references people,
  agent_id uuid references agents,
  contractor text,
  due_on date,
  completed_on date,
  verified_by uuid references people,
  verified_at timestamptz,
  reported_by uuid not null references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table repair_updates (
  id uuid primary key default gen_random_uuid(),
  repair_id uuid not null references repairs,
  author_id uuid not null references people,
  body text not null,
  status_from text,
  status_to text,
  created_at timestamptz not null default now()
);

-- ───────────── External quality summaries (non-identifiable) ─────────────
create table quality_summaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  measure text not null check (measure in ('missed_contacts','follow_up_outstanding','safeguarding_actions_outstanding','complaint_themes','resident_feedback','outcome_measure')),
  period_start date not null,
  period_end date not null,
  value numeric(10,2),                  -- a count or a percentage; never a list of people
  theme text check (length(theme) <= 200),
  definition text not null,
  source text not null,
  sensitive boolean not null default false,
  entered_by uuid not null references people,
  entered_at timestamptz not null default now(),
  verified_by uuid references people,
  verified_at timestamptz,
  check (period_end >= period_start)
);

-- ───────────── Assessment framework mapping ─────────────
-- The organisation enters its current framework's criteria; the Hub never invents official criteria.
create table framework_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  framework text not null,
  ref text not null,
  title text not null,
  evidence jsonb not null default '[]',  -- [{label, link}]
  status text not null default 'evidence_missing' check (status in ('evidence_missing','awaiting_review','action_required','verified','not_applicable')),
  note text,
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
