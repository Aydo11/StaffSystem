// Phase 3: managing-agent scorecards, monthly summaries, property activity history, issue detection, property health,
// bulk repair changes, per-person dashboard settings and the hourly safety reminders. Everything is computed from
// recorded activity; where nothing was recorded the figure is null and reported as missing data, never as a pass.
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, LONDON_TODAY, notify, parse, text, uuid } from '../http.ts';
import { type Access, can, scope } from '../perm.ts';
import { DONE, propertyAccess } from './estates.ts';
import { visible } from './safety.ts';
import { AGENT_LABEL } from './compliance.ts';
import { CATEGORIES } from '../repairPriority.ts';

export const reports = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const COMPLIANCE_PERMS = ['compliance.view', 'compliance.record', 'compliance.manage'];
const complianceCompanies = (a: Access) => scope(a, null).filter((c) => COMPLIANCE_PERMS.some((p) => can(a, p, c)));

// Safety actions with the property they belong to (inspection items, property risks, scheduled checks, compliance records).
const ACTIONS = `(
  select x.*, i.property_id from improvement_actions x join inspection_items it on it.id = x.source_id join inspections i on i.id = it.inspection_id where x.source_type = 'inspection'
  union all select x.*, r.property_id from improvement_actions x join risks r on r.id = x.source_id where x.source_type = 'risk' and r.property_id is not null
  union all select x.*, sr.property_id from improvement_actions x join safety_checks sc on sc.id = x.source_id join safety_requirements sr on sr.id = sc.requirement_id where x.source_type = 'safety_check'
  union all select x.*, cq.property_id from improvement_actions x join compliance_records cr on cr.id = x.source_id join compliance_requirements cq on cq.id = cr.requirement_id where x.source_type = 'compliance_record')`;
const OPEN_ACTION = `status not in ('verified','closed')`;
const LDATE = (c: string) => `(${c} at time zone 'Europe/London')::date`;

// Per-property facts for a period: activity in the period plus the state today. Compliance only for monitored
// properties the viewer may see compliance for (null otherwise, and the key is removed before sending).
export async function propertyFacts(a: Access, f: { company?: string | null; property?: string | null; from: string; to: string }) {
  const v = await visible(a);
  const rows = await q(`with w as (select $6::date as f, $7::date as t),
      ps as (select p.id, p.name, p.ref, p.company_id, c.code as company_code, p.manager_person_id, ${AGENT_LABEL('p')} as agent,
                    (p.compliance_enabled and p.company_id = any($8::uuid[])) as show_compliance
               from properties p join companies c on c.id = p.company_id
              where p.status <> 'offboarded' and ${v.where} and ($4::uuid is null or p.company_id = $4) and ($5::uuid is null or p.id = $5))
    select ps.*, rep.*, ins.*, rk.*, ac.*, chk.*, cm.*
      from ps cross join w
      left join lateral (select
          count(*) filter (where r.reported_on between w.f and w.t)::int as repairs_reported,
          count(*) filter (where r.status <> 'cancelled' and r.completed_on between w.f and w.t)::int as repairs_completed,
          count(*) filter (where r.status <> 'cancelled' and r.completed_on between w.f and w.t and r.completed_on <= r.due_on)::int as repairs_on_time,
          coalesce(sum(r.completed_on - r.reported_on) filter (where r.status <> 'cancelled' and r.completed_on between w.f and w.t), 0)::int as repair_days,
          count(*) filter (where ${LDATE('r.verified_at')} between w.f and w.t)::int as repairs_verified,
          coalesce(sum(r.cost) filter (where r.status <> 'cancelled' and r.completed_on between w.f and w.t), 0)::float as repair_spend,
          count(*) filter (where r.status <> 'cancelled' and r.completed_on between w.f and w.t and r.cost is null)::int as repair_cost_missing,
          count(*) filter (where r.status not in ${DONE})::int as repairs_open,
          count(*) filter (where r.status not in ${DONE} and r.due_on < ${LONDON_TODAY})::int as repairs_overdue,
          count(*) filter (where r.status not in ${DONE} and r.urgency = 'emergency')::int as emergency_open,
          count(*) filter (where r.status <> 'cancelled' and r.category is not null and r.reported_on between w.f and w.t
             and exists (select 1 from repairs x where x.property_id = r.property_id and x.category = r.category and x.id <> r.id and x.status <> 'cancelled'
                           and x.reported_on between r.reported_on - 90 and r.reported_on and (x.reported_on < r.reported_on or x.created_at < r.created_at)))::int as repairs_repeat
        from repairs r where r.property_id = ps.id) rep on true
      left join lateral (select
          count(*) filter (where ${LDATE('i.inspected_at')} between w.f and w.t)::int as inspections,
          coalesce(sum(i.failed) filter (where ${LDATE('i.inspected_at')} between w.f and w.t), 0)::int as inspection_fails,
          coalesce(sum(i.failed) filter (where i.inspected_at > now() - interval '30 days'), 0)::int as fails_30,
          max(i.inspected_at) as last_inspection
        from inspections i where i.property_id = ps.id) ins on true
      left join lateral (select
          count(*) filter (where ${LDATE('r.created_at')} between w.f and w.t)::int as risks_new,
          count(*) filter (where ${LDATE('r.closed_at')} between w.f and w.t)::int as risks_closed,
          coalesce(sum(${LDATE('r.closed_at')} - ${LDATE('r.created_at')}) filter (where ${LDATE('r.closed_at')} between w.f and w.t), 0)::int as risk_days,
          count(*) filter (where r.status = 'open')::int as risks_open,
          count(*) filter (where r.status = 'open' and r.likelihood * r.impact >= 15)::int as risks_high
        from risks r where r.property_id = ps.id) rk on true
      left join lateral (select
          count(*) filter (where ${LDATE('x.created_at')} between w.f and w.t)::int as actions_opened,
          count(*) filter (where ${LDATE('x.verified_at')} between w.f and w.t)::int as actions_verified,
          count(*) filter (where x.${OPEN_ACTION})::int as actions_open,
          count(*) filter (where x.${OPEN_ACTION} and x.due_on < ${LONDON_TODAY})::int as actions_overdue
        from ${ACTIONS} x where x.property_id = ps.id) ac on true
      left join lateral (select count(*)::int as checks_overdue from safety_requirements sr
          left join lateral (select done_on from safety_checks sc where sc.requirement_id = sr.id order by done_on desc limit 1) last on true
         where sr.property_id = ps.id and sr.retired_at is null and coalesce(last.done_on, sr.created_at::date - sr.interval_days) + sr.interval_days < ${LONDON_TODAY}) chk on true
      left join lateral (select
          count(*) filter (where not cq.not_applicable)::int as compliance_applicable,
          count(*) filter (where not cq.not_applicable and last.outcome <> 'fail' and last.next_due_on >= ${LONDON_TODAY})::int as compliance_compliant,
          count(*) filter (where not cq.not_applicable and last.next_due_on < ${LONDON_TODAY})::int as compliance_overdue,
          count(*) filter (where not cq.not_applicable and last.completed_on is null)::int as compliance_never,
          (select count(*) from compliance_records cr join compliance_requirements c2 on c2.id = cr.requirement_id where c2.property_id = ps.id and cr.completed_on between w.f and w.t)::int as compliance_records,
          (select count(*) from compliance_records cr join compliance_requirements c2 on c2.id = cr.requirement_id where c2.property_id = ps.id and cr.completed_on between w.f and w.t and cr.verified_at is not null)::int as compliance_verified
        from compliance_requirements cq left join lateral (select outcome, completed_on, next_due_on from compliance_records r where r.requirement_id = cq.id order by completed_on desc, created_at desc limit 1) last on true
       where ps.show_compliance and cq.property_id = ps.id and cq.retired_at is null) cm on true
     order by ps.ref`,
    [...v.args, f.company ?? null, f.property ?? null, f.from, f.to, complianceCompanies(a)]);
  return rows.map((r) => {
    if (!r.show_compliance) for (const k of Object.keys(r)) if (k.startsWith('compliance_')) delete r[k];
    return r;
  });
}

// ── Property health: 0–100 from open problems today. Separate from the compliance score and never uses it. ──
export const HEALTH_RULES = [
  { key: 'repairs_overdue', label: ['overdue repair', 'overdue repairs'], each: 10, cap: 30 },
  { key: 'emergency_open', label: ['open emergency repair', 'open emergency repairs'], each: 15, cap: 30 },
  { key: 'risks_high', label: ['high risk', 'high risks'], each: 10, cap: 20 },
  { key: 'fails_30', label: ['failed inspection item in 30 days', 'failed inspection items in 30 days'], each: 5, cap: 20 },
  { key: 'actions_overdue', label: ['overdue safety action', 'overdue safety actions'], each: 5, cap: 20 },
  { key: 'checks_overdue', label: ['overdue scheduled check', 'overdue scheduled checks'], each: 10, cap: 20 },
] as const;
export function health(f: Record<string, any>) {
  const reasons = HEALTH_RULES.filter((r) => f[r.key] > 0).map((r) => ({ label: `${f[r.key]} ${r.label[f[r.key] === 1 ? 0 : 1]}`, points: Math.min(r.cap, r.each * f[r.key]) }));
  const missing = !f.last_inspection || Date.now() - new Date(f.last_inspection).getTime() > 45 * 86400_000 ? ['No inspection recorded in the last 45 days'] : [];
  return { score: Math.max(0, 100 - reasons.reduce((s, r) => s + r.points, 0)), reasons, missing };
}

// ── Scorecards ──
type Rule = { better: 'high' | 'low'; green: number; amber: number; label: string };
export const METRICS: Record<string, Rule> = {
  on_time_pct: { better: 'high', green: 90, amber: 75, label: 'Repairs on time (%)' },
  avg_days: { better: 'low', green: 7, amber: 14, label: 'Average completion (days)' },
  overdue: { better: 'low', green: 0, amber: 2, label: 'Overdue repairs' },
  repeat: { better: 'low', green: 0, amber: 2, label: 'Repeat repairs' },
  inspection_rate: { better: 'high', green: 95, amber: 80, label: 'Properties inspected (%)' },
  outstanding_actions: { better: 'low', green: 2, amber: 5, label: 'Outstanding safety actions' },
  hazard_days: { better: 'low', green: 14, amber: 28, label: 'Average hazard resolution (days)' },
  compliance_score: { better: 'high', green: 95, amber: 85, label: 'Compliance score (monitored only, %)' },
};
export const rag = (v: number | null, t: Rule) => v == null ? 'none' : t.better === 'high' ? (v >= t.green ? 'green' : v >= t.amber ? 'amber' : 'red') : (v <= t.green ? 'green' : v <= t.amber ? 'amber' : 'red');
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : null);
const avg = (n: number, d: number) => (d ? Math.round((10 * n) / d) / 10 : null);

async function thresholds(companyIds: string[]) {
  const saved = await q<{ company_id: string; thresholds: Record<string, { green: number; amber: number }> }>('select company_id, thresholds from scorecard_settings where company_id = any($1::uuid[])', [companyIds]);
  const by = new Map(saved.map((s) => [s.company_id, s.thresholds]));
  return (c: string) => Object.fromEntries(Object.entries(METRICS).map(([k, d]) => [k, { ...d, ...(by.get(c)?.[k] ?? {}) }])) as Record<string, Rule>;
}
const period = (from?: string, to?: string) => one<{ f: string; t: string }>(`select to_char(coalesce($1::date, date_trunc('month', ${LONDON_TODAY})::date), 'YYYY-MM-DD') f, to_char(coalesce($2::date, ${LONDON_TODAY}), 'YYYY-MM-DD') t`, [from ?? null, to ?? null]);

reports.get('/scorecards', async (req, res) => {
  const f = parse(z.object({ company: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
  const w = (await period(f.from, f.to))!;
  const facts = await propertyFacts(req.access, { company: f.company, from: w.f, to: w.t });
  const groups = new Map<string, any[]>();
  for (const p of facts) { const k = `${p.company_id}|${p.agent}`; groups.set(k, [...(groups.get(k) ?? []), p]); }
  const rules = await thresholds([...new Set(facts.map((p) => p.company_id))]);
  const sum = (ps: any[], k: string) => ps.reduce((s, p) => s + (p[k] ?? 0), 0);
  const cards = [...groups.values()].map((ps) => {
    const mon = ps.filter((p) => p.compliance_applicable !== undefined);
    const values: Record<string, number | null> = {
      on_time_pct: pct(sum(ps, 'repairs_on_time'), sum(ps, 'repairs_completed')),
      avg_days: avg(sum(ps, 'repair_days'), sum(ps, 'repairs_completed')),
      overdue: sum(ps, 'repairs_overdue'),
      repeat: sum(ps, 'repairs_repeat'),
      inspection_rate: pct(ps.filter((p) => p.inspections > 0).length, ps.length),
      outstanding_actions: sum(ps, 'actions_open'),
      hazard_days: avg(sum(ps, 'risk_days'), sum(ps, 'risks_closed')),
      compliance_score: mon.length ? pct(sum(mon, 'compliance_compliant'), sum(mon, 'compliance_applicable')) : null,
    };
    const t = rules(ps[0].company_id);
    return { company_id: ps[0].company_id, company_code: ps[0].company_code, agent: ps[0].agent, properties: ps.length, monitored: mon.length,
      repairs_completed: sum(ps, 'repairs_completed'), risks_closed: sum(ps, 'risks_closed'),
      metrics: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, rag: rag(v, t[k]) }])) };
  }).sort((x, y) => x.company_code.localeCompare(y.company_code) || x.agent.localeCompare(y.agent));
  res.json({ from: w.f, to: w.t, metrics: METRICS, cards });
});
reports.get('/scorecards/settings', async (req, res) => {
  const cs = scope(req.access, null, req.query.company);
  const t = await thresholds(cs);
  res.json(cs.map((c) => ({ company_id: c, thresholds: t(c), can_edit: can(req.access, 'safety.manage', c) || can(req.access, 'agents.manage', c) })));
});
const band = z.object({ green: z.coerce.number().min(0).max(1000), amber: z.coerce.number().min(0).max(1000) });
reports.put('/scorecards/settings', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, thresholds: z.partialRecord(z.enum(Object.keys(METRICS) as [string, ...string[]]), band) }), req.body);
  if (!(can(req.access, 'safety.manage', b.company_id) || can(req.access, 'agents.manage', b.company_id))) throw forbidden();
  for (const [k, t] of Object.entries(b.thresholds) as [string, { green: number; amber: number }][])
    if (METRICS[k].better === 'high' ? t.green < t.amber : t.green > t.amber) throw bad(`${METRICS[k].label}: green must be ${METRICS[k].better === 'high' ? 'at least' : 'at most'} amber.`, { fields: { [k]: 'Check the order' } });
  await tx(async (db) => {
    await q(`insert into scorecard_settings (company_id, thresholds, updated_by) values ($1,$2,$3)
             on conflict (company_id) do update set thresholds = excluded.thresholds, updated_by = excluded.updated_by, updated_at = now()`, [b.company_id, JSON.stringify(b.thresholds), req.person.id], db);
    await audit(db, req.person.id, b.company_id, 'scorecard_settings', null, 'update', b.thresholds);
  });
  res.json({ ok: true });
});

// ── Monthly summary: what was done and verified, and separately what is missing ──
reports.get('/safety/monthly', async (req, res) => {
  const f = parse(z.object({ company: uuid.optional(), property: uuid.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), req.query);
  const w = (await one<{ m: string; f: string; t: string }>(`with m as (select coalesce(to_date($1, 'YYYY-MM'), date_trunc('month', ${LONDON_TODAY})::date) d)
     select to_char(d, 'YYYY-MM') m, to_char(d, 'YYYY-MM-DD') f, to_char(least((d + interval '1 month')::date - 1, ${LONDON_TODAY}), 'YYYY-MM-DD') t from m`, [f.month ?? null]))!;
  const facts = await propertyFacts(req.access, { company: f.company, property: f.property, from: w.f, to: w.t });
  const props = facts.map((p) => ({
    id: p.id, name: p.name, ref: p.ref, company_code: p.company_code, agent: p.agent,
    verified: { repairs_completed: p.repairs_completed, repairs_on_time: p.repairs_on_time, repairs_verified: p.repairs_verified, repair_spend: p.repair_spend, inspections: p.inspections,
      inspection_fails: p.inspection_fails, risks_new: p.risks_new, risks_closed: p.risks_closed, actions_opened: p.actions_opened, actions_verified: p.actions_verified,
      ...(p.compliance_applicable !== undefined ? { compliance_records: p.compliance_records, compliance_verified: p.compliance_verified } : {}) },
    open: { repairs_open: p.repairs_open, repairs_overdue: p.repairs_overdue, risks_open: p.risks_open, actions_overdue: p.actions_overdue,
      ...(p.compliance_applicable !== undefined ? { compliance_overdue: p.compliance_overdue } : {}) },
    missing: [
      ...(p.inspections === 0 ? ['No inspection recorded this month'] : []),
      ...(p.repair_cost_missing ? [`${p.repair_cost_missing} completed repair${p.repair_cost_missing === 1 ? '' : 's'} with no cost recorded`] : []),
      ...(p.repairs_completed - p.repairs_verified > 0 ? [`${p.repairs_completed - p.repairs_verified} completed repair${p.repairs_completed - p.repairs_verified === 1 ? '' : 's'} not verified this month`] : []),
      ...(p.compliance_never ? [`${p.compliance_never} compliance item${p.compliance_never === 1 ? '' : 's'} never recorded`] : []),
      ...(p.compliance_records - (p.compliance_verified ?? 0) > 0 ? [`${p.compliance_records - p.compliance_verified} compliance record${p.compliance_records - p.compliance_verified === 1 ? '' : 's'} not verified`] : []),
    ],
    health: health(p).score,
  }));
  const total = (k: 'verified' | 'open', key: string) => props.reduce((s, p) => s + ((p[k] as any)[key] ?? 0), 0);
  res.json({ month: w.m, from: w.f, to: w.t, properties: props,
    totals: { verified: Object.fromEntries(Object.keys(props[0]?.verified ?? {}).map((k) => [k, total('verified', k)])), open: Object.fromEntries(Object.keys(props[0]?.open ?? {}).map((k) => [k, total('open', k)])),
      properties_without_inspection: props.filter((p) => p.verified.inspections === 0).length, properties_with_missing_data: props.filter((p) => p.missing.length).length } });
});

// ── Activity history for one property ──
reports.get('/properties/:id/timeline', async (req, res) => {
  const { p } = await propertyAccess(req.access, idParam(req.params.id));
  const showCompliance = p.compliance_enabled && complianceCompanies(req.access).includes(p.company_id);
  const rows = await q(`select * from (
      select r.created_at as at, 'repair' as kind, 'Repair reported: ' || r.title as title, r.urgency as detail, '/estates/repairs/' || r.id as link from repairs r where r.property_id = $1
      union all select u.created_at, 'repair', 'Repair ' || replace(u.status_to, '_', ' ') || ': ' || r.title, ${name('a')}, '/estates/repairs/' || r.id
        from repair_updates u join repairs r on r.id = u.repair_id join people a on a.id = u.author_id where r.property_id = $1 and u.status_to is not null
      union all select i.inspected_at, 'inspection', 'Inspection: ' || i.name, i.passed || ' passed, ' || i.failed || ' failed, ' || i.not_applicable || ' n/a', '/estates/inspections/' || i.id from inspections i where i.property_id = $1
      union all select r.created_at, 'risk', 'Risk added: ' || r.ref || ' ' || r.title, 'Score ' || (r.likelihood * r.impact), '/estates/risks/' || r.id from risks r where r.property_id = $1
      union all select r.closed_at, 'risk', 'Risk closed: ' || r.ref || ' ' || r.title, null, '/estates/risks/' || r.id from risks r where r.property_id = $1 and r.closed_at is not null
      union all select x.created_at, 'action', 'Action opened: ' || x.action, x.source_type, '/governance/actions/' || x.id from ${ACTIONS} x where x.property_id = $1 and x.source_type <> 'compliance_record'
      union all select x.verified_at, 'action', 'Action verified: ' || x.action, x.source_type, '/governance/actions/' || x.id from ${ACTIONS} x where x.property_id = $1 and x.verified_at is not null and x.source_type <> 'compliance_record'
      union all select sc.created_at, 'check', 'Safety check: ' || sr.name, sc.result, null from safety_checks sc join safety_requirements sr on sr.id = sc.requirement_id where sr.property_id = $1
      union all select cr.created_at, 'compliance', 'Compliance recorded: ' || cq.name, cr.outcome || ' on ' || to_char(cr.completed_on, 'DD Mon YYYY'), null
        from compliance_records cr join compliance_requirements cq on cq.id = cr.requirement_id where cq.property_id = $1 and $2::boolean
    ) t order by at desc limit 300`, [p.id, showCompliance]);
  res.json(rows);
});

// ── Issue detection: patterns in recorded activity ──
reports.get('/safety/insights', async (req, res) => {
  const v = await visible(req.access);
  const args = [...v.args, req.query.company ? parse(uuid, req.query.company) : null, req.query.property ? parse(uuid, req.query.property) : null];
  const where = `p.status <> 'offboarded' and ${v.where} and ($4::uuid is null or p.company_id = $4) and ($5::uuid is null or p.id = $5)`;
  const [repeat, slow, failing] = await Promise.all([
    q(`select p.id as property_id, p.name as property_name, r.category, count(*)::int as count, max(r.reported_on) as last_on
         from repairs r join properties p on p.id = r.property_id where ${where} and r.status <> 'cancelled' and r.category is not null and r.reported_on > ${LONDON_TODAY} - 90
        group by p.id, p.name, r.category having count(*) >= 3 order by count(*) desc`, args),
    q(`select r.id, r.title, r.urgency, r.reported_on, r.due_on, p.id as property_id, p.name as property_name, (${LONDON_TODAY} - r.reported_on) as age_days, greatest(r.due_on - r.reported_on, 1) as target_days
         from repairs r join properties p on p.id = r.property_id where ${where} and r.status not in ${DONE} and r.due_on is not null
          and ${LONDON_TODAY} - r.reported_on > 2 * greatest(r.due_on - r.reported_on, 1) order by age_days desc limit 100`, args),
    q(`select p.id as property_id, p.name as property_name, it.key, min(it.question) as question, count(*)::int as count, max(i.inspected_at) as last_at
         from inspection_items it join inspections i on i.id = it.inspection_id join properties p on p.id = i.property_id
        where ${where} and it.result = 'fail' and i.inspected_at > now() - interval '90 days' group by p.id, p.name, it.key having count(*) >= 2 order by count(*) desc`, args),
  ]);
  res.json({ repeat_categories: repeat, slow_repairs: slow, recurring_failures: failing });
});

// ── Bulk changes to repairs: each one checked and audited as if changed alone ──
reports.post('/repairs/bulk', async (req, res) => {
  const b = parse(z.object({ ids: z.array(uuid).min(1).max(200),
    patch: z.object({ assignee_id: uuid.nullable(), agent_id: uuid.nullable(), contractor: text(200).nullable(), due_on: isoDate.nullable(), category: z.enum(CATEGORIES).nullable() }).partial().strict() }), req.body);
  const keys = Object.keys(b.patch) as (keyof typeof b.patch)[];
  if (!keys.length) throw bad('Choose something to change.');
  const result = await tx(async (db) => {
    const done: string[] = []; const skipped: { id: string; reason: string }[] = [];
    for (const id of new Set(b.ids)) {
      const r = await one('select r.*, p.manager_person_id from repairs r join properties p on p.id = r.property_id where r.id = $1 for update of r', [id], db);
      // Same rule as one repair: a repairs manager for the property (or the repairs lead holding its task).
      const lead = r && (await one('select 1 from tasks where id = $1 and owner_id = $2', [r.task_id, req.person.id], db));
      if (!r || !(can(req.access, 'repairs.manage', r.company_id) || lead)) { skipped.push({ id, reason: 'No permission' }); continue; }
      if (['closed', 'cancelled'].includes(r.status)) { skipped.push({ id, reason: `Repair is ${r.status}` }); continue; }
      if (b.patch.agent_id && !(await one('select 1 from agents where id = $1 and company_id = $2', [b.patch.agent_id, r.company_id], db))) { skipped.push({ id, reason: 'Agent is not in this company' }); continue; }
      if (b.patch.assignee_id && !(await one('select 1 from appointments where person_id = $1 and company_id = $2', [b.patch.assignee_id, r.company_id], db))) { skipped.push({ id, reason: 'Person is not in this company' }); continue; }
      await q(`update repairs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => b.patch[k])], db);
      await audit(db, req.person.id, r.company_id, 'repair', id, 'update', { bulk: true, ...Object.fromEntries(keys.map((k) => [k, { from: r[k] ?? null, to: b.patch[k] }])) });
      if (b.patch.assignee_id && b.patch.assignee_id !== r.assignee_id && b.patch.assignee_id !== req.person.id) await notify(db, b.patch.assignee_id, r.company_id, `Repair assigned to you: ${r.title}`, `/estates/repairs/${id}`);
      done.push(id);
    }
    return { updated: done.length, skipped };
  });
  res.json(result);
});

// ── Per-person settings (dashboard tiles) ──
const prefKey = z.string().regex(/^[a-z0-9_.-]{1,60}$/);
reports.get('/me/preferences/:key', async (req, res) => {
  const r = await one('select value from user_preferences where person_id = $1 and key = $2', [req.person.id, parse(prefKey, req.params.key)]);
  res.json({ value: r?.value ?? null });
});
reports.put('/me/preferences/:key', async (req, res) => {
  const key = parse(prefKey, req.params.key);
  const value = req.body?.value;
  if (value === undefined || JSON.stringify(value).length > 4000) throw bad('Send a small value.');
  await q(`insert into user_preferences (person_id, key, value) values ($1,$2,$3) on conflict (person_id, key) do update set value = excluded.value, updated_at = now()`, [req.person.id, key, JSON.stringify(value)]);
  res.json({ ok: true });
});

// ── Hourly reminders, each sent once ──
export async function safetyReminders() {
  await tx(async (db) => {
    // Repairs due tomorrow: the repairs lead holding the task and whoever is assigned.
    for (const r of await q(`select r.id, r.company_id, r.title, r.assignee_id, t.owner_id, p.name as property_name from repairs r join properties p on p.id = r.property_id left join tasks t on t.id = r.task_id
                              where r.status not in ${DONE} and r.status <> 'completed' and r.due_reminded_at is null and r.due_on = ${LONDON_TODAY} + 1 for update of r skip locked`, [], db)) {
      for (const who of new Set([r.owner_id, r.assignee_id])) if (who) await notify(db, who, r.company_id, `Repair due tomorrow: ${r.title} at ${r.property_name}`, `/estates/repairs/${r.id}`);
      await q('update repairs set due_reminded_at = now() where id = $1', [r.id], db);
    }
    // Safety and compliance actions past their due date: the owner, else the property manager.
    for (const x of await q(`select x.id, x.company_id, x.action, x.owner_id, p.manager_person_id, p.name as property_name from ${ACTIONS} x join properties p on p.id = x.property_id
                              where x.${OPEN_ACTION} and x.due_on < ${LONDON_TODAY} and x.overdue_notified_at is null`, [], db)) {
      const who = x.owner_id ?? x.manager_person_id;
      if (who) await notify(db, who, x.company_id, `Overdue action at ${x.property_name}: ${x.action}`, `/governance/actions/${x.id}`);
      await q('update improvement_actions set overdue_notified_at = now() where id = $1', [x.id], db);
    }
    // Compliance deadlines, monitored properties only, once per due date.
    for (const c of await q(`select cq.id, cq.company_id, cq.name, cq.responsible_id, p.manager_person_id, p.name as property_name, p.id as property_id, last.next_due_on
                               from compliance_requirements cq join properties p on p.id = cq.property_id
                               join lateral (select next_due_on from compliance_records r where r.requirement_id = cq.id order by completed_on desc, created_at desc limit 1) last on true
                              where p.compliance_enabled and cq.retired_at is null and not cq.not_applicable and last.next_due_on <= ${LONDON_TODAY} + cq.reminder_days
                                and cq.reminded_for is distinct from last.next_due_on for update of cq skip locked`, [], db)) {
      const who = c.responsible_id ?? c.manager_person_id;
      const when = (await one<{ s: string }>(`select case when $1::date < ${LONDON_TODAY} then 'overdue since ' else 'due ' end || to_char($1::date, 'DD Mon YYYY') s`, [c.next_due_on], db))!.s;
      if (who) await notify(db, who, c.company_id, `Compliance ${when}: ${c.name} at ${c.property_name}`, `/properties/${c.property_id}?tab=compliance`);
      await q('update compliance_requirements set reminded_for = $2 where id = $1', [c.id, c.next_due_on], db);
    }
  });
}
