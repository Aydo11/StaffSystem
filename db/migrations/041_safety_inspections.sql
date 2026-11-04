-- Phase 2 of the repairs, property safety and compliance work (owner request, 3 Nov 2026): property inspections from
-- templates, a property risk register and safety actions. Applies to every property (not only compliance-monitored ones).
-- Nothing is created here. Each company gets the standard templates (question lists) the first time templates are
-- listed (server/inspectionTemplates.ts); no inspections, risks or actions are ever created automatically.

create table inspection_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  kind text not null check (kind in ('weekly','monthly','quarterly','communal','fire','damp','room','health_safety')),
  name text not null check (length(name) between 2 and 200),
  interval_days int check (interval_days between 1 and 3660),
  items jsonb not null,                -- [{ key, text }]
  retired_at timestamptz,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  template_id uuid not null references inspection_templates,
  kind text not null,
  name text not null,                  -- the template name at the time
  location text check (length(location) <= 120), -- room or communal area, never a resident's name
  notes text check (length(notes) <= 4000),
  inspector_id uuid not null references people,
  inspected_at timestamptz not null default now(),
  passed int not null default 0, failed int not null default 0, not_applicable int not null default 0
);
create index inspections_property on inspections (property_id, inspected_at desc);

create table inspection_items (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections on delete cascade,
  key text not null,
  question text not null,
  result text not null check (result in ('pass','fail','na')),
  comment text check (length(comment) <= 2000),
  severity text check (severity in ('low','medium','high','critical')),
  owner_id uuid references people,
  follow_up text check (follow_up in ('action','repair')),
  action_id uuid references improvement_actions,
  repair_id uuid references repairs,
  check (result <> 'fail' or (severity is not null and follow_up is not null and length(comment) >= 3))
);
create index inspection_items_inspection on inspection_items (inspection_id);

-- Property risks live in the existing risk register (so assessments and actions are shared); company-wide risks keep property_id null.
alter table risks
  add column property_id uuid references properties,
  add column location text check (length(location) <= 120),
  add column ref text,
  add column target_on date,
  add column closure_note text check (length(closure_note) <= 2000),
  add column closed_by uuid references people,
  add column closed_at timestamptz;
create unique index risks_ref on risks (company_id, ref) where ref is not null;
create index risks_property on risks (property_id) where property_id is not null;

alter table improvement_actions drop constraint improvement_actions_source_type_check;
alter table improvement_actions add constraint improvement_actions_source_type_check
  check (source_type in ('audit','risk','decision','safety_check','agent','meeting','other','compliance_record','inspection'));
alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn','compliance','inspection_item','risk'));

alter table inspection_templates enable row level security;
alter table inspections enable row level security;
alter table inspection_items enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
