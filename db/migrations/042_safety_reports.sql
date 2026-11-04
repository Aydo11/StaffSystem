-- Phase 3 (owner request, 4 Nov 2026): managing-agent scorecards with configurable red/amber/green, monthly reports,
-- reminders for repairs, actions and compliance deadlines, per-user dashboard layout. No records are created here.

-- Red/amber/green thresholds per company: { metric: { green, amber } }. Missing metrics use the defaults in code.
create table scorecard_settings (
  company_id uuid primary key references companies,
  thresholds jsonb not null default '{}',
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);

-- Small per-person settings, such as which dashboard tiles to show.
create table user_preferences (
  person_id uuid not null references people on delete cascade,
  key text not null check (key ~ '^[a-z0-9_.-]{1,60}$'),
  value jsonb not null check (length(value::text) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (person_id, key)
);

-- Each reminder is sent once; these record that it went.
alter table repairs add column due_reminded_at timestamptz;
alter table improvement_actions add column overdue_notified_at timestamptz;
alter table compliance_requirements add column reminded_for date;

alter table scorecard_settings enable row level security;
alter table user_preferences enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
