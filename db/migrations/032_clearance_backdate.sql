-- Clearance decisions can carry the day they were actually made (owner request, 2 Nov 2026), so checks done before the Hub
-- existed can be recorded. decided_at is that day; recorded_at is when it was entered, so a backdated entry is always visible.
alter table clearance_decisions add column recorded_at timestamptz not null default now();
update clearance_decisions set recorded_at = decided_at;
create or replace view current_clearance with (security_invoker = true) as
  select distinct on (person_id, company_id) *
  from clearance_decisions
  order by person_id, company_id, decided_at desc;
