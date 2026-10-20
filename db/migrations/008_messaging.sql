-- Stage 7b: internal messaging, news, outbound delivery (email, WhatsApp Business) with preferences, templates and an outbox.

insert into permissions (key, description) values
  ('news.publish',       'Write and publish company news'),
  ('messaging.moderate', 'Review reported messages (the reported message only)'),
  ('messaging.configure','Set up WhatsApp senders and templates for the company')
on conflict do nothing;
insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','news.publish'),('super_admin','messaging.moderate'),('super_admin','messaging.configure'),
  ('company_admin','news.publish'),('company_admin','messaging.moderate'),('company_admin','messaging.configure'),
  ('hr_admin','news.publish'),('manager','news.publish'),('quality_lead','news.publish')
) v(r, p) on conflict do nothing;

create table conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  kind text not null check (kind in ('direct','team','property')),
  title text,
  property_id uuid references properties,
  created_by uuid not null references people,
  created_at timestamptz not null default now(),
  check (kind <> 'property' or property_id is not null)
);
create table conversation_members (
  conversation_id uuid not null references conversations on delete cascade,
  person_id uuid not null references people,
  added_by uuid references people,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  left_at timestamptz,
  primary key (conversation_id, person_id)
);
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations,
  author_id uuid not null references people,
  body text not null check (length(body) between 1 and 4000),
  file_id uuid,
  client_request_id uuid unique,
  created_at timestamptz not null default now()
);
create index messages_conversation on messages (conversation_id, created_at);
create table message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages,
  reported_by uuid not null references people,
  reason text not null,
  status text not null default 'open' check (status in ('open','actioned','no_action')),
  reviewed_by uuid references people,
  reviewed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  unique (message_id, reported_by)
);

create table news_posts (
  id uuid primary key default gen_random_uuid(),
  company_ids uuid[] not null check (cardinality(company_ids) >= 1),   -- audience
  category text not null check (category in ('announcement','policy','training','celebration','operations','other')),
  title text not null,
  body text not null,
  image_file_id uuid,
  image_alt text,
  pinned boolean not null default false,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  author_id uuid not null references people,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check (image_file_id is null or image_alt is not null)
);

-- ───────────── Outbound delivery ─────────────
-- Per-person choices. WhatsApp needs an explicit opt-in with the time it was given.
create table messaging_preferences (
  person_id uuid primary key references people,
  email_enabled boolean not null default true,
  whatsapp_number text check (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_opt_in_at timestamptz,
  whatsapp_opt_out_at timestamptz,
  categories text[] not null default '{visit_reminder,training_due,feedback_ready,invoice_available}',
  updated_at timestamptz not null default now()
);
-- Each company sends as itself: its own WhatsApp phone number id. The access token stays in the server environment.
create table messaging_senders (
  company_id uuid not null references companies,
  channel text not null check (channel in ('whatsapp','email')),
  sender_ref text not null,            -- WhatsApp phone_number_id, or the email "from" address
  display_name text not null,
  enabled boolean not null default false,
  primary key (company_id, channel)
);
-- Approved WhatsApp templates (outside the 24-hour window only templates may be sent). Bodies never contain confidential content: they link to the Hub.
create table messaging_templates (
  company_id uuid not null references companies,
  category text not null check (category in ('visit_reminder','training_due','feedback_ready','invoice_available')),
  provider_template text not null,
  language text not null default 'en_GB',
  primary key (company_id, category)
);
create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies,
  person_id uuid references people,
  channel text not null check (channel in ('email','whatsapp')),
  category text not null,
  dedup_key text not null unique,      -- the same reminder is never sent twice
  subject text,
  body text not null,                  -- non-confidential text with a link to sign in
  link text,
  status text not null default 'queued' check (status in ('queued','sending','sent','delivered','read','failed','not_configured','skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbound_due on outbound_messages (next_attempt_at) where status = 'queued';
create unique index outbound_provider_id on outbound_messages (provider_id) where provider_id is not null;
-- Inbound WhatsApp messages: kept for context only. A reply never proves attendance, approves work or authorises a payment.
create table whatsapp_inbound (
  id uuid primary key default gen_random_uuid(),
  provider_message_id text not null unique,
  from_number text not null,
  person_id uuid references people,
  body text,
  received_at timestamptz not null default now()
);

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
