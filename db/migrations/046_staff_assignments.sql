-- Staff assignments (owner request, 10 Nov 2026). Managers and support managers can be assigned the staff they manage.
-- Managers already oversee all staff in their company; a support manager oversees only the staff assigned to them.
-- No assignments are created here.

insert into roles (key, label, description, privileged) values
  ('support_manager', 'Support manager', 'Oversees the support staff assigned to them: their visits, time, timesheets, leave and tasks.', false)
on conflict do nothing;
insert into role_permissions (role_key, permission_key) values ('support_manager', 'staff.view') on conflict do nothing;

insert into job_roles (key, label, access_role_key, sort) values ('support_manager', 'Support manager', 'support_manager', 45)
on conflict do nothing;

insert into permissions (key, description) values ('staff.assign', 'Assign staff to managers and support managers') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'staff.assign'), ('company_admin', 'staff.assign'), ('hr_admin', 'staff.assign'), ('manager', 'staff.assign')
on conflict do nothing;

create table staff_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  manager_id uuid not null references people,
  person_id uuid not null references people,
  assigned_by uuid not null references people,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references people,
  check (manager_id <> person_id)
);
create unique index staff_assignments_current on staff_assignments (company_id, manager_id, person_id) where ended_at is null;
create index staff_assignments_manager on staff_assignments (manager_id) where ended_at is null;

alter table staff_assignments enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
