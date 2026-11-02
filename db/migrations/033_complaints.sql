-- Complaints management (2 Nov 2026, owner request): property complaints become full cases with a reference, stage,
-- priority, department, owner, deadline and resolution; a timeline of events; follow-up actions; evidence files;
-- and confidential (HR) cases that only specifically authorised staff can open.

insert into permissions (key, description) values
  ('complaints.view',         'See the complaints workspace and non-confidential complaints'),
  ('complaints.manage',       'Assign, progress, escalate and resolve complaints'),
  ('complaints.confidential', 'Open confidential (HR) complaints')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'complaints.view'), ('super_admin', 'complaints.manage'), ('super_admin', 'complaints.confidential'),
  ('company_admin', 'complaints.view'), ('company_admin', 'complaints.manage'), ('company_admin', 'complaints.confidential'),
  ('hr_admin', 'complaints.view'), ('hr_admin', 'complaints.manage'), ('hr_admin', 'complaints.confidential'),
  ('quality_lead', 'complaints.view'), ('quality_lead', 'complaints.manage'),
  ('manager', 'complaints.view')
on conflict do nothing;

-- A complaint need not be about a property (e.g. an HR complaint).
alter table property_complaints alter column property_id drop not null;
alter table property_complaints drop constraint if exists property_complaints_category_check;
alter table property_complaints add constraint property_complaints_category_check
  check (category in ('noise','cleanliness','repairs','behaviour','staff_conduct','safety','service','communication','hr','other'));
alter table property_complaints drop constraint if exists property_complaints_source_check;
alter table property_complaints add constraint property_complaints_source_check
  check (source in ('resident','neighbour','visitor','staff','family','professional','other'));

alter table property_complaints
  add column ref text unique,
  add column title text check (length(title) <= 200),
  add column stage text not null default 'new' check (stage in ('new','under_review','assigned','in_progress','awaiting_information','resolved','closed')),
  add column priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  add column department text not null default 'support' check (department in ('support','property','repairs','hr','management','finance','other')),
  add column owner_id uuid references people,
  add column due_on date,
  add column resolution text check (length(resolution) <= 8000),
  add column resolved_at timestamptz,
  add column closed_at timestamptz,
  add column confidential boolean not null default false,
  add column escalated boolean not null default false,
  add column escalation_reason text check (length(escalation_reason) <= 2000),
  add column complainant_name text check (length(complainant_name) <= 200),
  add column reminded_on date,          -- last day a deadline reminder went out, so the hourly check sends one a day
  add column updated_at timestamptz not null default now();

-- Existing complaints: references in the order they were logged; stage, owner and deadline from their task.
create sequence complaint_ref_seq;
update property_complaints c set ref = 'CMP-' || to_char(c.created_at at time zone 'Europe/London', 'YYYY') || '-' || lpad(x.n::text, 4, '0')
  from (select id, row_number() over (order by created_at, id) n from property_complaints) x where x.id = c.id;
select setval('complaint_ref_seq', greatest((select count(*) from property_complaints), 1), (select count(*) from property_complaints) > 0);
update property_complaints c set
  owner_id = t.owner_id, due_on = t.due_on,
  stage = case when t.status = 'completed' then 'resolved' when t.status = 'not_started' then 'assigned' else 'in_progress' end,
  resolved_at = t.completed_at,
  priority = case t.priority when 'urgent' then 'urgent' when 'high' then 'high' when 'low' then 'low' else 'medium' end
  from tasks t where t.id = c.task_id;
update property_complaints set department = case category when 'repairs' then 'repairs' when 'staff_conduct' then 'hr' when 'cleanliness' then 'property' when 'safety' then 'property' else 'support' end;
alter table property_complaints alter column ref set not null;

create or replace function complaint_ref() returns trigger language plpgsql as $$
begin
  if new.ref is null then
    new.ref := 'CMP-' || to_char(coalesce(new.created_at, now()) at time zone 'Europe/London', 'YYYY') || '-' || lpad(nextval('complaint_ref_seq')::text, 4, '0');
  end if;
  return new;
end $$;
create trigger complaint_ref before insert on property_complaints for each row execute function complaint_ref();

-- Timeline: every update, note, piece of advice, stage change, assignment, action and escalation.
create table complaint_events (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references property_complaints on delete cascade,
  actor_id uuid references people,
  kind text not null check (kind in ('created','stage','assigned','updated','note','advice','recommendation','evidence','action','action_done','escalated','deescalated','reminder')),
  body text check (length(body) <= 8000),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index complaint_events_case on complaint_events (complaint_id, created_at);
insert into complaint_events (complaint_id, actor_id, kind, body, created_at)
  select id, raised_by, 'created', 'Complaint logged.', created_at from property_complaints;
insert into complaint_events (complaint_id, actor_id, kind, body, meta, created_at)
  select c.id, t.owner_id, 'stage', 'Resolved when the complaint task was completed.', jsonb_build_object('to', 'resolved'), t.completed_at
    from property_complaints c join tasks t on t.id = c.task_id where t.status = 'completed' and t.completed_at is not null;

-- Follow-up actions: each is also a task for its owner, so it shows on their day and in reminders.
create table complaint_actions (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references property_complaints on delete cascade,
  title text not null check (length(title) between 3 and 300),
  owner_id uuid references people,
  due_on date,
  task_id uuid references tasks,
  done_at timestamptz,
  done_by uuid references people,
  created_by uuid not null references people,
  created_at timestamptz not null default now()
);
create index complaint_actions_case on complaint_actions (complaint_id);

-- People specifically authorised to open a confidential complaint (on top of complaints.confidential holders and the owner).
create table complaint_access (
  complaint_id uuid not null references property_complaints on delete cascade,
  person_id uuid not null references people,
  added_by uuid not null references people,
  created_at timestamptz not null default now(),
  primary key (complaint_id, person_id)
);

-- Completing a complaint's task anywhere (e.g. on the Tasks page) resolves the complaint or ticks off the action.
create or replace function complaint_task_done() returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    update property_complaints set stage = 'resolved', resolved_at = coalesce(resolved_at, now()), updated_at = now()
     where task_id = new.id and stage not in ('resolved','closed');
    update complaint_actions set done_at = now(), done_by = new.owner_id where task_id = new.id and done_at is null;
  end if;
  return new;
end $$;
create trigger complaint_task_done after update of status on tasks for each row execute function complaint_task_done();

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint'));

alter table complaint_events enable row level security;
alter table complaint_actions enable row level security;
alter table complaint_access enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
