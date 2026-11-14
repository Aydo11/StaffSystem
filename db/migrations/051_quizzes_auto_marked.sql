-- Quizzes are marked automatically and count at once (13 Nov 2026, owner request): no trainer marking, no manager approval.
-- Written, file and observation questions stay in a quiz for reference but are no longer scored.
update courses set approval_required = false where approval_required;

-- Attempts already waiting are finished the same way, dated the day they were submitted (not today).
with pending as (
  select qa.id, qa.person_id, qa.status, qa.auto_marks, qa.submitted_at, c.pass_mark, c.root_id, c.id as course_id, c.title,
         coalesce((select sum((x->>'marks')::int) from jsonb_array_elements(qa.questions) x where x->>'type' not in ('written','file','observation')), 0) as max
    from quiz_attempts qa join courses c on c.id = qa.course_id
   where qa.status in ('awaiting_marking', 'awaiting_approval')
), scored as (
  select p.*, case when p.status = 'awaiting_approval' then true
                   else p.max = 0 or round(coalesce(p.auto_marks, 0) * 100.0 / p.max) >= p.pass_mark end as ok
    from pending p
), done as (
  update quiz_attempts qa set status = 'marked', passed = s.ok, marked_at = coalesce(qa.marked_at, now()),
         score = case when s.status = 'awaiting_marking' then coalesce(s.auto_marks, 0) else qa.score end,
         max_score = case when s.status = 'awaiting_marking' then s.max else qa.max_score end
    from scored s where qa.id = s.id
  returning qa.id
)
insert into training_records (person_id, course_root_id, course_id, title, source, completed_on, attempt_id, created_by)
select s.person_id, s.root_id, s.course_id, s.title, 'course', (s.submitted_at at time zone 'Europe/London')::date, s.id, s.person_id
  from scored s join done d on d.id = s.id
 where s.ok and not exists (select 1 from training_records r where r.attempt_id = s.id);
