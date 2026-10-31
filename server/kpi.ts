import { type Db, q } from './db.ts';

// Counts for every KPI for one company (and optionally one person) in one calendar month, London time.
// Snapshot measures (clearance, supervision) are taken at the end of the month, or today for the current month.
const MEASURES = `
with w as (
  select ($3::date::timestamp at time zone 'Europe/London') s, (($3::date + interval '1 month')::date::timestamp at time zone 'Europe/London') e,
         $3::date ds, ($3::date + interval '1 month')::date de,
         least(($3::date + interval '1 month')::date - 1, (now() at time zone 'Europe/London')::date) snap
),
appts as (
  select a.* from appointments a, w where a.company_id = $1 and ($2::uuid is null or a.person_id = $2)
     and a.start_date <= w.snap and (a.end_date is null or a.end_date >= w.snap) and a.status in ('active','suspended','ended')
),
vm as (select v.*, round(extract(epoch from (v.ended_at - v.started_at)) / 60)::int m from visits v, w
        where v.company_id = $1 and ($2::uuid is null or v.person_id = $2) and v.started_at >= w.s and v.started_at < w.e
          and v.entry_mode <> 'schedule'), -- hours added from the weekly schedule are not evidence for KPIs
sv as (select s.*, v.started_at as actual_start from scheduled_visits s left join visits v on v.id = s.visit_id, w
        where s.company_id = $1 and ($2::uuid is null or s.person_id = $2) and s.status <> 'cancelled' and s.planned_start >= w.s and s.planned_start < w.e),
tk as (select t.*, (t.completed_at at time zone 'Europe/London')::date done_on from tasks t, w
        where t.company_id = $1 and ($2::uuid is null or t.owner_id = $2) and t.due_on >= w.ds and t.due_on < w.de
          and (t.status = 'completed' or t.due_on < (now() at time zone 'Europe/London')::date)),
rp as (select r.* from repairs r left join tasks t on t.id = r.task_id, w
        where r.company_id = $1 and ($2::uuid is null or r.assignee_id = $2 or t.owner_id = $2) and r.due_on >= w.ds and r.due_on < w.de
          and (r.completed_on is not null or r.due_on < (now() at time zone 'Europe/London')::date)),
cp as (select t.*, (t.completed_at at time zone 'Europe/London')::date done_on from property_complaints c join tasks t on t.id = c.task_id, w
        where c.company_id = $1 and ($2::uuid is null or t.owner_id = $2) and t.due_on >= w.ds and t.due_on < w.de
          and (t.status = 'completed' or t.due_on < (now() at time zone 'Europe/London')::date))
select
  (select count(*) from rp)::int as repairs_d,
  (select count(*) from rp where completed_on <= due_on)::int as repairs_n,
  (select count(*) from cp)::int as complaints_d,
  (select count(*) from cp where status = 'completed' and done_on <= due_on)::int as complaints_n,
  (select coalesce(sum(va.minutes), 0) from visit_allocations va join visits v on v.id = va.visit_id and v.entry_mode <> 'schedule' join appointments a on a.id = va.appointment_id, w
    where va.company_id = $1 and ($2::uuid is null or a.person_id = $2) and v.started_at >= w.s and v.started_at < w.e)::int as approved_minutes,
  (select coalesce(sum(planned_minutes), 0) from sv)::int as planned_minutes,
  (select coalesce(sum(m), 0) from vm where status in ('submitted','approved'))::int as recorded_minutes,
  (select coalesce(sum(m), 0) from vm where status = 'submitted')::int as submitted_minutes,
  (select count(*) from sv where status = 'completed' and actual_start is not null)::int as on_time_d,
  (select count(*) from sv where status = 'completed' and actual_start <= planned_start + interval '15 minutes')::int as on_time_n,
  (select count(*) from sv where planned_start + make_interval(mins => planned_minutes) < now())::int as coverage_d,
  (select count(*) from sv where planned_start + make_interval(mins => planned_minutes) < now() and status = 'completed')::int as coverage_n,
  (select count(*) from tk)::int as tasks_d,
  (select count(*) from tk where status = 'completed' and done_on <= due_on)::int as tasks_n,
  (select count(*) from tk where review_id is not null or supervision_id is not null)::int as dev_d,
  (select count(*) from tk where (review_id is not null or supervision_id is not null) and status = 'completed' and done_on <= due_on)::int as dev_n,
  (select count(*) from appts)::int as staff_d,
  (select count(*) from appts a, w where (select cd.status from clearance_decisions cd where cd.person_id = a.person_id and cd.company_id = $1 and cd.decided_at < w.e order by cd.decided_at desc limit 1)
                                          in ('cleared','cleared_with_restrictions'))::int as clearance_n,
  (select count(*) from appts a, w where exists (select 1 from supervisions sp where sp.person_id = a.person_id and sp.company_id = $1 and sp.status = 'completed'
                                                   and sp.held_on <= w.snap and sp.held_on > w.snap - 56))::int as supervision_n,
  (select count(*) from w, training_matrix(w.snap) tm where tm.company_id = $1 and ($2::uuid is null or tm.person_id = $2))::int as training_d,
  (select count(*) from w, training_matrix(w.snap) tm where tm.company_id = $1 and ($2::uuid is null or tm.person_id = $2) and tm.status in ('current','expiring'))::int as training_n,
  (select coalesce(sum(sp.minutes), 0) from supervisions sp, w where sp.company_id = $1 and ($2::uuid is null or sp.person_id = $2) and sp.status = 'completed'
     and sp.kind in ('coaching','mentoring') and sp.held_on >= w.ds and sp.held_on < w.de)::int as coaching_minutes`;

// The definition in force for that month: a company's own version beats the group default, then the latest effective.
const DEFINITIONS = `
select distinct on (key) * from kpi_definitions
 where (company_id = $1 or company_id is null) and effective_from < ($2::date + interval '1 month')
 order by key, (company_id is null), effective_from desc, version desc`;

const ORDER = ['approved_hours', 'on_time_starts', 'visit_coverage', 'tasks_on_time', 'development_actions', 'supervision_on_time', 'clearance', 'training_current', 'repairs_on_time', 'complaints_on_time', 'coaching_hours'];

export type Kpi = { key: string; title: string; unit: string; value: number | null; numerator: number | null; denominator: number | null; target: number | null; status: 'met' | 'below' | 'insufficient' | 'info'; definition: any; hours?: Record<string, number> };

export async function computeKpis(db: Db, companyId: string, personId: string | null, month: string): Promise<Kpi[]> {
  const [m] = await q(MEASURES, [companyId, personId, month], db);
  const defs = new Map((await q(DEFINITIONS, [companyId, month], db)).map((d) => [d.key, d]));
  const counts: Record<string, [number, number]> = {
    on_time_starts: [m.on_time_n, m.on_time_d], visit_coverage: [m.coverage_n, m.coverage_d], tasks_on_time: [m.tasks_n, m.tasks_d],
    development_actions: [m.dev_n, m.dev_d], clearance: [m.clearance_n, m.staff_d], supervision_on_time: [m.supervision_n, m.staff_d], training_current: [m.training_n, m.training_d],
    repairs_on_time: [m.repairs_n, m.repairs_d], complaints_on_time: [m.complaints_n, m.complaints_d],
  };
  return ORDER.filter((k) => defs.has(k)).map((key) => {
    const d = defs.get(key);
    const target = d.target === null ? null : Number(d.target);
    if (d.unit === 'hours') {
      const minutes = key === 'coaching_hours' ? m.coaching_minutes : m.approved_minutes;
      return { key, title: d.title, unit: 'hours', value: Math.round(minutes / 6) / 10, numerator: minutes, denominator: null, target, status: 'info', definition: d,
        hours: key === 'approved_hours' ? { planned: m.planned_minutes, recorded: m.recorded_minutes, submitted: m.submitted_minutes, approved: m.approved_minutes } : undefined };
    }
    const [n, den] = counts[key];
    const enough = den > 0 && den >= d.min_data;
    const value = den ? Math.round((n * 1000) / den) / 10 : null;
    const status = !enough ? 'insufficient' : target === null ? 'info' : (d.direction === 'lower' ? value! <= target : value! >= target) ? 'met' : 'below';
    return { key, title: d.title, unit: 'percent', value: enough ? value : null, numerator: n, denominator: den, target, status, definition: d };
  });
}

// Plain advice for measures below target: what was found, from what, its limits, and a practical next step.
export function adviceFor(kpis: Kpi[], monthLabel: string, scope: string) {
  return kpis.filter((k) => k.status === 'below').map((k) => ({
    key: k.key,
    finding: `${k.title} was ${k.value}% in ${monthLabel}, against a target of ${k.target}%.`,
    source: `${k.numerator} of ${k.denominator} records (${k.definition.sources}), definition version ${k.definition.version}.`,
    context: scope,
    limitation: k.definition.limitations,
    next_step: k.definition.next_step,
  }));
}
