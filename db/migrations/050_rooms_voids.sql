-- Rooms and voids (13 Nov 2026, owner request). Rooms belong to an existing property; nothing is created for any property
-- until its manager sets the rooms up. No resident names, support needs or other personal details are held here.
--
-- Who can see and change rooms:
--   * the property's manager (properties.manager_person_id): view and update that property's rooms;
--   * voids.view_all in a company: see every property's rooms in that company (overview); voids.manage_all: also update them;
--   * super administrators: everything. Nobody else, unless given one of the roles below.

insert into permissions (key, description) values
  ('voids.view_all',   'See rooms and voids for every property in the company'),
  ('voids.manage_all', 'Update rooms and voids for every property in the company')
on conflict do nothing;
insert into roles (key, label, description, privileged) values
  ('voids_overview', 'Voids overview',  'Senior manager view of rooms and voids across the company (read only).', false),
  ('voids_manager',  'Voids manager',   'View and update rooms and voids for every property in the company.', false)
on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'voids.view_all'), ('super_admin', 'voids.manage_all'),
  ('company_admin', 'voids.view_all'), ('company_admin', 'voids.manage_all'),
  ('voids_overview', 'voids.view_all'),
  ('voids_manager', 'voids.view_all'), ('voids_manager', 'voids.manage_all')
on conflict do nothing;

create table property_rooms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  label text not null check (length(trim(label)) between 1 and 40),
  position int not null,
  status text not null default 'not_set' check (status in ('not_set','available','filled','unavailable')),
  size text check (size in ('single','double')),
  bathroom text check (bathroom in ('ensuite','shared')),
  floor text check (floor in ('lower_ground','ground','first','second','third_plus')),
  description text check (length(description) <= 600),        -- matching details, e.g. "Ground-floor double near the entrance"
  access_notes text check (length(access_notes) <= 600),      -- factual access facts only, e.g. "Two steps at the front door"
  unavailable_reason text check (length(unavailable_reason) <= 200),
  status_changed_at timestamptz,
  version int not null default 1,                              -- optimistic locking: a stale update is refused, never overwritten
  archived_at timestamptz,
  archived_by uuid references people,
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A room can only be available once its size, bathroom and floor are known.
  check (status <> 'available' or (size is not null and bathroom is not null and floor is not null))
);
create unique index property_rooms_label on property_rooms (property_id, lower(trim(label))) where archived_at is null;
create index property_rooms_property on property_rooms (property_id) where archived_at is null;

-- One row per void: opened when a room becomes available, closed when it is filled (or blocked, set back, archived).
create table room_voids (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references property_rooms,
  started_at timestamptz not null default now(),
  started_by uuid references people,
  ended_at timestamptz,
  ended_by uuid references people,
  outcome text check (outcome in ('filled','unavailable','not_set','archived'))
);
create unique index room_voids_open on room_voids (room_id) where ended_at is null;

-- Every change: who, when, old and new values. Undo is a new row pointing at the one it reverses.
create table room_events (
  id bigserial primary key,
  room_id uuid not null references property_rooms,
  actor_id uuid references people,
  at timestamptz not null default now(),
  kind text not null check (kind in ('created','status','details','label','photo_added','photo_removed','archived')),
  from_value jsonb,
  to_value jsonb,
  undo_of bigint references room_events
);
create index room_events_room on room_events (room_id, at desc);

create table room_photos (
  file_id uuid primary key references files on delete cascade,
  room_id uuid not null references property_rooms,
  added_at timestamptz not null default now()
);
create index room_photos_room on room_photos (room_id);
alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn','compliance','inspection_item','risk','quiz_attempt','property_info','room'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on property_rooms, room_voids, room_events, room_photos from anon, authenticated, public';
  end if;
end $$;
alter table property_rooms enable row level security;
alter table room_voids enable row level security;
alter table room_events enable row level security;
alter table room_photos enable row level security;
