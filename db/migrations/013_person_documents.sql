-- Staff documents (CVs, certificates, references) on a person's profile, and photos attached to visits.
-- No new tables, so the RLS/revoke block does not need re-running.
alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc'));
