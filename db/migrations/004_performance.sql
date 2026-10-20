-- Stage 4: KPI definitions (versioned), reviews, supervision/coaching/mentoring, recognition.
-- Follow-up actions are ordinary tasks linked back to their review or supervision.

insert into permissions (key, description) values
  ('performance.view_all',   'See KPIs for everyone in the company'),
  ('performance.manage',     'Change KPI targets and wording (creates a new version)'),
  ('reviews.manage',         'Write, publish and read staff reviews; decide recognition'),
  ('supervision.manage',     'Record supervision, coaching and mentoring for others'),
  ('supervision.restricted', 'Read restricted (management-only) supervision notes')
on conflict do nothing;

insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','performance.view_all'), ('super_admin','performance.manage'), ('super_admin','reviews.manage'), ('super_admin','supervision.manage'), ('super_admin','supervision.restricted'),
  ('company_admin','performance.view_all'), ('company_admin','performance.manage'), ('company_admin','reviews.manage'), ('company_admin','supervision.manage'), ('company_admin','supervision.restricted'),
  ('hr_admin','performance.view_all'), ('hr_admin','reviews.manage'), ('hr_admin','supervision.manage'), ('hr_admin','supervision.restricted'),
  ('manager','performance.view_all'), ('manager','reviews.manage'), ('manager','supervision.manage'),
  ('quality_lead','performance.view_all'), ('quality_lead','performance.manage')
) v(r, p) on conflict do nothing;

-- The formula for each key is implemented in server/kpi.ts; a definition version changes the wording, target and minimum data.
create table kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('approved_hours','on_time_starts','visit_coverage','tasks_on_time','clearance','supervision_on_time','development_actions','coaching_hours')),
  version int not null check (version > 0),
  company_id uuid references companies,            -- null = default for all companies
  title text not null,
  purpose text not null,
  formula text not null,
  sources text not null,
  unit text not null check (unit in ('percent','hours')),
  direction text not null check (direction in ('higher','lower','none')),
  target numeric(6,2),
  min_data int not null default 5 check (min_data >= 0),
  applies_to text not null default 'All roles',
  owner text not null,
  limitations text not null,
  next_step text,
  effective_from date not null,
  created_by uuid references people,
  created_at timestamptz not null default now()
);
create unique index kpi_version_uq on kpi_definitions (key, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

insert into kpi_definitions (key, version, title, purpose, formula, sources, unit, direction, target, min_data, owner, limitations, next_step, effective_from) values
 ('approved_hours', 1, 'Approved visit hours', 'Shows how much visit time has been recorded and approved, so gaps in approval can be followed up.',
  'Sum of approved visit minutes allocated to the company in the month. Planned, recorded and submitted hours are shown alongside.', 'Visits, visit allocations, planned visits', 'hours', 'none', null, 0, 'Operations manager',
  'More hours do not mean better work. Leave, cover and part-time patterns are not yet recorded in the Hub.', null, '2025-01-01'),
 ('on_time_starts', 1, 'On-time starts', 'Shows whether planned visits start when expected, so plans can be made realistic.',
  'Planned visits completed in the month that started no more than 15 minutes after the planned time ÷ planned visits completed.', 'Planned visits linked to a started visit', 'percent', 'higher', 85, 5, 'Operations manager',
  'Only visits started from a plan are counted. Travel delays outside the worker''s control are not separated out.', 'Look at which planned times are often missed and agree more realistic start times or travel allowances.', '2025-01-01'),
 ('visit_coverage', 1, 'Planned visits completed', 'Shows whether planned property visits actually happen.',
  'Planned visits in the month that were completed ÷ planned visits whose time has passed (cancelled plans excluded).', 'Planned visits, visits', 'percent', 'higher', 95, 5, 'Operations manager',
  'A plan cancelled late still counts as cancelled, not missed. Cover arrangements are not yet recorded.', 'Check missed visits for a pattern (property, day, worker) and arrange cover or re-plan.', '2025-01-01'),
 ('tasks_on_time', 1, 'Tasks completed on time', 'Shows whether work is finished by the agreed date.',
  'Tasks due in the month completed on or before the due date ÷ tasks due in the month that are completed or already overdue.', 'Tasks', 'percent', 'higher', 80, 5, 'Line manager',
  'Deadlines moved before they were missed count as met. Task size is not taken into account.', 'Review overdue tasks together and agree whether the deadline, priority or support needs to change.', '2025-01-01'),
 ('clearance', 1, 'Staff cleared for deployment', 'Shows whether everyone working has a current deployment clearance decision.',
  'Current appointments with a Cleared or Cleared with Restrictions decision at the end of the month ÷ current appointments.', 'Appointments, clearance decisions', 'percent', 'higher', 100, 1, 'HR administrator',
  'Shows decisions recorded in the Hub only, not the quality of the checks behind them.', 'Follow up pending clearance decisions and any expired review dates.', '2025-01-01'),
 ('supervision_on_time', 1, 'Supervision up to date', 'Shows whether each person has had recent supervision, coaching or mentoring.',
  'Current appointments with a completed supervision in the 8 weeks before the end of the month ÷ current appointments.', 'Appointments, supervision records', 'percent', 'higher', 90, 1, 'Line manager',
  'Counts that supervision happened, not how useful it was. Your supervision policy may set a different interval.', 'Book supervision for anyone overdue and agree a regular schedule.', '2025-01-01'),
 ('development_actions', 1, 'Development actions completed', 'Shows whether actions agreed in reviews and supervision get done.',
  'Review and supervision actions due in the month completed on or before the due date ÷ such actions due in the month.', 'Tasks linked to reviews and supervision', 'percent', 'higher', 80, 3, 'Line manager',
  'Only actions recorded as tasks are counted.', 'Discuss outstanding actions at the next supervision and remove blockers.', '2025-01-01'),
 ('coaching_hours', 1, 'Coaching and mentoring hours', 'Shows how much coaching and mentoring time people receive.',
  'Sum of minutes of completed coaching and mentoring sessions held in the month.', 'Supervision records (coaching, mentoring)', 'hours', 'none', null, 0, 'Line manager',
  'Time is not the same as quality. Informal coaching is not recorded.', null, '2025-01-01');

create table reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  person_id uuid not null references people,
  author_id uuid not null references people,
  kind text not null check (kind in ('probation','periodic','annual')),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','published')),
  objectives text,
  achievements text,
  development text,
  feedback text,
  published_at timestamptz,
  staff_response text check (length(staff_response) <= 4000),
  acknowledged_at timestamptz,          -- acknowledgement means "I have read it", not agreement
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (author_id <> person_id)
);
create index reviews_person on reviews (person_id);

create table supervisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  person_id uuid not null references people,
  supervisor_id uuid not null references people,
  kind text not null check (kind in ('supervision','coaching','mentoring')),
  held_on date not null,
  minutes int not null check (minutes between 5 and 480),
  agenda text,
  shared_notes text,                    -- seen by the person supervised
  restricted_notes text,                -- management only; never shown to the person supervised
  support_agreed text,
  staff_reflection text,                -- written by the person supervised
  next_due date,
  status text not null default 'draft' check (status in ('draft','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (supervisor_id <> person_id)
);
create index supervisions_person on supervisions (person_id, held_on desc);

create table recognitions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  person_id uuid not null references people,
  category text not null check (category in ('learning','quality','teamwork','improvement')),
  note text not null check (length(note) between 5 and 1000),
  proposed_by uuid not null references people,
  status text not null default 'proposed' check (status in ('proposed','approved','declined')),
  decided_by uuid references people,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (proposed_by <> person_id)
);

alter table tasks add column review_id uuid references reviews;
alter table tasks add column supervision_id uuid references supervisions;

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
