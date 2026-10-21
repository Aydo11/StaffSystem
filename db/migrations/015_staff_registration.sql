-- Registrations confer no access. A person and appointment exist only after approval.
create table staff_registrations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null,
  password_hash text,
  company_id uuid references companies,
  organisation_name text,
  job_title text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  email_verified_at timestamptz,
  verification_hash text unique,
  verification_expires_at timestamptz,
  last_sent_at timestamptz,
  decided_by uuid references people,
  decided_at timestamptz,
  decision_note text,
  person_id uuid references people,
  created_at timestamptz not null default now(),
  check ((company_id is not null) <> (organisation_name is not null))
);
create unique index staff_registration_email on staff_registrations(lower(email));
alter table staff_registrations enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on staff_registrations from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on staff_registrations from authenticated';
  end if;
end $$;
