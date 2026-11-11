import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useApi } from '../api.ts';
import { fmtDate, fmtDay, fmtMinutes, fmtTime, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Empty, LoadError, PageHead, Skeleton, Status } from '../ui.tsx';
import { RequestHelpDialog } from './Performance.tsx';
import { DayOverview } from './Activity.tsx';
import { StartVisitDialog } from './Visits.tsx';
import { AskHub } from '../askhub.tsx';

export function MyDay() {
  const { me } = useHub();
  const d = useApi<any>('/my-day');
  const [start, setStart] = useState<any>(null);
  const [help, setHelp] = useState(false);
  const props = useApi<any[]>('/properties?mine=true');
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/London' }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = londonToday();
  const todaysPlan = d.data?.scheduled.filter((s: any) => s.planned_start.slice(0, 10) <= today) ?? [];

  const openStart = (s: any) => {
    const p = props.data?.find((x) => x.id === s.property_id);
    setStart({ property: p ?? { id: s.property_id, name: s.property_name, my_appointments: [] }, scheduledVisitId: s.id });
  };

  return (
    <>
      <PageHead title={`${greet}, ${me.person.preferred_name ?? me.person.full_name.split(' ')[0]}`} intro={fmtDate(today)} actions={<Button variant="secondary" onClick={() => setHelp(true)}>Request Help</Button>} />
      <AskHub />
      <DayOverview key={me.person.id} />
      {d.error && <LoadError error={d.error} retry={d.reload} />}
      {d.loading && !d.data ? <Skeleton lines={6} /> : d.data && (
        <>
          <ShiftToday data={d.data} today={today} />
          <div className="kpis">
            <Link to="/inbox" className="kpi card-link"><div className="value">{d.data.inboxCount}</div><div className="label">Needs Your Review</div><div className="explain">Approvals and exceptions with you as owner</div></Link>
            <Link to="/tasks?mine=true" className="kpi card-link"><div className="value">{d.data.tasks.length}</div><div className="label">Open tasks</div><div className="explain">{d.data.tasks.filter((t: any) => t.overdue).length} overdue</div></Link>
            <div className="kpi"><div className="value">{d.data.scheduled.filter((s: any) => !s.missed).length}</div><div className="label">Planned visits</div><div className="explain">Next 7 days (planned, not yet recorded)</div></div>
          </div>

          {me.activeVisit && (
            <div className="notice ok"><strong>You have a visit in progress</strong> at {me.activeVisit.property_name}. <Link to="/visit">Go to the visit timer</Link></div>
          )}

          <div className="grid-2">
            <section className="card" aria-labelledby="plan-h">
              <div className="row between"><h2 id="plan-h">My visit plan</h2><Link to="/properties?mine=true">My properties</Link></div>
              {d.data.scheduled.length === 0 ? <Empty>No visits planned for the next week. You can still <Link to="/properties?mine=true">start a visit</Link> or <Link to="/visits/new">log a completed one</Link>.</Empty> : (
                <ul className="list">
                  {d.data.scheduled.map((s: any) => (
                    <li key={s.id}>
                      <div>
                        <strong>{s.property_name}</strong> <CompanyBadge code={s.company_code} name={s.company_name} />
                        <div className="muted small">{fmtDay(s.planned_start)} at {fmtTime(s.planned_start)} · planned {fmtMinutes(s.planned_minutes)}</div>
                        {s.missed && <Status s="missed" text="Missed — no visit recorded" />}
                      </div>
                      {!me.activeVisit && (todaysPlan.includes(s) || s.missed) && <Button variant="go" onClick={() => openStart(s)}>Start Visit</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="tasks-h">
              <div className="row between"><h2 id="tasks-h">Priority checklist</h2><Link to="/tasks?mine=true">All my tasks</Link></div>
              {d.data.tasks.length === 0 ? <Empty>No open tasks. Nice work.</Empty> : (
                <ul className="list">
                  {d.data.tasks.slice(0, 8).map((t: any) => (
                    <li key={t.id}>
                      <div>
                        <Link to={`/tasks/${t.id}`}><strong>{t.title}</strong></Link> <CompanyBadge code={t.company_code} name={t.company_name} />
                        <div className="muted small">{t.property_name ?? 'No property'} · due {fmtDate(t.due_on)}</div>
                      </div>
                      <div className="row">{t.overdue && <Status s="action" text="Overdue" />}<Status s={t.status} />{t.priority !== 'normal' && <Status s={t.priority} />}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="ho-h">
              <div className="row between"><h2 id="ho-h">Today’s handover</h2><Link to="/handover">Handover</Link></div>
              {d.data.handover.length === 0 ? <Empty>No handover notes for today.</Empty> : (
                <ul className="list">{d.data.handover.map((h: any) => (
                  <li key={h.id}><div><CompanyBadge code={h.company_code} name={h.company_name} /> {h.property_name && <strong>{h.property_name}</strong>}<p style={{ margin: '4px 0 0' }}>{h.body}</p><div className="muted small">From {h.author}</div></div></li>
                ))}</ul>
              )}
            </section>

            <section className="card" aria-labelledby="tools-h">
              <h2 id="tools-h">Quick tools</h2>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 180px), 1fr))' }}>
                <Link className="btn secondary" to="/visits/new">Log Completed Visit</Link>
                <Link className="btn secondary" to="/timesheets?log=1">Log other time</Link>
                <Link className="btn secondary" to="/timesheets">My timesheet</Link>
                <Link className="btn secondary" to="/attendance">My attendance</Link>
                <Link className="btn secondary" to="/profile">My Profile</Link>
                <Link className="btn secondary" to="/tasks?new=1">New task</Link>
              </div>
            </section>
          </div>
        </>
      )}
      {help && <RequestHelpDialog onClose={() => setHelp(false)} />}
      {start && <StartVisitDialog property={start.property} scheduledVisitId={start.scheduledVisitId} onClose={() => setStart(null)} />}
    </>
  );
}


/** "Your shift today": what to do first, in order, with alerts at my houses and their info packs. */
function ShiftToday({ data, today }: { data: any; today: string }) {
  const visits = data.scheduled.filter((s: any) => s.planned_start.slice(0, 10) === today && !s.missed);
  const due = data.tasks.filter((t: any) => t.overdue || t.due_on === today);
  const houses = [...new Map([...visits.map((s: any) => [s.property_id, s.property_name]), ...due.filter((t: any) => t.property_id).map((t: any) => [t.property_id, t.property_name])]).entries()] as [string, string][];
  const steps: [number, string, string][] = [
    [visits.length, `visit${visits.length === 1 ? '' : 's'} planned today`, '#plan-h'],
    [due.length, `task${due.length === 1 ? '' : 's'} due today or overdue`, '#tasks-h'],
    [data.handover.length, `handover note${data.handover.length === 1 ? '' : 's'} for today`, '#ho-h'],
    [data.alerts.length, `alert${data.alerts.length === 1 ? '' : 's'} at your houses`, '#alerts-h'],
  ];
  return (
    <section className="card shift" aria-labelledby="shift-h">
      <h2 id="shift-h">Your shift today</h2>
      <ol className="shift-steps">{steps.map(([n, t, href]) => <li key={t} className={n ? 'has' : ''}><a href={href}><strong>{n}</strong> {t}</a></li>)}</ol>
      {data.alerts.length > 0 && <>
        <h3 id="alerts-h" className="small" style={{ margin: '12px 0 4px' }}>Alerts at your houses</h3>
        <ul className="list">{data.alerts.map((x: any) => <li key={x.kind + x.id}>
          <span><Link to={x.kind === 'repair' ? `/estates/repairs/${x.id}` : `/complaints/${x.id}`}><strong>{x.title}</strong></Link><br />
            <span className="small muted">{x.property_name} · {x.kind === 'repair' ? 'repair' : 'complaint'} since {fmtDate(x.since)}</span></span>
          <Status s={x.kind === 'repair' ? (x.level === 'emergency' ? 'action' : 'warn') : 'info'} text={x.kind === 'repair' ? (x.level === 'emergency' ? 'Emergency repair' : 'Urgent repair') : 'Open complaint'} />
        </li>)}</ul></>}
      {houses.length > 0 && <p className="small" style={{ marginTop: 12 }}>Info packs for today: {houses.map(([id, name], i) => <span key={id}>{i ? ' · ' : ''}<Link to={`/properties/${id}?tab=info`}>{name}</Link></span>)}</p>}
      <p className="small muted" style={{ marginTop: 8 }}>Not sure how to do something? <Link to="/guides">Read the guides</Link>.</p>
    </section>
  );
}
