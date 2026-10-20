import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, useApi, useSubmit } from '../api.ts';
import { addDays, fmtDate, fmtDay, fmtHours, fmtMinutes, label, londonToday, money, weekStart } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

type Tab = 'mine' | 'time' | 'history' | 'review';

export function Timesheets() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const approver = hub.can('timesheets.approve') || hub.can('visits.approve');
  const tab = (params.get('tab') as Tab) ?? (params.get('log') ? 'time' : 'mine');
  const tabs: [Tab, string][] = [['mine', 'My timesheet'], ['time', 'Other working time'], ['history', 'Submitted'], ...(approver ? [['review', 'Review'] as [Tab, string]] : [])];
  return (
    <>
      <PageHead title="Timesheets" intro="Hours come from approved visits and approved other time. Costs are estimates from effective-dated rates — this is not payroll." />
      <Tabs label="Timesheet sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'mine' && <MyTimesheet />}
      {tab === 'time' && <OtherTime />}
      {tab === 'history' && <History mine />}
      {tab === 'review' && approver && <Review />}
    </>
  );
}

function MyTimesheet() {
  const { me } = useHub();
  const toast = useToast();
  const appts = me.appointments.filter((a) => a.status !== 'ended' || (a.end_date && a.end_date >= addDays(londonToday(), -62)));
  const [appt, setAppt] = useState(appts[0]?.id ?? '');
  const [from, setFrom] = useState(weekStart(addDays(londonToday(), -7)));
  const [to, setTo] = useState(addDays(weekStart(addDays(londonToday(), -7)), 6));
  const p = useApi<any>(appt && from && to && to >= from ? `/timesheets/preview?appointment_id=${appt}&from=${from}&to=${to}` : null);
  const submit = useSubmit(async () => {
    const r = await post('/timesheets', { appointment_id: appt, period_start: from, period_end: to });
    toast(r.pending_records ? `Timesheet submitted. ${r.pending_records} record(s) were still awaiting approval and are not included.` : 'Timesheet submitted for approval.');
    p.reload();
  });
  const a = appts.find((x) => x.id === appt);
  const worked = (p.data?.days ?? []).filter((d: any) => d.visit_minutes + d.other_minutes > 0);
  if (!appts.length) return <Empty>You have no appointments with time to submit.</Empty>;
  return (
    <section className="card" aria-labelledby="mt-h">
      <h2 id="mt-h">Build a timesheet</h2>
      <div className="form-grid">
        <Field label="Company and role"><select name="appointment" value={appt} onChange={(e) => setAppt(e.target.value)}>{appts.map((x) => <option key={x.id} value={x.id}>{x.company_name} — {x.job_title}</option>)}</select></Field>
        <Field label="From"><input name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => { const s = weekStart(londonToday()); setFrom(s); setTo(addDays(s, 6)); }}>This week</Button>
        <Button variant="secondary" onClick={() => { const s = weekStart(addDays(londonToday(), -7)); setFrom(s); setTo(addDays(s, 6)); }}>Last week</Button>
      </div>
      {a && <p><CompanyBadge code={a.company_code} name={a.company_name} /> This timesheet is for <strong>{a.company_name}</strong>. Time split to another company appears on that company’s timesheet instead, so nothing is counted twice.</p>}
      {p.error && <LoadError error={p.error} />}
      {p.loading && !p.data ? <Skeleton /> : p.data && (
        <>
          {p.data.pending_records > 0 && <div className="notice warn">{p.data.pending_records} visit(s) or time entries in this period are still waiting for approval and are not counted yet.</div>}
          <div className="kpis">
            <div className="kpi"><div className="value">{fmtHours(p.data.minutes)}</div><div className="label">Approved hours</div><div className="explain">{fmtMinutes(p.data.minutes)}</div></div>
            <div className="kpi"><div className="value">{p.data.cost_estimate === null ? '—' : money(p.data.cost_estimate)}</div><div className="label">Cost estimate</div><div className="explain">{p.data.cost_note}</div></div>
          </div>
          {worked.length === 0 ? <Empty>No approved time in this period.</Empty> : (
            <div className="table-wrap"><table>
              <caption className="sr-only">Approved time by day</caption>
              <thead><tr><th>Day</th><th className="num">Visits</th><th className="num">Other time</th><th>Rate</th><th className="num">Estimate</th></tr></thead>
              <tbody>{worked.map((d: any) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td className="num">{fmtMinutes(d.visit_minutes)}</td><td className="num">{fmtMinutes(d.other_minutes)}</td><td>{d.amount ? `${money(d.amount)} ${label(d.rate_type).toLowerCase()}` : 'No rate'}</td><td className="num">{money(d.cost)}</td></tr>)}</tbody>
            </table></div>
          )}
          <ErrorSummary error={submit.error} />
          <div className="row" style={{ marginTop: 16 }}><Button variant="go" busy={submit.busy} disabled={!p.data.minutes} onClick={() => submit.run()}>Submit timesheet</Button></div>
        </>
      )}
    </section>
  );
}

function OtherTime() {
  const { me } = useHub();
  const toast = useToast();
  const appts = me.appointments.filter((a) => a.status === 'active');
  const [f, setF] = useState({ appointment_id: appts[0]?.id ?? '', work_date: londonToday(), category: 'administration', minutes: '30', note: '' });
  const list = useApi<any[]>(`/time-entries?from=${addDays(londonToday(), -31)}&to=${londonToday()}`);
  const save = useSubmit(async () => { await post('/time-entries', { ...f, minutes: Number(f.minutes), note: f.note || undefined }); toast('Time logged and sent for approval.'); setF({ ...f, note: '' }); list.reload(); });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const mine = (list.data ?? []).filter((t) => t.person_id === me.person.id);
  return (
    <div className="grid-2">
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }} aria-labelledby="ot-h">
        <h2 id="ot-h">Log other working time</h2>
        <p className="small muted">For travel, administration, training, supervision and coaching. Do not log visit time here — it is recorded by the visit itself.</p>
        <ErrorSummary error={save.error} />
        <Field label="Company and role"><select name="appointment_id" value={f.appointment_id} onChange={set('appointment_id')}>{appts.map((a) => <option key={a.id} value={a.id}>{a.company_name} — {a.job_title}</option>)}</select></Field>
        <div className="form-grid">
          <Field label="Date" error={save.error?.fields.work_date}><input name="work_date" type="date" max={londonToday()} value={f.work_date} onChange={set('work_date')} /></Field>
          <Field label="Type"><select name="category" value={f.category} onChange={set('category')}>{['travel', 'administration', 'training', 'supervision', 'coaching', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
          <Field label="Minutes" error={save.error?.fields.minutes}><input name="minutes" type="number" inputMode="numeric" min={5} max={720} value={f.minutes} onChange={set('minutes')} /></Field>
        </div>
        <Field label="Note" optional><input name="note" value={f.note} onChange={set('note')} maxLength={300} /></Field>
        <Button type="submit" busy={save.busy}>Save for review</Button>
      </form>
      <section className="card" aria-labelledby="otl-h">
        <h2 id="otl-h">My recent other time</h2>
        {mine.length === 0 ? <Empty>Nothing logged in the last month.</Empty> : <ul className="list">{mine.map((t) => <li key={t.id}><span>{fmtDate(t.work_date)} · {label(t.category)} · {fmtMinutes(t.minutes)}<br /><CompanyBadge code={t.company_code} name={t.company_name} /></span><Status s={t.status === 'submitted' ? 'submitted' : t.status} /></li>)}</ul>}
      </section>
    </div>
  );
}

function History({ mine, onReturn }: { mine?: boolean; onReturn?: (t: any) => void }) {
  const hub = useHub();
  const list = useApi<any[]>(`/timesheets${hub.q()}`);
  const rows = (list.data ?? []).filter((t) => !mine || t.person_id === hub.me.person.id);
  if (list.loading && !list.data) return <Skeleton />;
  if (!rows.length) return <Empty>No timesheets yet.</Empty>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Period</th><th>Company</th><th className="num">Submitted</th><th className="num">Approved</th><th className="num">Estimate</th><th>Status</th></tr></thead>
      <tbody>{rows.map((t) => <tr key={t.id}><td>{fmtDate(t.period_start)} – {fmtDate(t.period_end)}<div className="muted small">{t.job_title}</div></td><td><CompanyBadge code={t.company_code} name={t.company_name} /></td><td className="num">{fmtHours(t.submitted_minutes)}</td><td className="num">{t.approved_minutes === null ? '—' : fmtHours(t.approved_minutes)}</td><td className="num">{money(t.cost_estimate)}</td><td><Status s={t.status} />{t.decision_note && <div className="muted small">{t.decision_note}</div>}{onReturn && t.status === 'approved' && t.person_id !== hub.me.person.id && hub.can('timesheets.approve', t.company_id) && <div><Button variant="ghost" onClick={() => onReturn(t)}>Return<span className="sr-only"> timesheet for {t.person_name}</span></Button></div>}</td></tr>)}</tbody>
    </table></div>
  );
}

function Review() {
  const hub = useHub();
  const toast = useToast();
  const ts = useApi<any[]>(`/timesheets${hub.q()}`);
  const te = useApi<any[]>(`/time-entries?from=${addDays(londonToday(), -62)}&to=${londonToday()}`);
  const [ret, setRet] = useState<any>(null);
  const [note, setNote] = useState('');
  const decideTs = useSubmit(async (id: string, approve: boolean) => { await post(`/timesheets/${id}/decide`, { approve, note: note || undefined }); setRet(null); setNote(''); toast(approve ? 'Timesheet approved.' : 'Timesheet returned.'); ts.reload(); });
  const decideTe = useSubmit(async (id: string, approve: boolean) => { await post(`/time-entries/${id}/decide`, { approve }); toast(approve ? 'Time approved.' : 'Time not approved.'); te.reload(); });
  const pendingTs = (ts.data ?? []).filter((t) => t.status === 'submitted' && t.person_id !== hub.me.person.id && hub.can('timesheets.approve', t.company_id));
  const pendingTe = (te.data ?? []).filter((t) => t.status === 'submitted' && t.person_id !== hub.me.person.id && hub.can('visits.approve', t.company_id));
  return (
    <div className="stack">
      <ErrorSummary error={decideTs.error ?? decideTe.error} />
      <section className="card" aria-labelledby="rt-h">
        <h2 id="rt-h">Timesheets waiting for you</h2>
        <p className="small muted">You cannot approve your own. Approval recalculates the hours and freezes the rates used, so later rate changes do not alter it.</p>
        {pendingTs.length === 0 ? <Empty>Nothing waiting.</Empty> : <ul className="list">{pendingTs.map((t) => (
          <li key={t.id}><span><strong>{t.person_name}</strong> — {t.job_title} <CompanyBadge code={t.company_code} name={t.company_name} /><br /><span className="muted small">{fmtDate(t.period_start)} – {fmtDate(t.period_end)} · {fmtHours(t.submitted_minutes)} submitted</span></span>
            <span className="row"><Button variant="go" busy={decideTs.busy} onClick={() => decideTs.run(t.id, true)}>Approve</Button><Button variant="secondary" onClick={() => setRet(t)}>Return</Button></span></li>
        ))}</ul>}
      </section>
      <section className="card" aria-labelledby="rte-h">
        <h2 id="rte-h">Other time waiting for you</h2>
        {pendingTe.length === 0 ? <Empty>Nothing waiting.</Empty> : <ul className="list">{pendingTe.map((t) => (
          <li key={t.id}><span><strong>{t.person_name}</strong> · {label(t.category)} · {fmtMinutes(t.minutes)} <CompanyBadge code={t.company_code} name={t.company_name} /><br /><span className="muted small">{fmtDate(t.work_date)}{t.note && ` — ${t.note}`}</span></span>
            <span className="row"><Button variant="go" disabled={decideTe.busy} onClick={() => decideTe.run(t.id, true)}>Approve</Button><Button variant="secondary" disabled={decideTe.busy} onClick={() => decideTe.run(t.id, false)}>Reject</Button></span></li>
        ))}</ul>}
      </section>
      <section aria-labelledby="all-h"><h2 id="all-h">All timesheets</h2><History onReturn={setRet} /></section>
      <Dialog open={!!ret} onClose={() => setRet(null)} title="Return timesheet" variant="modal" footer={<Button variant="danger" busy={decideTs.busy} disabled={!note.trim()} onClick={() => decideTs.run(ret.id, false)}>Return</Button>}>
        <Field label="What needs to change?"><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}

export function Workload() {
  const hub = useHub();
  const [week, setWeek] = useState(weekStart(londonToday()));
  const d = useApi<any[]>(`/workload${hub.q({ week_start: week })}`);
  return (
    <>
      <PageHead title="Workload" intro="Contracted, planned, recorded and approved hours for each current appointment. More hours do not mean better work." />
      <div className="row" style={{ marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => setWeek(addDays(week, -7))}>‹ Previous week</Button>
        <h2 style={{ margin: 0 }} aria-live="polite">Week of {fmtDate(week)}</h2>
        <Button variant="secondary" onClick={() => setWeek(addDays(week, 7))}>Next week ›</Button>
      </div>
      {d.error && <LoadError error={d.error} />}
      {d.loading && !d.data ? <Skeleton /> : (d.data ?? []).length === 0 ? <Empty>No current appointments in view.</Empty> : (
        <div className="table-wrap"><table>
          <caption className="sr-only">Hours by appointment</caption>
          <thead><tr><th>Person</th><th>Company</th><th className="num">Contracted</th><th className="num">Planned</th><th className="num">Recorded</th><th className="num">Approved</th><th>Planned vs contracted</th></tr></thead>
          <tbody>{d.data!.map((r) => {
            const contracted = r.contracted_hours_per_week ? Number(r.contracted_hours_per_week) * 60 : null;
            const pct = contracted ? Math.round((r.scheduled_minutes / contracted) * 100) : null;
            return (
              <tr key={r.appointment_id}>
                <td><Link to={`/people/${r.person_id}`}>{r.person_name}</Link><div className="muted small">{r.job_title}</div></td>
                <td><CompanyBadge code={r.company_code} name={r.company_name} /></td>
                <td className="num">{contracted === null ? 'Not set' : fmtHours(contracted)}</td>
                <td className="num">{fmtHours(r.scheduled_minutes)}</td><td className="num">{fmtHours(r.recorded_minutes)}</td><td className="num">{fmtHours(r.approved_minutes)}</td>
                <td style={{ minWidth: 160 }}>{pct === null ? <span className="muted">Insufficient data</span> : <><div className="bar" aria-hidden="true"><span style={{ width: `${Math.min(pct, 100)}%` }} /></div><span className="small">{pct}% planned{pct > 100 && ' — over contracted hours'}</span></>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </>
  );
}
