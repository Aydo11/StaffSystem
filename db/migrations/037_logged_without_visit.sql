-- Complaints and house mood findings logged without a visit (3 Nov 2026, owner request): e.g. a complaint taken on a
-- phone call, or findings from dropping in. `channel` records how it reached us; 'visit' when logged from a visit.
alter table property_complaints add column channel text check (channel in ('visit','phone','in_person','email','text','letter','other'));
update property_complaints set channel = 'visit' where visit_id is not null;
alter table condition_ratings add column channel text not null default 'visit' check (channel in ('visit','phone','in_person','other'));
