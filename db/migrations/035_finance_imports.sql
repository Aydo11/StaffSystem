-- Remittances and quick expenses (2 Nov 2026, owner request). A remittance from a managing agent or RSL is recorded as
-- bank items that share a remittance_id: gross income per property plus each fee or deduction, adding up to the net paid.
alter table finance_transactions add column remittance_id uuid;
create index finance_transactions_remittance on finance_transactions (remittance_id) where remittance_id is not null;
alter table finance_transactions drop constraint finance_transactions_source_check;
alter table finance_transactions add constraint finance_transactions_source_check check (source in ('manual','import','payment','remittance'));
