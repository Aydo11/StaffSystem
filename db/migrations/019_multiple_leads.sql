-- Several leads and several deputies per area: one row per person, with their role.
drop index one_current_lead;
alter table governance_leads add column role text not null default 'lead' check (role in ('lead','deputy'));
insert into governance_leads (company_id, area, lead_person_id, role, delegated_authority, from_date, to_date, created_by, created_at)
  select company_id, area, deputy_person_id, 'deputy', null, from_date, to_date, created_by, created_at from governance_leads where deputy_person_id is not null;
alter table governance_leads drop column deputy_person_id;
alter table governance_leads rename column lead_person_id to person_id;
update governance_leads set to_date = current_date where person_id is null and to_date is null; -- "not set" placeholders are no longer needed
update governance_leads g set to_date = current_date where g.role = 'deputy' and g.to_date is null  -- someone named as both keeps the lead role
  and exists (select 1 from governance_leads x where x.company_id = g.company_id and x.area = g.area and x.person_id = g.person_id and x.role = 'lead' and x.to_date is null);
create unique index governance_leads_one_role on governance_leads (company_id, area, person_id) where to_date is null;
