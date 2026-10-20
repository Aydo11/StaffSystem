-- Stage 8a: permission-controlled AI assistant. Off by default per company; every run is a reviewable draft.

insert into permissions (key, description) values
  ('ai.configure', 'Turn the AI assistant on or off and set its limits for the company')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) values ('super_admin', 'ai.configure'), ('company_admin', 'ai.configure') on conflict do nothing;

create table ai_settings (
  company_id uuid primary key references companies,
  enabled boolean not null default false,
  model text not null default 'claude-opus-5-5',
  allowed_roles text[] not null default '{manager,hr_admin,quality_lead,company_admin,super_admin}',
  allowed_tasks text[] not null default '{policy_question,supervision_prep,meeting_minutes,job_description,quiz_draft,management_briefing,quality_check,development_summary}',
  monthly_token_limit int not null default 500000 check (monthly_token_limit >= 0),
  retention_days int not null default 90 check (retention_days between 1 and 3650),
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);
insert into ai_settings (company_id) select id from companies on conflict do nothing;
create function add_ai_settings() returns trigger language plpgsql as $$
begin
  insert into ai_settings (company_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger companies_ai_settings after insert on companies for each row execute function add_ai_settings();

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  person_id uuid not null references people,
  task text not null,
  input jsonb not null,
  sources jsonb not null default '[]',      -- [{id, type, title, version}] — what the model was given
  output jsonb,
  status text not null default 'draft' check (status in ('draft','accepted','amended','dismissed','failed')),
  review_note text,
  reviewed_at timestamptz,
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index ai_runs_company_month on ai_runs (company_id, created_at);

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
