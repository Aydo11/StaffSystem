-- Learning platform, stage 1 of 8 (owner request, 4 Nov 2026): course details for the library and course pages,
-- lesson-by-lesson progress with time spent, personal notes and bookmarks. Existing courses, attempts and records are kept.

alter table courses
  add column category text check (category in ('fundamentals','safeguarding','health_safety','practice','leadership','other')),
  add column difficulty text check (difficulty in ('foundation','intermediate','advanced')),
  add column duration_minutes int check (duration_minutes between 1 and 1200),
  add column audience text check (length(audience) <= 1000),
  add column roles text[] not null default '{}',            -- job_roles keys the course suits (filters and recommendations)
  add column objectives jsonb not null default '[]',        -- ["By the end you can …"]
  add column source_refs jsonb not null default '[]',       -- [{label, url}] legislation and guidance the content relies on
  add column certificate_eligible boolean not null default true,
  add column content_owner text check (length(content_owner) <= 200),
  add column review_on date,
  -- Content that still needs a specialist or legal check is pending_review and cannot be published until approved.
  add column review_status text not null default 'approved' check (review_status in ('pending_review','approved'));

-- One row per learner per lesson. A lesson counts as done only when the learner completes it after spending a minimum
-- time on it (set by its length), never just by opening it.
create table lesson_progress (
  person_id uuid not null references people,
  course_id uuid not null references courses,
  lesson_index int not null check (lesson_index >= 0),
  opened_at timestamptz not null default now(),
  last_beat_at timestamptz not null default now(),
  seconds int not null default 0 check (seconds >= 0),     -- time with the lesson open and visible
  completed_at timestamptz,
  primary key (person_id, course_id, lesson_index)
);
alter table course_progress add column last_opened_at timestamptz;

create table learning_notes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  course_root_id uuid not null,
  lesson_index int not null check (lesson_index >= 0),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index learning_notes_person on learning_notes (person_id, course_root_id);

create table learning_bookmarks (
  person_id uuid not null references people on delete cascade,
  course_root_id uuid not null,
  lesson_index int not null check (lesson_index >= 0),
  created_at timestamptz not null default now(),
  primary key (person_id, course_root_id, lesson_index)
);

alter table lesson_progress enable row level security;
alter table learning_notes enable row level security;
alter table learning_bookmarks enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
