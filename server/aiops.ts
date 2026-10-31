// AI in day-to-day operations: sharing out tasks when someone goes on leave, and a daily report for managers.
// Both work without AI (simple rules and plain figures); when the company has the assistant on, Claude chooses and explains.
import { z } from 'zod';
import { type Db, one, pool, q, tx } from './db.ts';
import { audit, LONDON_TODAY, notify } from './http.ts';
import { ACTIVE_APPT, type Access, companiesWith, myCompanies } from './perm.ts';
import { autoRun, type Source } from './routes/ai.ts';

const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// ── Figures (used by the daily report and "Ask about your organisation's figures") ──
export async function companyFigures(db: Db, companyId: string) {
  const f = await one(`select
      (select count(*)::int from tasks where company_id = $1 and status <> 'completed') as open_tasks,
      (select count(*)::int from tasks where company_id = $1 and status <> 'completed' and due_on < ${LONDON_TODAY}) as overdue_tasks,
      (select count(*)::int from tasks where company_id = $1 and status <> 'completed' and owner_id is null) as unassigned_tasks,
      (select count(*)::int from property_complaints c join tasks t on t.id = c.task_id where c.company_id = $1 and t.status <> 'completed') as open_complaints,
      (select count(*)::int from property_complaints where company_id = $1 and created_at > now() - interval '30 days') as complaints_30_days,
      (select count(*)::int from repairs where company_id = $1 and status <> 'closed') as open_repairs,
      (select count(*)::int from repairs where company_id = $1 and status <> 'closed' and urgency in ('emergency','urgent')) as urgent_repairs,
      (select count(*)::int from visits where company_id = $1 and status = 'submitted') as visits_awaiting_approval,
      (select count(*)::int from visits where company_id = $1 and entry_mode <> 'schedule' and status in ('submitted','approved') and started_at > now() - interval '7 days') as visits_7_days,
      (select count(distinct person_id)::int from leave_requests where company_id = $1 and status = 'approved' and ${LONDON_TODAY} between start_date and end_date) as staff_on_leave_today,
      (select count(*)::int from leave_requests where company_id = $1 and status = 'requested') as leave_to_decide,
      (select round(avg(pc.score))::int from property_condition pc join properties p on p.id = pc.property_id where p.company_id = $1) as average_house_mood`, [companyId], db);
  const lowMood = await q<{ name: string; score: number }>(`select p.name, pc.score from property_condition pc join properties p on p.id = pc.property_id where p.company_id = $1 and pc.score < 60 order by pc.score limit 10`, [companyId], db);
  return { ...f, low_mood_properties: lowMood.map((p) => `${p.name} (${p.score}%)`) };
}
const readable = (k: string) => k.replace(/_/g, ' ');
export async function figureSources(db: Db, companyId: string): Promise<Source[]> {
  const f = await companyFigures(db, companyId);
  return [{ id: 'figures', type: 'figures', title: `Figures on ${new Date().toISOString().slice(0, 10)}`, text: Object.entries(f).map(([k, v]) => `${readable(k)}: ${Array.isArray(v) ? v.join(', ') || 'none' : v ?? 'not enough data'}`).join('\n') }];
}

// A property's records for an audit. Visit notes are left out: they can mention residents.
export async function propertySources(db: Db, companyId: string, propertyId: string): Promise<Source[]> {
  const p = await one('select id, name, ref from properties where id = $1 and company_id = $2', [propertyId, companyId], db);
  if (!p) return [];
  const [cond, complaints, repairs, visits, tasks] = await Promise.all([
    one('select aspects, score, rated_at from property_condition where property_id = $1', [propertyId], db),
    q(`select c.id, c.category, c.source, c.created_at::date as on, t.status from property_complaints c left join tasks t on t.id = c.task_id where c.property_id = $1 order by c.created_at desc limit 20`, [propertyId], db),
    q(`select id, title, urgency, status, due_on from repairs where property_id = $1 order by created_at desc limit 20`, [propertyId], db),
    q(`select work_category, status, started_at::date as on from visits where property_id = $1 and status in ('submitted','approved') order by started_at desc limit 20`, [propertyId], db),
    q(`select id, title, status, due_on from tasks where property_id = $1 and status <> 'completed' order by due_on nulls last limit 20`, [propertyId], db),
  ]);
  return [
    { id: p.id, type: 'property', title: `${p.name}${p.ref ? ` (${p.ref})` : ''}`, text: cond ? `House mood ${cond.score}% (last rated ${String(cond.rated_at).slice(0, 10)}). Stars by area: ${Object.entries(cond.aspects).map(([k, v]) => `${readable(k)} ${v}/5`).join(', ')}` : 'No house mood rating in the last 12 months.' },
    { id: 'complaints', type: 'complaints', title: 'Complaints', text: complaints.map((c) => `- ${c.on}: ${readable(c.category)} from a ${c.source}, ${c.status === 'completed' ? 'resolved' : 'open'} [${c.id}]`).join('\n') || 'None' },
    { id: 'repairs', type: 'repairs', title: 'Repairs', text: repairs.map((r) => `- ${r.title}: ${r.urgency}, ${readable(r.status)}${r.due_on ? `, due ${r.due_on}` : ''} [${r.id}]`).join('\n') || 'None' },
    { id: 'visits', type: 'visits', title: 'Recent visits', text: visits.map((v) => `- ${v.on}: ${readable(v.work_category ?? 'visit')} (${v.status})`).join('\n') || 'None in the records' },
    { id: 'tasks', type: 'tasks', title: 'Open tasks', text: tasks.map((t) => `- ${t.title} (${readable(t.status)}${t.due_on ? `, due ${t.due_on}` : ''}) [${t.id}]`).join('\n') || 'None' },
  ];
}

// ── Leave handover ──
type Candidate = { id: string; name: string; open_tasks: number; property_ids: string[] };
const handoverSchema = z.object({ assignments: z.array(z.object({ task_id: z.string(), person_id: z.string(), reason: z.string() })) });

// When leave is approved, the person's open tasks in that company (due before they are back, or undated) go to colleagues
// who are working then. Claude matches tasks to people using the handover note; anything it does not place sensibly
// goes to the colleague allocated to that property with the fewest open tasks, then to whoever has the fewest.
export async function handOverTasks(leaveId: string, actorId: string) {
  const l = await one(`select l.*, ${name('p')} as person_name from leave_requests l join people p on p.id = l.person_id where l.id = $1 and l.status = 'approved'`, [leaveId]);
  if (!l) return [];
  const tasks = await q<{ id: string; title: string; due_on: string | null; priority: string; property_id: string | null; property_name: string | null }>(
    `select t.id, t.title, t.due_on::text, t.priority, t.property_id, pr.name as property_name from tasks t left join properties pr on pr.id = t.property_id
      where t.company_id = $1 and t.owner_id = $2 and t.status <> 'completed' and (t.due_on is null or t.due_on <= $3)
        and not exists (select 1 from task_handovers h where h.task_id = t.id and h.leave_id = $4) order by t.due_on nulls last`, [l.company_id, l.person_id, l.end_date, leaveId]);
  if (!tasks.length) return [];
  const candidates = await q<Candidate>(`select p.id, ${name('p')} as name,
        (select count(*)::int from tasks t where t.owner_id = p.id and t.company_id = $1 and t.status <> 'completed') as open_tasks,
        coalesce((select array_agg(distinct x.property_id) from appointment_properties x join appointments a2 on a2.id = x.appointment_id
                   where a2.person_id = p.id and a2.company_id = $1 and (x.to_date is null or x.to_date >= ${LONDON_TODAY})), '{}') as property_ids
      from people p where p.status = 'active' and p.id <> $2
       and exists (select 1 from appointments a where a.person_id = p.id and a.company_id = $1 and ${ACTIVE_APPT('a')})
       and not exists (select 1 from leave_requests x where x.person_id = p.id and x.status = 'approved' and daterange(x.start_date, x.end_date, '[]') && daterange($3::date, $4::date, '[]'))
      order by 3, 2`, [l.company_id, l.person_id, l.start_date, l.end_date]);
  if (!candidates.length) {
    await notify(pool, l.person_id, l.company_id, 'Nobody is free to cover your tasks while you are away — please speak to your manager', '/tasks');
    return [];
  }
  const ai = await autoRun(l.company_id, actorId, 'leave_handover',
    `${l.person_name} is on leave from ${l.start_date} to ${l.end_date}. Assign each of their tasks to one of the available colleagues. Follow the handover note where it says who should cover what. Otherwise prefer someone already allocated to the task's property, and spread the work so nobody is overloaded. Give a one-sentence reason for each choice. Use only the task ids and person ids given.`,
    [{ id: 'handover_note', type: 'handover_note', title: 'Handover note written by the person going on leave', text: l.handover_note || 'No note was written.' },
     { id: 'tasks', type: 'tasks', title: 'Tasks to hand over', text: tasks.map((t) => `- task_id ${t.id}: ${t.title} (priority ${t.priority}${t.due_on ? `, due ${t.due_on}` : ''}${t.property_name ? `, property ${t.property_name}` : ''})`).join('\n') },
     { id: 'colleagues', type: 'colleagues', title: 'Colleagues available during the leave', text: candidates.map((c) => `- person_id ${c.id}: ${c.name}, ${c.open_tasks} open tasks${c.property_ids.length ? `, allocated to ${tasks.filter((t) => t.property_id && c.property_ids.includes(t.property_id)).map((t) => t.property_name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'other properties'}` : ''}`).join('\n') }],
    handoverSchema);
  const load = new Map(candidates.map((c) => [c.id, c.open_tasks]));
  const plan = tasks.map((t) => {
    const pick = ai?.assignments.find((x: any) => x.task_id === t.id && load.has(x.person_id));
    let to = pick?.person_id as string | undefined, reason = pick?.reason as string | undefined;
    if (!to) {
      const local = candidates.filter((c) => t.property_id && c.property_ids.includes(t.property_id));
      const pool_ = local.length ? local : candidates;
      to = pool_.reduce((a, b) => (load.get(b.id)! < load.get(a.id)! ? b : a)).id;
      reason = local.length ? `Allocated to ${t.property_name} and has the fewest open tasks there.` : 'Has the fewest open tasks.';
    }
    load.set(to, load.get(to)! + 1);
    return { task: t, to, reason: reason!.slice(0, 500), by_ai: !!pick };
  });
  await tx(async (db) => {
    for (const p of plan) {
      await q('update tasks set owner_id = $2, updated_at = now() where id = $1 and owner_id = $3', [p.task.id, p.to, l.person_id], db);
      await q('insert into task_comments (task_id, author_id, body) values ($1,$2,$3)', [p.task.id, actorId, `Handed over from ${l.person_name} while they are on leave until ${l.end_date}. ${p.reason}`], db);
      await q('insert into task_handovers (leave_id, task_id, from_person, to_person, reason, by_ai) values ($1,$2,$3,$4,$5,$6)', [leaveId, p.task.id, l.person_id, p.to, p.reason, p.by_ai], db);
    }
    for (const to of new Set(plan.map((p) => p.to))) {
      const n = plan.filter((p) => p.to === to).length;
      await notify(db, to, l.company_id, `You are covering ${n} task${n === 1 ? '' : 's'} for ${l.person_name} while they are on leave until ${l.end_date}`, '/tasks', l.handover_note ? `Their handover note: ${l.handover_note}` : undefined);
    }
    await notify(db, l.person_id, l.company_id, `${plan.length} of your task${plan.length === 1 ? ' was' : 's were'} handed over while you are on leave`, '/leave');
    await audit(db, actorId, l.company_id, 'leave', leaveId, 'handover', { tasks: plan.length, by_ai: plan.filter((p) => p.by_ai).length });
  });
  return plan.map((p) => ({ task_id: p.task.id, title: p.task.title, to: p.to, to_name: candidates.find((c) => c.id === p.to)!.name, reason: p.reason, by_ai: p.by_ai }));
}

// ── Daily report ──
const reportSchema = z.object({ headline: z.string(), priorities: z.array(z.string()), risks: z.array(z.string()), going_well: z.array(z.string()) });

// One report per company per day. Managers (anyone who can see everyone's performance) are told it is ready.
export async function dailyReport(companyId: string, force = false) {
  const today = (await one<{ d: string }>(`select ${LONDON_TODAY}::text d`))!.d;
  if (!force && await one('select 1 from ai_reports where company_id = $1 and report_date = $2', [companyId, today])) return null;
  const figures = await companyFigures(pool, companyId);
  const summary = await autoRun(companyId, null, 'daily_report',
    'Write a short daily report for the managers from these figures. Lead with what needs action today (overdue tasks, urgent repairs, open complaints, low house mood, approvals waiting). Then risks to watch, then what is going well. Be specific and quote the figures.',
    await figureSources(pool, companyId), reportSchema);
  const r = await one(`insert into ai_reports (company_id, report_date, figures, summary) values ($1,$2,$3,$4)
                         on conflict (company_id, report_date) do update set figures = excluded.figures, summary = excluded.summary, created_at = now() returning *`, [companyId, today, JSON.stringify(figures), summary ? JSON.stringify(summary) : null]);
  const headline = summary?.headline ?? `${figures.overdue_tasks} overdue tasks, ${figures.open_complaints} open complaints, ${figures.urgent_repairs} urgent repairs`;
  const managers = await q<{ id: string }>(`select distinct p.id from people p where p.status = 'active' and (
      exists (select 1 from role_grants g join role_permissions rp on rp.role_key = g.role_key where g.person_id = p.id and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
               and rp.permission_key = 'performance.view_all' and (g.company_id = $1 or g.role_key = 'super_admin'))
      or exists (select 1 from appointments a join job_roles j on j.key = a.job_role_key join role_permissions rp on rp.role_key = j.access_role_key
                  where a.person_id = p.id and a.company_id = $1 and ${ACTIVE_APPT('a')} and rp.permission_key = 'performance.view_all'))`, [companyId]);
  for (const m of managers) await notify(pool, m.id, companyId, `Daily report: ${headline}`.slice(0, 300), '/assistant?tab=reports');
  return r;
}
export async function dailyReports() {
  for (const c of await q<{ id: string }>('select id from companies')) await dailyReport(c.id);
}

// ── "Ask the Hub" on My Day: the person's own day, who is off, and (for managers) their teams' figures ──
export async function myDaySources(a: Access): Promise<Source[]> {
  const me = a.personId;
  const { inboxFor } = await import('./routes/inbox.ts');
  const offCos = companiesWith(a, 'staff.view');
  const [tasks, plan, off, myLeave, handover, inbox] = await Promise.all([
    q(`select t.title, t.due_on::text, t.priority, t.status, c.code, p.name as property from tasks t join companies c on c.id = t.company_id left join properties p on p.id = t.property_id
        where t.owner_id = $1 and t.status <> 'completed' order by t.due_on nulls last limit 40`, [me]),
    q(`select (s.planned_start at time zone 'Europe/London')::text as starts, s.planned_minutes, p.name as property, c.code from scheduled_visits s join properties p on p.id = s.property_id join companies c on c.id = s.company_id
        where s.person_id = $1 and s.status = 'scheduled' and s.planned_start >= now() - interval '12 hours' and s.planned_start < now() + interval '7 days' order by s.planned_start`, [me]),
    // Who is away: names and dates only, never the type of leave.
    q(`select distinct ${name('p')} as name, l.start_date::text, l.end_date::text, c.code from leave_requests l join people p on p.id = l.person_id join companies c on c.id = l.company_id
        where l.status = 'approved' and l.end_date >= ${LONDON_TODAY} and l.start_date <= ${LONDON_TODAY} + 7 and l.company_id = any($1::uuid[]) order by l.start_date::text, name`, [offCos]),
    q(`select start_date::text, end_date::text, status from leave_requests where person_id = $1 and status in ('requested','approved') and end_date >= ${LONDON_TODAY} order by start_date`, [me]),
    q(`select h.body, p.name as property, c.code from handover_notes h join companies c on c.id = h.company_id left join properties p on p.id = h.property_id
        where h.company_id = any($1::uuid[]) and h.for_date = ${LONDON_TODAY} order by h.created_at desc limit 20`, [myCompanies(a)]),
    inboxFor(a),
  ]);
  const today = (await one<{ d: string }>(`select ${LONDON_TODAY}::text d`))!.d;
  const line = (r: any) => Object.entries(r).filter(([, v]) => v != null).map(([k, v]) => `${readable(k)}: ${v}`).join(', ');
  const out: Source[] = [
    { id: 'today', type: 'date', title: 'Today', text: `Today is ${today} (London).` },
    { id: 'my_tasks', type: 'tasks', title: 'My open tasks', text: tasks.map((t) => `- ${line(t)}`).join('\n') || 'None' },
    { id: 'my_plan', type: 'planned_visits', title: 'My planned visits (next 7 days)', text: plan.map((v) => `- ${line(v)}`).join('\n') || 'None planned' },
    { id: 'needs_review', type: 'inbox', title: 'Needs my review', text: inbox.slice(0, 40).map((i: any) => `- ${i.title}${i.due ? ` (due ${i.due})` : ''}`).join('\n') || 'Nothing waiting' },
    { id: 'who_is_off', type: 'leave', title: 'Colleagues away today or in the next 7 days', text: off.map((l) => `- ${l.name} (${l.code}): ${l.start_date} to ${l.end_date}`).join('\n') || 'Nobody' },
    { id: 'my_leave', type: 'leave', title: 'My upcoming leave', text: myLeave.map((l) => `- ${l.start_date} to ${l.end_date} (${l.status})`).join('\n') || 'None' },
    { id: 'handover', type: 'handover', title: "Today's handover notes", text: handover.map((h) => `- ${h.property ? `${h.property}: ` : ''}${h.body}`).join('\n') || 'None' },
  ];
  for (const c of companiesWith(a, 'performance.view_all').slice(0, 3)) {
    const code = (await one<{ code: string }>('select code from companies where id = $1', [c]))!.code;
    out.push({ ...(await figureSources(pool, c))[0], id: `figures_${code}`, title: `Company figures for ${code}` });
  }
  return out;
}
