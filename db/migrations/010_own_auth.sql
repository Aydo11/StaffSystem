-- Sign-in without Supabase: passwords (scrypt), authenticator-app codes (TOTP), server-side sessions,
-- one-time links for invitations and password resets. Files already live in file_blobs (database storage).

alter table people drop column auth_user_id;
alter table people
  add column password_hash text,                 -- scrypt; null until the person sets a password from their invitation link
  add column totp_secret text,                   -- base32; set during setup, active once totp_enabled_at is set
  add column totp_enabled_at timestamptz,
  add column totp_last_step bigint,              -- last accepted 30-second step, so a code cannot be replayed
  add column failed_logins int not null default 0,
  add column locked_until timestamptz;

-- Only a SHA-256 of each token is stored: a database leak does not hand out live sessions or links.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  token_hash text not null unique,
  aal text not null check (aal in ('aal1','aal2')),   -- aal2 = password plus authenticator code
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_person on sessions (person_id);

create table auth_tokens (
  token_hash text primary key,
  person_id uuid not null references people on delete cascade,
  purpose text not null check (purpose in ('invite','reset','mfa')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_person on auth_tokens (person_id);

alter table sessions enable row level security;
alter table auth_tokens enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
