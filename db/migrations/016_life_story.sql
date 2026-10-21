-- "My story": a person's own book of chapters showing who they are and why they suit their role.
-- The author chooses who can read it; nobody else can edit it.
alter table people add column story_visibility text not null default 'managers' check (story_visibility in ('private','managers','colleagues'));
alter table people add column story_intro text check (length(story_intro) <= 1000);

create table story_chapters (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  position int not null default 0,
  title text not null check (length(title) between 1 and 120),
  period text check (length(period) <= 60),            -- e.g. "2019 – 2022" or "Growing up"
  body text not null check (length(body) between 1 and 8000),
  photo_file_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index story_chapters_person on story_chapters (person_id, position);

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story'));

alter table story_chapters enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;

-- Plain wording: staff call these "roles", not "appointments" (the table keeps its name).
update permissions set description = 'See everyone''s roles in the company' where key = 'appointments.view';
update permissions set description = 'Add, change and end roles and property allocations' where key = 'appointments.manage';
