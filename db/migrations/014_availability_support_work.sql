-- Support work as a visit type (recorded time is approved automatically), and each person's usual working hours.
alter table visits drop constraint visits_work_category_check;
alter table visits add constraint visits_work_category_check check (work_category in ('inspection','maintenance','cleaning','key_handover','property_check','administration','support_work','other'));

-- {"mon": ["09:00","17:00"], ...}; a missing day means not working. Shown to colleagues so they know when someone is available.
alter table people add column working_hours jsonb not null default '{}';
