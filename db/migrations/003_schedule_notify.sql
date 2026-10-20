-- Scheduled visits (planned work, "next visit", missed visits), in-app notifications,
-- lone-worker check-in acknowledgement, and a dev/test-only file store.

create table scheduled_visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  person_id uuid not null references people,
  appointment_id uuid not null references appointments,
  planned_start timestamptz not null,
  planned_minutes int not null check (planned_minutes between 5 and 720),  -- planning only, never actual duration
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  visit_id uuid references visits,
  notes text check (length(notes) <= 300),
  created_by uuid references people,
  created_at timestamptz not null default now()
);
create index scheduled_visits_person on scheduled_visits (person_id, planned_start);
create index scheduled_visits_property on scheduled_visits (property_id, planned_start);

-- Lone-worker: someone named acknowledges an overdue check-in. Not a monitored emergency service.
alter table visits add column checkin_ack_by uuid references people;
alter table visits add column checkin_ack_at timestamptz;
alter table visits add column scheduled_visit_id uuid references scheduled_visits;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people,
  company_id uuid references companies,
  title text not null,
  body text,
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_unread on notifications (person_id, created_at desc) where read_at is null;

-- Only used when Supabase Storage is not configured (local development and tests). The server refuses this in production.
create table file_blobs (
  storage_path text primary key references files (storage_path) on delete cascade,
  data bytea not null
);

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit'));

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
