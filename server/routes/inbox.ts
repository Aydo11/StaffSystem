import { Router } from 'express';
import { q } from '../db.ts';
import { LONDON_TODAY } from '../http.ts';
import { ACTIVE_APPT, type Access, scope } from '../perm.ts';

export type InboxItem = { kind: string; title: string; company_id: string; company_name: string; company_code: string; due: string | null; owner: string; next_step: string; link: string; severity: 'action' | 'review' | 'info' };

// Each item says what happened, which company, who owns it, what happens next and when.
export async function inboxFor(a: Access, company?: unknown): Promise<InboxItem[]> {
  const me = a.personId;
  const C = `c.name as company_name, c.code as company_code, c.id as company_id`;
  const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
  const approve = scope(a, 'visits.approve', company);
  const viewAll = scope(a, 'visits.view_all', company);
  const ts = scope(a, 'timesheets.approve', company);
  const staffEdit = scope(a, 'staff.edit', company);
  const clear = scope(a, 'clearance.decide', company);
  const checks = scope(a, 'checks.manage', company);
  const mine = scope(a, null, company);

  const sets = await Promise.all([
    q(`select 'visit_review' kind, 'Visit by ' || ${name('p')} || ' at ' || pr.name || ' needs your review' title, ${C}, (v.submitted_at at time zone 'Europe/London')::date::text due,
              'You (approver)' owner, 'Approve or return it' next_step, '/visits/' || v.id link, 'review' severity
         from visits v join companies c on c.id = v.company_id join people p on p.id = v.person_id join properties pr on pr.id = v.property_id
        where v.status = 'submitted' and v.company_id = any($1::uuid[]) and v.person_id <> $2`, [approve, me]),
    q(`select 'correction_review' kind, 'Correction requested by ' || ${name('p')} title, ${C}, (vc.created_at at time zone 'Europe/London')::date::text due,
              'You (approver)' owner, 'Compare original and proposed times, then decide' next_step, '/visits/' || v.id link, 'review' severity
         from visit_corrections vc join visits v on v.id = vc.visit_id join companies c on c.id = v.company_id join people p on p.id = vc.requested_by
        where vc.status = 'pending' and v.company_id = any($1::uuid[]) and vc.requested_by <> $2`, [approve, me]),
    q(`select 'time_review' kind, ${name('p')} || ' logged ' || t.minutes || ' min of ' || t.category title, ${C}, t.work_date::text due,
              'You (approver)' owner, 'Approve or reject the time entry' next_step, '/timesheets?tab=review' link, 'review' severity
         from time_entries t join companies c on c.id = t.company_id join people p on p.id = t.person_id
        where t.status = 'submitted' and t.company_id = any($1::uuid[]) and t.person_id <> $2`, [approve, me]),
    q(`select 'timesheet_review' kind, 'Timesheet from ' || ${name('p')} || ' (' || to_char(t.period_start, 'DD Mon') || '–' || to_char(t.period_end, 'DD Mon YYYY') || ')' title, ${C}, (t.submitted_at at time zone 'Europe/London')::date::text due,
              'You (approver)' owner, 'Check the hours and approve or reject' next_step, '/timesheets?tab=review' link, 'review' severity
         from timesheets t join companies c on c.id = t.company_id join people p on p.id = t.person_id
        where t.status = 'submitted' and t.company_id = any($1::uuid[]) and t.person_id <> $2`, [ts, me]),
    q(`select 'missing_clock_out' kind, 'No finish time: ' || ${name('p')} || ' at ' || pr.name || ' since ' || to_char(v.started_at at time zone 'Europe/London', 'DD Mon HH24:MI') title, ${C}, (v.started_at at time zone 'Europe/London')::date::text due,
              case when v.person_id = $2 then 'You' else ${name('p')} end owner, 'Finish the visit or request a correction with the real finish time' next_step, '/visits/' || v.id link, 'action' severity
         from visits v join companies c on c.id = v.company_id join people p on p.id = v.person_id join properties pr on pr.id = v.property_id
        where v.status = 'in_progress' and v.started_at < now() - interval '12 hours' and (v.company_id = any($1::uuid[]) or v.person_id = $2)`, [viewAll, me]),
    q(`select 'checkin_overdue' kind, 'Check-in overdue: ' || ${name('p')} || ' at ' || pr.name title, ${C}, v.expected_end_at::text due,
              case when v.person_id = $2 then 'You' else 'Named contact: ' || coalesce(${name('m')}, 'manager not set') end owner,
              'Contact the worker, then record that you have checked on them. This is not a monitored emergency service.' next_step, '/visits/' || v.id link, 'action' severity
         from visits v join companies c on c.id = v.company_id join people p on p.id = v.person_id join properties pr on pr.id = v.property_id
         join appointments a on a.id = v.appointment_id left join people m on m.id = a.manager_person_id
        where v.status = 'in_progress' and v.expected_end_at < now() and v.checkin_ack_at is null and v.started_at >= now() - interval '12 hours'
          and (v.company_id = any($1::uuid[]) or v.person_id = $2)`, [viewAll, me]),
    q(`select 'visit_returned' kind, 'Visit at ' || pr.name || ' was returned: ' || coalesce(v.decision_note, 'no note') title, ${C}, (v.decided_at at time zone 'Europe/London')::date::text due,
              'You' owner, 'Request a correction if the times were wrong' next_step, '/visits/' || v.id link, 'action' severity
         from visits v join companies c on c.id = v.company_id join properties pr on pr.id = v.property_id
        where v.person_id = $1 and v.status = 'rejected' and v.decided_at > now() - interval '14 days' and v.company_id = any($2::uuid[])
          and not exists (select 1 from visit_corrections vc where vc.visit_id = v.id)`, [me, mine]),
    q(`select case when t.status = 'submitted' then 'task_review' when t.status = 'changes_requested' then 'task_changes' else 'task_overdue' end kind,
              case when t.status = 'submitted' then 'Task submitted for review: ' when t.status = 'changes_requested' then 'Changes requested: ' else 'Overdue task: ' end || t.title title,
              ${C}, t.due_on::text due,
              case when t.status = 'submitted' then 'You (reviewer)' else 'You' end owner,
              case when t.status = 'submitted' then 'Check the evidence; complete or request changes' when t.status = 'changes_requested' then 'Read the comments, update and resubmit' else 'Finish it, or ask your manager to move the deadline' end next_step,
              '/tasks/' || t.id link, case when t.status = 'submitted' then 'review' else 'action' end severity
         from tasks t join companies c on c.id = t.company_id
        where t.company_id = any($2::uuid[]) and (
              (t.status = 'submitted' and t.reviewer_id = $1 and t.owner_id <> $1)
           or (t.status = 'changes_requested' and t.owner_id = $1)
           or (t.status in ('not_started','in_progress') and t.owner_id = $1 and t.due_on < ${LONDON_TODAY}))`, [me, mine]),
    q(`select distinct on (r.id) 'profile_change' kind, ${name('p')} || ' proposed a change to ' || replace(r.field, '_', ' ') title, ${C}, (r.requested_at at time zone 'Europe/London')::date::text due,
              'You (HR)' owner, 'Verify and approve or reject' next_step, '/people/' || p.id link, 'review' severity
         from profile_change_requests r join people p on p.id = r.person_id join appointments a on a.person_id = p.id join companies c on c.id = a.company_id
        where r.status = 'pending' and a.company_id = any($1::uuid[]) and r.person_id <> $2`, [staffEdit, me]),
    q(`select 'clearance_review' kind, 'Clearance review due for ' || ${name('p')} title, ${C}, cc.review_date::text due,
              'You (HR)' owner, 'Review evidence and record a new clearance decision' next_step, '/people/' || p.id link,
              case when cc.review_date < ${LONDON_TODAY} then 'action' else 'info' end severity
         from current_clearance cc join people p on p.id = cc.person_id join companies c on c.id = cc.company_id
        where cc.company_id = any($1::uuid[]) and p.status <> 'left' and (cc.review_date <= ${LONDON_TODAY} + 14 or cc.status = 'pending')`, [clear]),
    q(`select 'check_follow_up' kind, e.label || ' for ' || ${name('p')} || ' needs follow-up' title, ${C}, e.follow_up_on::text due,
              'You (HR)' owner, coalesce(e.actions, 'Follow up and update the check') next_step, '/people/' || p.id link,
              case when e.follow_up_on < ${LONDON_TODAY} then 'action' else 'info' end severity
         from employment_checks e join people p on p.id = e.person_id join companies c on c.id = e.company_id
        where e.company_id = any($1::uuid[]) and e.follow_up_on <= ${LONDON_TODAY} + 3 and e.status not in ('verified','not_required')`, [checks]),
    q(`select 'training_due' kind, coalesce(c2.title, 'Required training') || case when m.status = 'overdue' then ' is overdue' else ' is due soon' end title, ${C}, m.due_on::text due,
              'You' owner, 'Open the course in the Training centre and complete it' next_step, '/training' link, case when m.status = 'overdue' then 'action' else 'info' end severity
         from training_matrix(${LONDON_TODAY}) m join companies c on c.id = m.company_id
         left join lateral (select title from courses x where x.root_id = m.course_root_id and x.status = 'published' order by version desc limit 1) c2 on true
        where m.person_id = $1 and m.company_id = any($2::uuid[]) and (m.status = 'overdue' or (m.status in ('due','expiring') and m.due_on <= ${LONDON_TODAY} + 14))`, [me, mine]),
    q(`select 'policy_ack' kind, 'Please read and acknowledge: ' || p.title title, ${C}, (r.supplied_at at time zone 'Europe/London')::date::text due,
              'You' owner, 'Read it, then press Acknowledge (this means you have read it, not that you agree)' next_step, '/policies/' || p.id || '?company=' || r.company_id link, 'info' severity
         from policy_receipts r join policies p on p.id = r.policy_id join companies c on c.id = r.company_id
        where r.person_id = $1 and r.acknowledged_at is null and r.company_id = any($2::uuid[]) and p.status = 'approved'
          and not exists (select 1 from policies p2 join policy_publications pp on pp.policy_id = p2.id where p2.root_id = p.root_id and p2.version > p.version and pp.company_id = r.company_id)`, [me, mine]),
    q(`select distinct on (qa.id) 'quiz_marking' kind, 'Written answers to mark: ' || c2.title || ' (' || ${name('p')} || ')' title, ${C}, (qa.submitted_at at time zone 'Europe/London')::date::text due,
              'You (trainer)' owner, 'Mark the written answers' next_step, '/training?tab=manage' link, 'review' severity
         from quiz_attempts qa join courses c2 on c2.id = qa.course_id join people p on p.id = qa.person_id
         join appointments ap on ap.person_id = qa.person_id and ap.company_id = any($2::uuid[]) and (c2.company_id is null or c2.company_id = ap.company_id)
         join companies c on c.id = ap.company_id
        where qa.status = 'awaiting_marking' and qa.person_id <> $1`, [me, scope(a, 'training.manage', company)]),
    q(`select distinct on (r.id) 'certificate_verify' kind, 'Certificate to verify: ' || r.title || ' (' || ${name('p')} || ')' title, ${C}, (r.created_at at time zone 'Europe/London')::date::text due,
              'You (trainer)' owner, 'Check the certificate, then verify or reject it' next_step, '/training?tab=manage' link, 'review' severity
         from training_records r join people p on p.id = r.person_id join appointments ap on ap.person_id = r.person_id and ap.company_id = any($2::uuid[]) join companies c on c.id = ap.company_id
        where r.source = 'external' and r.verified_at is null and r.person_id <> $1`, [me, scope(a, 'training.manage', company)]),
    q(`select 'action_owned' kind, 'Action: ' || x.action title, ${C}, x.due_on::text due, 'You' owner,
              case when x.status = 'reopened' then 'More is needed: read the verifier''s note, then add evidence' else 'Do the action, then add evidence of what was done' end next_step,
              '/governance/actions/' || x.id link, case when x.due_on < ${LONDON_TODAY} or x.status = 'reopened' then 'action' else 'info' end severity
         from improvement_actions x join companies c on c.id = x.company_id
        where x.owner_id = $1 and x.status in ('open','reopened') and x.company_id = any($2::uuid[])`, [me, mine]),
    q(`select 'action_verify' kind, 'Evidence to verify: ' || x.action title, ${C}, (x.evidence_at at time zone 'Europe/London')::date::text due, 'You (governance)' owner,
              'Check the evidence, then verify it or ask for more' next_step, '/governance/actions/' || x.id link, 'review' severity
         from improvement_actions x join companies c on c.id = x.company_id
        where x.status = 'evidence_submitted' and x.company_id = any($2::uuid[]) and x.owner_id is distinct from $1`, [me, scope(a, 'governance.manage', company)]),
    q(`select 'effectiveness_review' kind, 'Did it work? Review: ' || x.action title, ${C}, x.effectiveness_review_on::text due, 'You (governance)' owner,
              'Check whether the change worked and whether the issue came back' next_step, '/governance/actions/' || x.id link, 'review' severity
         from improvement_actions x join companies c on c.id = x.company_id
        where x.verified_at is not null and x.effectiveness is null and x.effectiveness_review_on <= ${LONDON_TODAY} + 7 and x.company_id = any($2::uuid[]) and x.owner_id is distinct from $1`, [me, scope(a, 'governance.manage', company)]),
    q(`select 'case_ack' kind, 'Confidential case to acknowledge (' || replace(k.kind, '_', ' ') || ')' title, ${C}, (k.created_at at time zone 'Europe/London')::date::text due, 'You (HR)' owner,
              'Acknowledge it and agree who will investigate' next_step, '/concerns/' || k.id link, 'action' severity
         from cases k join companies c on c.id = k.company_id
        where k.status = 'received' and k.company_id = any($2::uuid[]) and not ($1 = any(k.implicated_ids)) and k.raised_by is distinct from $1 and k.subject_person_id is distinct from $1`, [me, scope(a, 'cases.handle', company)]),
    q(`select 'repair_open' kind, initcap(r.urgency) || ' repair: ' || r.title || ' (' || p.name || ')' title, ${C}, r.due_on::text due, 'You (repairs)' owner,
              case r.status when 'reported' then 'Triage it' when 'awaiting_verification' then 'Check the work and close it' else 'Make sure it is progressing' end next_step,
              '/estates/repairs/' || r.id link, case when r.urgency = 'emergency' or r.due_on < ${LONDON_TODAY} then 'action' else 'review' end severity
         from repairs r join properties p on p.id = r.property_id join companies c on c.id = r.company_id
        where r.company_id = any($1::uuid[]) and (r.status in ('reported','awaiting_verification') or (r.status <> 'closed' and (r.urgency = 'emergency' or r.due_on < ${LONDON_TODAY})))`, [scope(a, 'repairs.manage', company)]),
    q(`select 'safety_overdue' kind, 'Safety check overdue: ' || sr.name || ' (' || p.name || ')' title, ${C}, (last.done_on + sr.interval_days)::text due, 'Responsible: ' || sr.responsible owner,
              'Arrange the check and record the result' next_step, '/estates?property=' || p.id link, 'action' severity
         from safety_requirements sr join properties p on p.id = sr.property_id join companies c on c.id = sr.company_id
         left join lateral (select max(done_on) done_on from safety_checks sc where sc.requirement_id = sr.id) last on true
        where sr.retired_at is null and sr.company_id = any($1::uuid[]) and coalesce(last.done_on + sr.interval_days, sr.created_at::date) < ${LONDON_TODAY}`, [scope(a, 'safety.manage', company)]),
    q(`select 'delivery_failed' kind, 'Email could not be delivered to ' || ${name('p')} title, ${C}, (o.updated_at at time zone 'Europe/London')::date::text due, 'You (administrator)' owner,
              'Check their email address. They still have the in-app notification.' next_step, '/people/' || p.id link, 'review' severity
         from outbound_messages o join people p on p.id = o.person_id join companies c on c.id = o.company_id
        where o.status = 'failed' and o.updated_at > now() - interval '14 days' and o.company_id = any($1::uuid[])`, [scope(a, 'messaging.configure', company)]),
    q(`select 'leave_review' kind, ${name('p')} || ' asked for ' || replace(l.kind, '_', ' ') || ' leave, ' || to_char(l.start_date, 'DD Mon') || '–' || to_char(l.end_date, 'DD Mon') title, ${C}, l.start_date::text due,
              'You (approver)' owner, 'Check cover for their planned visits, then approve or reject' next_step, '/leave' link, case when l.start_date <= ${LONDON_TODAY} + 7 then 'action' else 'review' end severity
         from leave_requests l join companies c on c.id = l.company_id join people p on p.id = l.person_id
        where l.status = 'requested' and l.company_id = any($1::uuid[]) and l.person_id <> $2`, [scope(a, 'leave.approve', company), me]),
    q(`select 'jd_acknowledge' kind, 'Read and acknowledge your job description: ' || j.title || ' (v' || j.version || ')' title, ${C}, (j.published_at at time zone 'Europe/London')::date::text due,
              'You' owner, 'Read it, then press Acknowledge' next_step, '/job-descriptions/' || j.id link, 'action' severity
         from appointments ap join job_descriptions j on j.root_id = ap.job_description_root_id and j.status = 'published' join companies c on c.id = ap.company_id
        where ap.person_id = $1 and ${ACTIVE_APPT('ap')} and ap.company_id = any($2::uuid[])
          and not exists (select 1 from jd_acknowledgements k where k.job_description_id = j.id and k.person_id = $1)`, [me, mine]),
    q(`select 'probation_due' kind, initcap(r.kind) || ' probation review: ' || ${name('p')} title, ${C}, r.due_on::text due, 'You (manager or HR)' owner,
              'Meet them, then record the outcome on their profile' next_step, '/people/' || p.id || '?tab=development' link, case when r.due_on < ${LONDON_TODAY} then 'action' else 'review' end severity
         from probation_reviews r join appointments ap on ap.id = r.appointment_id join people p on p.id = ap.person_id join companies c on c.id = ap.company_id
        where r.outcome = 'pending' and r.due_on <= ${LONDON_TODAY} + 14 and ap.company_id = any($1::uuid[]) and ap.person_id <> $2 and ${ACTIVE_APPT('ap')}`, [scope(a, 'onboarding.manage', company), me]),
    q(`select distinct on (x.person_id, x.competency_id) 'competence_review' kind, 'Competence review due: ' || k.name || ' (' || ${name('p')} || ')' title, ${C}, x.review_due::text due, 'You (assessor)' owner,
              'Observe their practice and record a new assessment' next_step, '/people/' || p.id || '?tab=development' link, 'review' severity
         from competency_assessments x join competencies k on k.id = x.competency_id join people p on p.id = x.person_id join companies c on c.id = k.company_id
        where k.company_id = any($1::uuid[]) and x.person_id <> $2
          and x.review_due <= ${LONDON_TODAY} + 14 and not exists (select 1 from competency_assessments y where y.person_id = x.person_id and y.competency_id = x.competency_id and y.assessed_on > x.assessed_on)
        order by x.person_id, x.competency_id`, [scope(a, 'competence.assess', company), me]),
  ]);
  return sets.flat() as InboxItem[];
}

export const inbox = Router();
inbox.get('/inbox', async (req, res) => res.json(await inboxFor(req.access, req.query.company)));
