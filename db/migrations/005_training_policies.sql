-- Stage 5: training (courses, lessons, quizzes, requirements, records) and policies/handbooks with per-company approval.

insert into permissions (key, description) values
  ('training.view_all', 'See the training matrix for everyone in the company'),
  ('training.manage',   'Build courses, set requirements, assign training, mark answers, verify certificates'),
  ('policies.view_all', 'See who has been supplied, opened and acknowledged each policy'),
  ('policies.manage',   'Draft and upload policies and handbooks'),
  ('policies.approve',  'Approve or adopt a policy version for the company')
on conflict do nothing;

insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','training.view_all'), ('super_admin','training.manage'), ('super_admin','policies.view_all'), ('super_admin','policies.manage'), ('super_admin','policies.approve'),
  ('company_admin','training.view_all'), ('company_admin','training.manage'), ('company_admin','policies.view_all'), ('company_admin','policies.manage'), ('company_admin','policies.approve'),
  ('hr_admin','training.view_all'), ('hr_admin','training.manage'), ('hr_admin','policies.view_all'), ('hr_admin','policies.manage'),
  ('quality_lead','training.view_all'), ('quality_lead','training.manage'), ('quality_lead','policies.view_all'), ('quality_lead','policies.manage'), ('quality_lead','policies.approve'),
  ('manager','training.view_all'), ('manager','policies.view_all')
) v(r, p) on conflict do nothing;

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record'));

-- ───────────── Courses (lessons + quiz in one versioned record) ─────────────
-- root_id groups the versions of one course. A published version never changes; editing creates a new draft version.
create table courses (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  version int not null default 1,
  company_id uuid references companies,          -- null = shared learning offered to every company
  title text not null,
  summary text,
  lessons jsonb not null default '[]',           -- [{title, body, image_file_id, image_alt, video_url, transcript, resources:[{label,url}], scenario}]
  questions jsonb not null default '[]',         -- [{id, type, prompt, image_file_id, image_alt, options:[{id,text,correct}], marks}]
  draw_count int check (draw_count > 0),         -- question bank: draw this many at random per attempt
  pass_mark int check (pass_mark between 1 and 100),
  attempt_limit int check (attempt_limit > 0),
  time_limit_minutes int check (time_limit_minutes between 1 and 240),
  status text not null default 'draft' check (status in ('draft','published','retired')),
  created_by uuid references people,
  published_by uuid references people,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (root_id, version)
);
create unique index one_draft_per_course on courses (root_id) where status = 'draft';

-- A company requires a course for everyone, or for one job title. Requiring another company's or a shared course is the explicit acceptance of it.
create table training_requirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  course_root_id uuid not null,
  job_title text,                                -- null = every current appointment in the company
  due_within_days int not null default 28 check (due_within_days between 0 and 365),
  refresher_months int check (refresher_months between 1 and 120),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table training_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  person_id uuid not null references people,
  course_root_id uuid not null,
  due_on date not null,
  assigned_by uuid references people,
  created_at timestamptz not null default now(),
  unique (company_id, person_id, course_root_id)
);
-- A company explicitly accepts another course as equivalent to its own.
create table course_equivalences (
  company_id uuid not null references companies,
  course_root_id uuid not null,
  equivalent_root_id uuid not null,
  accepted_by uuid not null references people,
  accepted_at timestamptz not null default now(),
  primary key (company_id, course_root_id, equivalent_root_id)
);

create table course_progress (
  person_id uuid not null references people,
  course_id uuid not null references courses,
  lesson_index int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (person_id, course_id)
);

create table quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  course_id uuid not null references courses,
  questions jsonb not null,                      -- the questions drawn for this attempt (snapshot)
  answers jsonb not null default '{}',
  started_at timestamptz not null default now(),
  deadline timestamptz,
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress','awaiting_marking','marked')),
  auto_marks int,
  manual_marks jsonb,
  score int,
  max_score int,
  passed boolean,
  marked_by uuid references people,
  marked_at timestamptz
);
create unique index one_open_attempt on quiz_attempts (person_id, course_id) where status = 'in_progress';

-- Completed learning. From a course: only via a passed quiz or a completed declaration. External: counts once verified.
create table training_records (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  course_root_id uuid,
  course_id uuid references courses,
  title text not null,
  source text not null check (source in ('course','external')),
  completed_on date not null,
  attempt_id uuid references quiz_attempts,
  certificate_file_id uuid,
  provider text,
  verified_by uuid references people,
  verified_at timestamptz,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  check (source = 'external' or course_id is not null)
);
create index training_records_person on training_records (person_id, course_root_id, completed_on desc);

-- Status of every required or assigned course for every current appointment, as at a date.
create function training_matrix(as_of date)
returns table (company_id uuid, person_id uuid, course_root_id uuid, source text, requirement_id uuid, due_on date, completed_on date, renew_on date, status text)
language sql stable as $$
  with needs as (
    select r.company_id, a.person_id, r.course_root_id, 'requirement'::text source, r.id requirement_id, r.refresher_months, a.start_date + r.due_within_days first_due
      from training_requirements r join appointments a on a.company_id = r.company_id
     where r.retired_at is null and a.status in ('active','suspended') and a.start_date <= as_of and (a.end_date is null or a.end_date >= as_of)
       and (r.job_title is null or lower(a.job_title) = lower(r.job_title))
    union
    select t.company_id, t.person_id, t.course_root_id, 'assignment', null, null, t.due_on from training_assignments t
  ),
  dedup as (select distinct on (company_id, person_id, course_root_id) * from needs order by company_id, person_id, course_root_id, source desc),
  done as (
    select d.*, (select max(tr.completed_on) from training_records tr
                  where tr.person_id = d.person_id and tr.completed_on <= as_of and (tr.source = 'course' or tr.verified_at is not null)
                    and (tr.course_root_id = d.course_root_id
                         or tr.course_root_id in (select e.equivalent_root_id from course_equivalences e where e.company_id = d.company_id and e.course_root_id = d.course_root_id))) last_done
      from dedup d
  )
  select company_id, person_id, course_root_id, source, requirement_id,
         case when last_done is null then first_due else (last_done + make_interval(months => refresher_months))::date end,
         last_done,
         case when last_done is not null and refresher_months is not null then (last_done + make_interval(months => refresher_months))::date end,
         case when last_done is not null and (refresher_months is null or (last_done + make_interval(months => refresher_months))::date > as_of)
                then case when refresher_months is not null and (last_done + make_interval(months => refresher_months))::date <= as_of + 30 then 'expiring' else 'current' end
              when last_done is null and first_due >= as_of then 'due'
              else 'overdue' end
    from done
$$;

-- ───────────── Policies and handbooks ─────────────
create table policies (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  version int not null default 1,
  company_id uuid references companies,          -- null = a shared document that each company must adopt
  kind text not null check (kind in ('policy','handbook')),
  title text not null,
  language text not null default 'en-GB',
  translation_of_root uuid,                      -- set on a reviewed translation of another document
  owner_id uuid references people,
  audience text,                                 -- null = everyone in the company; otherwise a job title
  chapters jsonb not null default '[]',          -- [{title, body}] readable text
  file_id uuid,                                  -- optional PDF
  revision_summary text,
  effective_on date,
  review_on date,
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (root_id, version)
);
create unique index one_draft_per_policy on policies (root_id) where status = 'draft';

-- Approval or adoption of one version by one company. Only published versions are shown to staff.
create table policy_publications (
  policy_id uuid not null references policies,
  company_id uuid not null references companies,
  approved_by uuid not null references people,
  approved_at timestamptz not null default now(),
  note text,
  primary key (policy_id, company_id)
);

-- Supplied, opened, acknowledged and explained-with-assistance are separate facts.
create table policy_receipts (
  policy_id uuid not null references policies,
  company_id uuid not null references companies,
  person_id uuid not null references people,
  supplied_at timestamptz not null default now(),
  opened_at timestamptz,
  acknowledged_at timestamptz,
  explained_at timestamptz,
  explained_by uuid references people,
  explained_note text,
  primary key (policy_id, company_id, person_id)
);

-- ───────────── KPI: training up to date (stage 4 could not measure this) ─────────────
alter table kpi_definitions drop constraint kpi_definitions_key_check;
alter table kpi_definitions add constraint kpi_definitions_key_check check (key in ('approved_hours','on_time_starts','visit_coverage','tasks_on_time','clearance','supervision_on_time','development_actions','coaching_hours','training_current'));
insert into kpi_definitions (key, version, title, purpose, formula, sources, unit, direction, target, min_data, owner, limitations, next_step, effective_from) values
 ('training_current', 1, 'Required training up to date', 'Shows whether people have completed the training their company requires for their role.',
  'Required or assigned courses that are current (completed and not past renewal) at the end of the month ÷ all required or assigned courses for current appointments.', 'Training requirements, assignments, training records', 'percent', 'higher', 90, 1, 'HR administrator',
  'Completing training does not prove competence. External certificates count only once verified.', 'Look at overdue courses and agree time in the rota to complete them.', '2025-01-01');

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on function public.training_matrix(date) from anon, authenticated, public';
  end if;
end $$;
