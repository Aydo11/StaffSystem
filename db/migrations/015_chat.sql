-- Chat: emoji reactions, and photo-only messages (a picture with no text).
create table message_reactions (
  message_id uuid not null references messages on delete cascade,
  person_id uuid not null references people,
  emoji text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, person_id, emoji)
);
alter table messages drop constraint messages_body_check;
alter table messages add constraint messages_body_check check (length(body) <= 4000 and (length(body) >= 1 or file_id is not null));

alter table message_reactions enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
