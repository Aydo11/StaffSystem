-- Valor & Wellbeing Hub — stage 1–3 schema.
-- All business tables carry an explicit company_id where they concern a company.
-- RLS is enabled with NO policies: browsers can never read tables directly through
-- Supabase's API. All access goes through the backend, which enforces permissions.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ───────────── Companies ─────────────
create table companies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{2,6}$'),
  name text not null unique,
  legal_name text,
  company_number text,            -- left empty until verified; never invented
  registered_address text,
  details_verified boolean not null default false,
  logo_path text,
  brand_primary text not null default '#17324D',
  brand_accent text not null default '#0E8A7D',
  support_system_url text,        -- "Open Support System" shortcut; a link only, no integration
  help_contact text,
  clearance_rule text not null default 'block' check (clearance_rule in ('warn','block')),
  created_at timestamptz not null default now()
);

-- ───────────── People (one login, one central profile) ─────────────
create table people (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,       -- Supabase auth.users id, set when the invite is accepted
  email text not null,
  full_name text not null,
  preferred_name text,
  staff_ref text not null unique,
  professional_summary text,
  work_phone text,
  photo_path text,
  skills text[] not null default '{}',
  languages text[] not null default '{}',
  work_history jsonb not null default '[]',
  development_goals text,
  status text not null default 'invited' check (status in ('invited','active','left')),
  is_fictional boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index people_email_uq on people (lower(email));

-- Restricted personal details live in their own table so they are never selected by accident.
create table person_restricted (
  person_id uuid primary key references people on delete cascade,
  personal_phone text,
  personal_email text,
  home_address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  updated_at timestamptz not null default now()
);

create table qualifications (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  title text not null,
  issuer text,
  awarded_on date,
  verified_by uuid references people,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

-- Staff propose profile changes; an authorised reviewer applies them.
create table profile_change_requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  field text not null check (field in ('preferred_name','professional_summary','work_phone','skills','languages','development_goals')),
  proposed_value jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_by uuid references people,
  decided_at timestamptz,
  note text
);

-- ───────────── Roles and permissions (configurable) ─────────────
create table roles (
  key text primary key,
  label text not null,
  description text not null,
  privileged boolean not null default false   -- privileged roles must use MFA
);
create table permissions (
  key text primary key,
  description text not null
);
create table role_permissions (
  role_key text not null references roles on delete cascade,
  permission_key text not null references permissions on delete cascade,
  primary key (role_key, permission_key)
);
create table role_grants (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  role_key text not null references roles,
  company_id uuid references companies,       -- null only for super_admin (all companies)
  valid_from timestamptz not null default now(),
  expires_at timestamptz,                     -- time-limited reviewers and temporary delegation
  granted_by uuid references people,
  reason text,
  revoked_at timestamptz,
  revoked_by uuid references people,
  check (company_id is not null or role_key = 'super_admin'),
  check (expires_at is null or expires_at > valid_from)
);
create index role_grants_person on role_grants (person_id) where revoked_at is null;

-- ───────────── Properties ─────────────
create table properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  ref text not null,
  name text not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  postcode text not null,
  status text not null default 'active' check (status in ('active','void','under_works','offboarded')),
  managing_agent text,
  manager_person_id uuid references people,
  photo_path text,
  room_refs text[] not null default '{}',     -- non-personal room labels only
  notes text,
  is_fictional boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, ref)
);
-- Authorised cross-company arrangements (another company may also work at this property).
create table property_company_links (
  property_id uuid not null references properties on delete cascade,
  company_id uuid not null references companies,
  arrangement text not null,
  primary key (property_id, company_id)
);
create table property_keys (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  label text not null,
  holder_person_id uuid references people,
  issued_at timestamptz,
  returned_at timestamptz,
  lost_reported_at timestamptz,
  notes text
);

-- ───────────── Appointments (one person, many companies) ─────────────
create table appointments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  company_id uuid not null references companies,
  relationship text not null check (relationship in ('employee','contractor','agency','secondment','volunteer','other')),
  legal_employer_company_id uuid references companies,
  legal_employer_name text,
  job_title text not null,
  responsibilities text,
  manager_person_id uuid references people,
  start_date date not null,
  end_date date,
  status text not null default 'active' check (status in ('planned','active','suspended','ended')),
  contracted_hours_per_week numeric(5,2) check (contracted_hours_per_week between 0 and 168),
  ended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (legal_employer_company_id is not null or legal_employer_name is not null),
  check (end_date is null or end_date >= start_date)
);
create index appointments_person on appointments (person_id);
create index appointments_company on appointments (company_id);

-- Effective-dated pay/charge rates. Overlaps are impossible, so history is unambiguous.
create table appointment_rates (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments on delete cascade,
  rate_type text not null check (rate_type in ('hourly','daily','annual_salary')),
  amount numeric(12,2) not null check (amount >= 0),
  effective_from date not null,
  effective_to date,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (appointment_id with =, daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&)
);

create table appointment_properties (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments on delete cascade,
  property_id uuid not null references properties,
  from_date date not null default current_date,
  to_date date,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  check (to_date is null or to_date >= from_date)
);
create index appointment_properties_current on appointment_properties (property_id) where to_date is null;

-- ───────────── Deployment clearance & employment checks (restricted) ─────────────
create table clearance_decisions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  company_id uuid not null references companies,
  status text not null check (status in ('pending','cleared','cleared_with_restrictions','not_authorised')),
  restrictions text,
  evidence_summary text,
  decided_by uuid references people,
  decided_at timestamptz not null default now(),
  review_date date,
  check (status <> 'cleared_with_restrictions' or coalesce(restrictions,'') <> '')
);
create index clearance_latest on clearance_decisions (person_id, company_id, decided_at desc);

create view current_clearance with (security_invoker = true) as
  select distinct on (person_id, company_id) *
  from clearance_decisions
  order by person_id, company_id, decided_at desc;

create table clearance_exceptions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  company_id uuid not null references companies,
  context text not null,
  reason text not null,
  authorised_by uuid not null references people,
  created_at timestamptz not null default now()
);

-- Deliberately no field for criminal-record details or certificate images.
create table employment_checks (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  company_id uuid not null references companies,
  check_type text not null check (check_type in ('dbs','right_to_work','reference','qualification','other')),
  label text not null,
  status text not null default 'evidence_missing'
    check (status in ('evidence_missing','requested','awaiting_verification','verified','adverse_finding','not_required')),
  requested_on date,
  issued_on date,             -- certificate issue date (no universal DBS expiry is applied)
  verified_on date,
  reviewer_id uuid references people,
  reference_number text,
  follow_up_on date,
  next_review_on date,        -- organisational review date, separate from issue date
  actions text,
  updated_at timestamptz not null default now()
);

-- ───────────── Visits ─────────────
create table visits (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  appointment_id uuid not null references appointments,
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  entry_mode text not null check (entry_mode in ('live','manual')),
  status text not null check (status in ('in_progress','submitted','approved','rejected','cancelled')),
  started_at timestamptz not null,
  ended_at timestamptz,
  expected_end_at timestamptz,   -- planning / lone-worker check-in time, not actual duration
  planned_minutes int check (planned_minutes > 0),
  work_category text check (work_category in ('inspection','maintenance','cleaning','key_handover','property_check','administration','other')),
  summary text check (length(summary) <= 500),
  submitted_at timestamptz,
  decided_by uuid references people,
  decided_at timestamptz,
  decision_note text,
  client_request_id uuid unique,  -- idempotency: duplicate taps/requests create one visit
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  check (status = 'in_progress' or status = 'cancelled' or ended_at is not null)
);
create unique index one_active_visit_per_person on visits (person_id) where status = 'in_progress';
create index visits_company_time on visits (company_id, started_at);

-- How an approved visit's minutes are attributed. Sum always equals the visit duration,
-- so a visit that spans companies is split, never duplicated.
create table visit_allocations (
  visit_id uuid not null references visits on delete cascade,
  company_id uuid not null references companies,
  appointment_id uuid not null references appointments,
  minutes int not null check (minutes > 0),
  allocated_by uuid references people,
  allocated_at timestamptz not null default now(),
  primary key (visit_id, company_id)
);

create table visit_corrections (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits,
  requested_by uuid not null references people,
  reason text not null check (length(reason) >= 5),
  original jsonb not null,
  proposed jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references people,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index one_pending_correction on visit_corrections (visit_id) where status = 'pending';

-- ───────────── Non-visit time & timesheets ─────────────
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  appointment_id uuid not null references appointments,
  company_id uuid not null references companies,
  work_date date not null,
  category text not null check (category in ('travel','administration','training','supervision','coaching','other')),
  minutes int not null check (minutes > 0 and minutes <= 1440),
  note text,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  decided_by uuid references people,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table timesheets (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  appointment_id uuid not null references appointments,
  company_id uuid not null references companies,
  period_start date not null,
  period_end date not null,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  submitted_at timestamptz not null default now(),
  submitted_minutes int not null,
  decided_by uuid references people,
  decided_at timestamptz,
  decision_note text,
  approved_minutes int,
  cost_estimate numeric(12,2),     -- estimate from effective-dated rates; not payroll
  rate_snapshot jsonb,
  check (period_end >= period_start),
  unique (appointment_id, period_start, period_end)
);

-- ───────────── Tasks & handover ─────────────
create table tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid references properties,
  title text not null,
  description text,
  owner_id uuid references people,
  reviewer_id uuid references people,
  created_by uuid references people,
  due_on date,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'not_started' check (status in ('not_started','in_progress','submitted','changes_requested','completed')),
  checklist jsonb not null default '[]',
  recurrence text not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_company_status on tasks (company_id, status);

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks on delete cascade,
  author_id uuid not null references people,
  body text not null,
  created_at timestamptz not null default now()
);

create table handover_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid references properties,
  author_id uuid not null references people,
  for_date date not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- ───────────── Files (private storage) ─────────────
create table files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies,
  entity_type text not null check (entity_type in ('task','property','person_photo','qualification')),
  entity_id uuid not null,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  size_bytes int not null check (size_bytes > 0),
  uploaded_by uuid not null references people,
  uploaded_at timestamptz not null default now()
);
create index files_entity on files (entity_type, entity_id);

-- ───────────── Audit ─────────────
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_person_id uuid references people,
  company_id uuid references companies,
  entity text not null,
  entity_id uuid,
  action text not null,
  detail jsonb not null default '{}'
);
create index audit_entity on audit_log (entity, entity_id);

-- ───────────── Lock down direct API access ─────────────
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
  -- Private bucket (Supabase only). No storage policies are created, so only the server key can read/write.
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('hub-private', 'hub-private', false) on conflict (id) do nothing;
  end if;
end $$;
