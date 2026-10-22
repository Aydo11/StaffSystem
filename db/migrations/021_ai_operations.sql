-- AI in day-to-day operations: leave handovers that share out tasks, daily reports, and two more assistant tasks.

-- What the person on leave says needs covering. Used to choose who takes each task when the leave is approved.
alter table leave_requests add column handover_note text check (length(handover_note) <= 4000);

-- Every task moved because of leave, who it went to and why (the AI's reason, or the fallback rule).
create table task_handovers (
  id uuid primary key default gen_random_uuid(),
  leave_id uuid not null references leave_requests on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  from_person uuid not null references people,
  to_person uuid not null references people,
  reason text not null,
  by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  unique (leave_id, task_id)
);

-- One report per company per day: the figures always, and the AI's summary when the assistant is on.
create table ai_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  report_date date not null,
  figures jsonb not null,
  summary jsonb,
  created_at timestamptz not null default now(),
  unique (company_id, report_date)
);

-- Automatic runs (reports) have no person behind them.
alter table ai_runs alter column person_id drop not null;

alter table ai_settings alter column allowed_tasks set default '{policy_question,supervision_prep,meeting_minutes,job_description,quiz_draft,management_briefing,quality_check,development_summary,analytics_question,property_audit}';
update ai_settings set allowed_tasks = allowed_tasks || '{analytics_question,property_audit}'::text[] where not ('analytics_question' = any(allowed_tasks));

alter table task_handovers enable row level security;
alter table ai_reports enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
