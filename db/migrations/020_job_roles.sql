-- Job roles: a fixed list people pick from (no free-text job titles). Each job role carries an access level,
-- which a current appointment in that role grants in its company (on top of the basic staff access).
create table job_roles (
  key text primary key,
  label text not null unique,
  access_role_key text not null default 'staff' references roles,
  sort int not null default 0
);
insert into job_roles (key, label, access_role_key, sort) values
  ('support_worker',        'Support worker',               'staff',            10),
  ('night_support_worker',  'Night support worker',         'staff',            20),
  ('senior_support_worker', 'Senior support worker',        'staff',            30),
  ('lead_support_worker',   'Lead support worker',          'staff',            40),
  ('team_leader',           'Team leader',                  'manager',          50),
  ('deputy_manager',        'Deputy manager',               'manager',          60),
  ('service_manager',       'Service manager',              'manager',          70),
  ('registered_manager',    'Registered manager',           'manager',          80),
  ('housing_officer',       'Housing officer',              'property_officer', 90),
  ('property_manager',      'Property manager',             'property_officer', 100),
  ('maintenance_operative', 'Maintenance operative',        'maintenance',      110),
  ('cleaner',               'Cleaner',                      'maintenance',      120),
  ('administrator',         'Administrator',                'staff',            130),
  ('compliance_officer',    'Compliance and quality officer','quality_lead',    140),
  ('complaints_manager',    'Complaints manager',           'quality_lead',     150),
  ('hr_officer',            'HR officer',                   'hr_admin',         160),
  ('finance_officer',       'Finance officer',              'finance_admin',    170),
  ('director',              'Director',                     'company_admin',    180);

-- Existing free-text titles stay as they are (basic staff access) until someone picks a job role.
alter table appointments add column job_role_key text references job_roles;
alter table staff_registrations add column job_role_key text references job_roles;
update appointments a set job_role_key = j.key from job_roles j where a.job_role_key is null and lower(trim(a.job_title)) = lower(j.label) and j.access_role_key = 'staff';
update staff_registrations r set job_role_key = j.key from job_roles j where r.job_role_key is null and lower(trim(r.job_title)) = lower(j.label);

alter table job_roles enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
