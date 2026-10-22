-- "Ask about your day" on My Day: open to all staff once the company's assistant is on.
alter table ai_settings alter column allowed_tasks set default '{policy_question,supervision_prep,meeting_minutes,job_description,quiz_draft,management_briefing,quality_check,development_summary,analytics_question,property_audit,ask_hub}';
update ai_settings set allowed_tasks = allowed_tasks || '{ask_hub}'::text[] where not ('ask_hub' = any(allowed_tasks));
