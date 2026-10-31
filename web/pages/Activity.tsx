import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useApi, useSubmit } from '../api.ts';
import { addDays, fmtDate, fmtDateTime, fmtMinutes, fmtTime, label, londonToday, weekStart } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

const isDone = (v: any) => ['submitted', 'approved'].includes(v.status);
const onDay = (value: string, day: string) => londonToday(new Date(value)) === day;

export function DayOverview({ day = londonToday() }: { day?: string }) {
  const hub = useHub();
  const visits = useApi<any[]>(`/visits${hub.q({ from: day, to: day, person: 'me' })}`);
  const schedule = useApi<any[]>(`/schedule?from=${day}&to=${day}`);
  const tasks = useApi<any[]>(`/tasks${hub.q({ mine: 'true' })}`);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const companies = hub.me.companies.filter(c => hub.me.appointments.some(a => a.company_id === c.id && a.status === 'active'));
  const [company, setCompany] = useState('');
  const toast = useToast();
  const refresh = () => { visits.reload(); schedule.reload(); tasks.reload(); };
  useEffect(() => {
    const timer = setInterval(refresh, 60000);
    const focus = () => refresh();
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [day, hub.company]);
  const save = useSubmit(async () => {
    await post('/tasks', { company_id: company, title: title.trim(), due_on: day, owner_id: hub.me.person.id, priority: 'normal', recurrence: 'none', checklist: [] });
    setAdding(false); setTitle(''); tasks.reload(); toast('Daily goal added to your tasks.');
  });
  // useApi retains old data while a new date loads; hide it until the current request completes.
  const rows = visits.loading || visits.error ? [] : visits.data ?? [];
  const done = rows.filter(isDone);
  const plan = schedule.loading || schedule.error ? [] : (schedule.data ?? []).filter(s => s.person_id === hub.me.person.id && (hub.company === 'all' || s.company_id === hub.company));
  const goals = tasks.loading || tasks.error ? [] : (tasks.data ?? []).filter(t => t.due_on?.slice(0, 10) === day);
  const goalsDone = goals.filter(t => t.status === 'completed').length;
  return <section className="card" aria-labelledby="day-results" style={{ marginBottom: 24 }}>
    <div className="row between">
      <div><span className="muted small">MY DAILY RECORD</span><h2 id="day-results" style={{ margin: '4px 0' }}>{day === londonToday() ? 'What I have completed today' : fmtDate(day)}</h2></div>
      <div className="row"><Button variant="ghost" onClick={refresh}>Refresh</Button><Link className="btn secondary" to="/activity">Activity &amp; Calendar</Link><Link className="btn" to="/visits/new">Log Completed Visit</Link></div>
    </div>
    {visits.error && <LoadError error={visits.error} retry={visits.reload} />}
    {visits.loading ? <Skeleton lines={2} /> : !visits.error && <div className="kpis" style={{ marginTop: 16 }}>
      <div className="kpi"><div className="value">{done.length}</div><div className="label">Completed visits</div><div className="explain">Submitted or approved</div></div>
      <div className="kpi"><div className="value">{fmtMinutes(done.reduce((n, v) => n + (v.minutes ?? 0), 0))}</div><div className="label">Recorded visit time</div></div>
      <div className="kpi"><div className="value">{rows.filter(v => v.status === 'in_progress').length}</div><div className="label">In progress</div></div>
      <div className="kpi"><div className="value">{done.filter(v => v.status === 'submitted').length}</div><div className="label">Awaiting manager review</div></div>
    </div>}
    <div className="grid-2">
      <div><h3>My visits</h3>
        {!visits.loading && !visits.error && (rows.length ? <ul className="list">{rows.map(v => <li key={v.id}><div><Link to={`/visits/${v.id}`}><strong>{v.property_name}</strong></Link><div className="small muted">{fmtTime(v.started_at)}–{v.ended_at ? fmtTime(v.ended_at) : 'ongoing'} · {v.ended_at ? fmtMinutes(v.minutes) : 'timer running'} · {label(v.work_category)}</div><div className="small">{v.summary}</div></div><Status s={v.status} /></li>)}</ul> : <Empty>No visits recorded for this day. Your saved visits appear here, including those awaiting review.</Empty>)}
        <Link to={`/attendance?view=day&date=${day}`}>Open full visit history</Link>
        <h3>Visit plan</h3>
        {schedule.error && <LoadError error={schedule.error} retry={schedule.reload} />}
        {schedule.loading ? <Skeleton lines={2} /> : !schedule.error && (plan.length ? <ul className="list">{plan.map(s => <li key={s.id}><div><Link to={`/properties/${s.property_id}`}>{s.property_name}</Link><div className="small muted">{fmtTime(s.planned_start)} · {fmtMinutes(s.planned_minutes)} planned</div></div><Status s={s.missed ? 'missed' : s.status} /></li>)}</ul> : <p className="muted">No visits planned for this day.</p>)}
      </div>
      <div><div className="row between"><h3>Daily goals &amp; tasks</h3><Button variant="secondary" disabled={!companies.length} onClick={() => { setCompany(hub.company !== 'all' && companies.some(c => c.id === hub.company) ? hub.company : companies[0]?.id ?? ''); setAdding(true); }}>Add daily goal</Button></div>
        <p className="small muted">Goals are your assigned tasks due on this date, saved across devices. Open a task to update its checklist or mark it complete.</p>
        {tasks.error && <LoadError error={tasks.error} retry={tasks.reload} />}
        {tasks.loading ? <Skeleton lines={2} /> : !tasks.error && <><p><strong>{goalsDone} of {goals.length} goals completed</strong></p>{goals.length > 0 && <progress value={goalsDone} max={goals.length} aria-label="Daily goals completed" style={{ width: '100%', accentColor: 'var(--teal)' }} />}
          {goals.length ? <ul className="list">{goals.map(t => <li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link><Status s={t.status} /></li>)}</ul> : <Empty>No goals due on this date. Add one to plan your day.</Empty>}</>}
        <Link to="/tasks?mine=true">All my tasks and overdue work</Link>
      </div>
    </div>
    <Dialog open={adding} onClose={() => setAdding(false)} title={`Daily goal for ${fmtDate(day)}`} footer={<Button busy={save.busy} disabled={title.trim().length < 3 || !company} onClick={() => save.run()}>Save goal</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Goal" hint="Property or work task only. Keep resident support details in the support system."><input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Company"><select value={company} onChange={e => setCompany(e.target.value)}><option value="">Choose…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    </Dialog>
  </section>;
}

export function ActivityPage() {
  const hub = useHub();
  const today = londonToday();
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [tab, setTab] = useState<'calendar' | 'visits' | 'site'>('calendar');
  const [team, setTeam] = useState(false);
  const [term, setTerm] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const from = `${month}-01`;
  const nextMonth = (offset: number) => {
    const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset);
    const m = d.toISOString().slice(0, 7); setMonth(m); setDate(`${m}-01`); setBefore(null);
  };
  const end = new Date(`${month}-01T12:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1);
  const to = addDays(end.toISOString().slice(0, 10), -1);
  const canTeam = hub.can('visits.view_all');
  const showTeam = canTeam && team;
  const visits = useApi<any[]>(`/visits${hub.q({ from, to, person: showTeam ? undefined : 'me' })}`);
  const schedule = useApi<any[]>(`/schedule?from=${from}&to=${to}`);
  const events = useApi<any[]>(tab === 'site' ? `/activity-log${hub.q({ from, to, mine: showTeam && hub.can('audit.view') ? undefined : 'true', before })}` : null);
  const ownOrScoped = (s: any) => (showTeam ? hub.me.companies.some(c => c.id === s.company_id && c.perms.includes('visits.view_all')) || s.person_id === hub.me.person.id : s.person_id === hub.me.person.id) && (hub.company === 'all' || s.company_id === hub.company);
  const rows = visits.loading || visits.error ? [] : visits.data ?? [];
  const plans = schedule.loading || schedule.error ? [] : (schedule.data ?? []).filter(ownOrScoped);
  const matches = (s: string) => s.toLowerCase().includes(term.toLowerCase());
  const filtered = rows.filter(v => matches(`${v.property_name} ${v.person_name} ${v.work_category} ${v.summary ?? ''}`));
  const shownEvents = events.loading || events.error ? [] : events.data ?? [];
  const start = weekStart(from), last = addDays(weekStart(to), 6), days: string[] = [];
  for (let d = start; d <= last; d = addDays(d, 1)) days.push(d);
  useEffect(() => {
    const timer = setInterval(() => { visits.reload(); schedule.reload(); if (tab === 'site') events.reload(); }, 60000);
    return () => clearInterval(timer);
  }, [month, hub.company, showTeam, tab, before]);
  const refresh = () => { visits.reload(); schedule.reload(); events.reload(); };
  return <>
    <PageHead title="Activity & Calendar" intro="See property visits, daily plans and recorded activity. Times are shown in UK time. This records work entered in the Hub; it does not track physical location."
      actions={<><Button variant="secondary" onClick={refresh}>Refresh</Button><Link className="btn" to="/visits/new">Log Completed Visit</Link></>} />
    <div className="row between" style={{ marginBottom: 16 }}>
      <Chips label="Activity view" value={tab} onChange={setTab} options={[['calendar', 'Calendar'], ['visits', 'Visit log'], ['site', 'Site activity']]} />
      {canTeam && <Chips label="Whose activity" value={showTeam ? 'team' : 'me'} onChange={v => { setTeam(v === 'team'); setBefore(null); }} options={[['me', 'My activity'], ['team', 'Team activity']]} />}
    </div>
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="row between">
        <div className="row"><Button variant="secondary" onClick={() => nextMonth(-1)} aria-label="Previous month">‹</Button><label>Month <input type="month" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setMonth(e.target.value); setDate(`${e.target.value}-01`); setBefore(null); } }} /></label><Button variant="secondary" onClick={() => nextMonth(1)} aria-label="Next month">›</Button><Button variant="ghost" onClick={() => { setMonth(today.slice(0, 7)); setDate(today); setBefore(null); }}>Today</Button></div>
        <span className="small muted">Updates every minute · {showTeam ? 'Permitted team records' : 'Your records'}</span>
      </div>
      <div style={{ marginTop: 12 }}><label>Find activity <input type="search" value={term} onChange={e => setTerm(e.target.value)} placeholder="Property, person or activity" /></label></div>
    </div>
    {tab !== 'site' && visits.error && <LoadError error={visits.error} retry={visits.reload} />}
    {tab === 'calendar' && schedule.error && <LoadError error={schedule.error} retry={schedule.reload} />}
    {rows.length === 1000 && <div className="notice warn">The visit result limit was reached. Use Visits &amp; attendance in day or week view for a complete smaller period.</div>}
    {tab === 'calendar' && <>
      <section className="card" style={{ marginBottom: 24 }} aria-label="Monthly visit calendar">
        <p className="small muted">Choose a day to see your daily record below. Planned visits and recorded visits are counted separately.</p>
        {visits.loading || schedule.loading ? <Skeleton lines={6} /> : <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 630, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <div key={d} className="small muted" style={{ padding: 8 }}>{d}</div>)}
          {days.map(d => {
            const v = filtered.filter(x => onDay(x.started_at, d));
            const s = plans.filter(x => onDay(x.planned_start, d) && matches(`${x.property_name} ${x.person_name}`));
            return <button key={d} type="button" aria-pressed={date === d} aria-current={d === today ? 'date' : undefined} onClick={() => setDate(d)} style={{ minHeight: 105, textAlign: 'left', padding: 10, borderRadius: 10, border: date === d ? '2px solid var(--teal)' : '1px solid var(--line)', color: 'var(--text)', background: d.slice(0, 7) !== month ? 'var(--bg)' : date === d ? 'var(--teal-50)' : 'var(--card)' }}>
              <strong>{Number(d.slice(-2))}{d === today ? ' · Today' : ''}</strong>
              <div className="small" style={{ marginTop: 8 }}>{v.filter(isDone).length} completed</div>
              <div className="small muted">{s.filter(x => x.status === 'scheduled').length} planned</div>
              {v.some(x => x.status === 'in_progress') && <div className="small" style={{ color: 'var(--teal-text)' }}>● In progress</div>}
            </button>;
          })}
        </div></div>}
      </section>
      <DayOverview key={`${date}-${hub.company}`} day={date} />
      {showTeam && <section className="card"><h2>Team visits · {fmtDate(date)}</h2><VisitRows rows={filtered.filter(v => onDay(v.started_at, date))} team /></section>}
    </>}
    {tab === 'visits' && <section className="card"><h2>{showTeam ? 'Team visit log' : 'My visit log'}</h2>{visits.loading ? <Skeleton lines={6} /> : !visits.error && <VisitRows rows={filtered} team={showTeam} />}</section>}
    {tab === 'site' && <section className="card"><h2>Site activity log</h2><p className="small muted">{showTeam && hub.can('audit.view') ? 'Actions in companies where you have audit permission.' : 'Your own recorded actions.'} Includes visit starts and finishes, task changes, uploads and other audited actions. Viewing a page does not create an activity entry.</p>
      {events.error && <LoadError error={events.error} retry={events.reload} />}
      {events.loading ? <Skeleton lines={6} /> : !events.error && (shownEvents.length ? <ul className="list">{shownEvents.filter(e => matches(`${e.actor_name} ${e.entity} ${e.action} ${e.property_name ?? ''}`)).map(e => <li key={e.id}><div><strong>{label(e.action)}</strong> · {label(e.entity)}{e.property_name && <> · {e.property_name}</>}<div className="small muted">{e.actor_name ?? 'System'} · {fmtDateTime(e.at)} <CompanyBadge code={e.company_code} /></div></div></li>)}</ul> : <Empty>No recorded activity in this period.</Empty>)}
      <div className="row" style={{ marginTop: 16 }}>{before && <Button variant="secondary" onClick={() => setBefore(null)}>Newest</Button>}{shownEvents.length === 200 && <Button variant="secondary" onClick={() => setBefore(String(shownEvents[shownEvents.length - 1].id))}>Older activity</Button>}</div>
    </section>}
  </>;
}

function VisitRows({ rows, team }: { rows: any[]; team: boolean }) {
  return rows.length ? <div className="table-wrap"><table><thead><tr><th>When</th>{team && <th>Who</th>}<th>Property &amp; work</th><th>Duration</th><th>Status</th></tr></thead><tbody>{rows.map(v => <tr key={v.id}>
    <td><Link to={`/visits/${v.id}`}>{fmtDate(v.started_at)}{v.entry_mode !== 'schedule' && <><br />{fmtTime(v.started_at)}–{v.ended_at ? fmtTime(v.ended_at) : 'ongoing'}</>}</Link><div className="small muted">{v.entry_mode === 'schedule' ? 'From weekly schedule' : v.entry_mode === 'manual' ? 'Logged afterwards' : 'Live timer'}</div></td>
    {team && <td>{v.person_name}<br /><CompanyBadge code={v.company_code} /></td>}
    <td><Link to={`/properties/${v.property_id}`}>{v.property_name}</Link><div className="small muted">{label(v.work_category)}</div><div className="small">{v.summary}</div></td><td>{v.ended_at ? fmtMinutes(v.minutes) : 'In progress'}</td><td><Status s={v.status} /></td>
  </tr>)}</tbody></table></div> : <Empty>No visits match this period and search.</Empty>;
}

