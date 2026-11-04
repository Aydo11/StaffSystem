-- Learning platform stages 2–3 (owner request, 4 Nov 2026): assessment settings, more question types (matching, ordering,
-- fill in the blank, file evidence, observed practice), manager approval of completion and course-pack import.
-- No courses, attempts or records are created here.

alter table courses
  add column shuffle_questions boolean not null default false,
  add column shuffle_options boolean not null default false,
  -- What a learner sees after submitting: nothing but the score, right/wrong with explanations, or also the right answers.
  add column show_feedback text not null default 'result' check (show_feedback in ('none','result','answers')),
  -- A pass completes the course only after someone who manages training approves it (for example after an observation).
  add column approval_required boolean not null default false,
  add column imported_from text check (length(imported_from) <= 200);   -- course-pack name, for the audit trail

alter table quiz_attempts drop constraint quiz_attempts_status_check;
alter table quiz_attempts add constraint quiz_attempts_status_check check (status in ('in_progress','awaiting_marking','awaiting_approval','marked'));
alter table quiz_attempts
  add column feedback jsonb,                -- marker comments per question id
  add column approved_by uuid references people,
  add column approved_at timestamptz,
  add column approval_note text check (length(approval_note) <= 2000);

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn','compliance','inspection_item','risk','quiz_attempt'));
