-- Leave and cover (§19), versioned job descriptions with acknowledgement and competency records (§14),
-- onboarding templates and probation reviews (§12).

insert into permissions (key, description) values
  ('leave.approve',     'Approve or reject leave and arrange cover (never your own)'),
  ('jobs.manage',       'Write and publish job descriptions, competencies and onboarding templates'),
  ('competence.assess', 'Record competency assessments (never your own)'),
  ('onboarding.manage', 'Start onboarding plans, tick items and record probation reviews')
on conflict do nothing;
insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','leave.approve'),('super_admin','jobs.manage'),('super_admin','competence.assess'),('super_admin','onboarding.manage'),
  ('company_admin','leave.approve'),('company_admin','jobs.manage'),('company_admin','competence.assess'),('company_admin','onboarding.manage'),
  ('hr_admin','leave.approve'),('hr_admin','jobs.manage'),('hr_admin','competence.assess'),('hr_admin','onboarding.manage'),
  ('manager','leave.approve'),('manager','competence.assess'),('manager','onboarding.manage'),
  ('quality_lead','competence.assess')
) v(r, p) on conflict do nothing;

-- ── Leave ──
create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  company_id uuid not null references companies,       -- the company that approves it (an appointment there)
  kind text not null check (kind in ('annual','sick','unpaid','training','compassionate','other')),
  start_date date not null,
  end_date date not null,
  note text check (length(note) <= 500),
  status text not null default 'requested' check (status in ('requested','approved','rejected','cancelled')),
  decided_by uuid references people,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 366),
  check (decided_by is null or decided_by <> person_id),  -- nobody approves their own leave
  -- One person cannot hold two live requests for the same day.
  exclude using gist (person_id with =, daterange(start_date, end_date, '[]') with &&) where (status in ('requested','approved'))
);
create index leave_company on leave_requests (company_id, start_date);

-- ── Job descriptions: each version is its own row; root_id groups versions ──
create table job_descriptions (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  version int not null,
  company_id uuid not null references companies,
  title text not null check (length(title) between 2 and 120),
  purpose text check (length(purpose) <= 2000),
  duties text not null check (length(duties) between 3 and 8000),
  boundaries text check (length(boundaries) <= 4000),        -- what the role must not do
  standards text check (length(standards) <= 4000),
  reports_to text check (length(reports_to) <= 200),
  required_training text check (length(required_training) <= 2000),
  required_qualifications text check (length(required_qualifications) <= 2000),
  status text not null default 'draft' check (status in ('draft','published','retired')),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  published_by uuid references people,
  published_at timestamptz,
  unique (root_id, version)
);
create unique index jd_one_published on job_descriptions (root_id) where status = 'published';
alter table appointments add column job_description_root_id uuid;  -- follows the latest published version
create table jd_acknowledgements (
  job_description_id uuid not null references job_descriptions on delete cascade,  -- the exact version read
  person_id uuid not null references people on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (job_description_id, person_id)
);

-- ── Competence ──
create table competencies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null check (length(name) between 2 and 120),
  description text check (length(description) <= 2000),
  rubric text not null check (length(rubric) between 3 and 4000),  -- what each level looks like
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create table competency_assessments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  competency_id uuid not null references competencies,
  level text not null check (level in ('not_assessed','developing','competent','verified_to_support')),
  assessor_id uuid not null references people,
  assessed_on date not null,
  rubric_notes text not null check (length(rubric_notes) between 3 and 4000),  -- how the rubric was applied
  evidence text not null check (length(evidence) between 3 and 4000),         -- observed practice, not just training completion
  review_due date,
  created_at timestamptz not null default now(),
  check (assessor_id <> person_id),
  check (review_due is null or review_due > assessed_on)
);
create index competency_person on competency_assessments (person_id, competency_id, assessed_on desc);

-- ── Onboarding and probation ──
create table onboarding_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null check (length(name) between 2 and 120),
  items jsonb not null default '[]',   -- [{kind, title}]
  probation_months int not null default 6 check (probation_months between 0 and 24),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create table onboarding_plans (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references appointments on delete cascade,
  template_id uuid references onboarding_templates,
  created_by uuid references people,
  created_at timestamptz not null default now()
);
create table onboarding_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references onboarding_plans on delete cascade,
  position int not null,
  kind text not null check (kind in ('profile','checks','contract','job_description','induction','policies','training','competence','allocation','probation','other')),
  title text not null check (length(title) between 2 and 200),
  done_at timestamptz,
  done_by uuid references people,
  note text check (length(note) <= 500)
);
create table probation_reviews (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments on delete cascade,
  kind text not null check (kind in ('interim','final','extension')),
  due_on date not null,
  outcome text not null default 'pending' check (outcome in ('pending','on_track','concerns','passed','extended','not_passed')),
  notes text check (length(notes) <= 4000),          -- restricted: HR and the reviewer only
  reviewer_id uuid references people,
  completed_at timestamptz,
  check (outcome = 'pending' or completed_at is not null)
);
create index probation_due on probation_reviews (due_on) where outcome = 'pending';

alter table leave_requests enable row level security;
alter table job_descriptions enable row level security;
alter table jd_acknowledgements enable row level security;
alter table competencies enable row level security;
alter table competency_assessments enable row level security;
alter table onboarding_templates enable row level security;
alter table onboarding_plans enable row level security;
alter table onboarding_items enable row level security;
alter table probation_reviews enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
