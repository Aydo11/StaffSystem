-- Forwarding chat messages (3 Nov 2026, owner request). Anyone can forward a message to other chats they are in;
-- admins and managers can also send it to everyone in a company, through one "Everyone" group per company.
insert into permissions (key, description) values ('messaging.broadcast', 'Send a message to everyone in the company') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'messaging.broadcast'), ('company_admin', 'messaging.broadcast'), ('hr_admin', 'messaging.broadcast'), ('manager', 'messaging.broadcast')
on conflict do nothing;
alter table conversations add column everyone boolean not null default false;
create unique index conversations_everyone on conversations (company_id) where everyone;
alter table messages add column forwarded_from text check (length(forwarded_from) <= 200);
