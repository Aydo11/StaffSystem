// Complaints workspace: overview, register, reports and a page for each case. Who is responsible, what has happened,
// what happens next and when it is due are on every row and at the top of every case.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';
import { StatStrip } from './Governance.tsx';
import { CHANNELS, CHANNEL_TEXT } from '../condition.tsx';

export const STAGES: [string, string, string][] = [
  ['new', 'New', 'Review it and give it an owner'],
  ['under_review', 'Under review', 'Agree who owns it and the deadline'],
  ['assigned', 'Assigned', 'Owner to start the investigation'],
  ['in_progress', 'In progress', 'Finish the investigation and respond'],
  ['awaiting_information', 'Awaiting information', 'Chase the information needed'],
  ['resolved', 'Resolved', 'Check the complainant is satisfied, then close'],
  ['closed', 'Closed', 'No further action'],
];
const STAGE_NAME = Object.fromEntries(STAGES.map(([k, t]) => [k, t]));
const STAGE_TONE: Record<string, string> = { new: 'action', under_review: 'review', assigned: 'info', in_progress: 'info', awaiting_information: 'review', resolved: 'verified', closed: 'completed' };
const OPEN = ['new', 'under_review', 'assigned', 'in_progress', 'awaiting_information'];
const CATEGORIES: [string, string][] = [['noise', 'Noise'], ['cleanliness', 'Cleanliness'], ['repairs', 'Repairs'], ['behaviour', 'Behaviour'], ['staff_conduct', 'Staff conduct'], ['safety', 'Safety'], ['service', 'Service'], ['communication', 'Communication'], ['hr', 'HR'], ['other', 'Other']];
const DEPTS: [string, string][] = [['support', 'Support'], ['property', 'Property'], ['repairs', 'Repairs'], ['hr', 'HR'], ['management', 'Management'], ['finance', 'Finance'], ['other', 'Other']];
const SOURCES: [string, string][] = [['resident', 'Resident'], ['family', 'Family member'], ['neighbour', 'Neighbour'], ['visitor', 'Visitor'], ['professional', 'Professional (e.g. council, social worker)'], ['staff', 'Staff member'], ['other', 'Other']];
const PRIORITIES: [string, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']];
const PRIORITY_TONE: Record<string, string> = { low: 'low', medium: 'normal', high: 'high', urgent: 'urgent' };
const name = (list: [string, string][], k: string) => list.find(([x]) => x === k)?.[1] ?? label(k);

const isOpen = (c: any) => OPEN.includes(c.stage);
const daysBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400e3);
const dueSoon = (c: any) => isOpen(c) && c.due_on && !c.overdue && daysBetween(londonToday(), c.due_on.slice(0, 10)) <= 7;
const nextStep = (c: any) => (c.next_action ? `${c.next_action.title}${c.next_action.due_on ? ` (by ${fmtDate(c.next_action.due_on)})` : ''}` : STAGES.find(([k]) => k === c.stage)?.[2] ?? '');
const caseTitle = (c: any) => c.title || `${name(CATEGORIES, c.category)} complaint${c.property_name ? ` at ${c.property_name}` : ''}`;
const monthKey = (d: string) => d.slice(0, 7);
const monthName = (k: string) => new Date(`${k}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

type Tab = 'overview' | 'register' | 'reports';
type Filters = { q: string; category: string; property: string; department: string; priority: string; owner: string; stage: string; from: string; to: string; quick: string };
const NO_FILTERS: Filters = { q: '', category: '', property: '', department: '', priority: '', owner: '', stage: '', from: '', to: '', quick: '' };

export function Complaints() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const d = useApi<{ cases: any[]; can: { view: string[]; manage: string[]; confidential: string[] } }>('/complaints');
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [adding, setAdding] = useState(false);
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => setParams({ tab: t });
  const cases = (d.data?.cases ?? []).filter((c) => hub.company === 'all' || c.company_id === hub.company);
  const workspace = !!d.data && (d.data.can.view.length > 0 || d.data.can.confidential.length > 0);
  const show = (quick: string) => { setF({ ...NO_FILTERS, quick }); setTab('register'); };

  return (
    <>
      <PageHead title="Complaints" intro={workspace ? 'Every complaint in one place: who is responsible, what has happened, what happens next and when it is due.' : 'Complaints you logged or are helping with. To log one (a phone call is fine, no visit needed), open the property and choose Log a complaint.'}
        actions={workspace && <Button onClick={() => setAdding(true)}><Icon name="plus" size={18} />Log a complaint</Button>} />
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton lines={6} /> : !workspace ? <CaseRows cases={cases} /> : (
        <>
          <Tabs label="Complaints sections" tabs={[['overview', 'Overview'], ['register', `Register (${cases.length})`], ['reports', 'Reports']]} value={tab} onChange={setTab} />
          {tab === 'overview' && <Overview cases={cases} show={show} />}
          {tab === 'register' && <Register cases={cases} f={f} setF={setF} />}
          {tab === 'reports' && <Reports cases={cases} />}
        </>
      )}
      {adding && d.data && <NewComplaint companies={[...new Set([...d.data.can.view, ...d.data.can.confidential])]} confidential={d.data.can.confidential} onClose={() => setAdding(false)} />}
    </>
  );
}

function Overview({ cases, show }: { cases: any[]; show: (q: string) => void }) {
  const hub = useHub();
  const open = cases.filter(isOpen);
  const overdueActions = cases.reduce((n, c) => n + (c.overdue_actions ?? 0), 0);
  const attention = open.filter((c) => c.overdue || c.escalated || c.overdue_actions > 0 || !c.owner_id || dueSoon(c))
    .sort((a, b) => Number(b.escalated) - Number(a.escalated) || Number(b.overdue) - Number(a.overdue) || String(a.due_on ?? '9').localeCompare(String(b.due_on ?? '9')));
  const mine = open.filter((c) => c.owner_id === hub.me.person.id);
  return (
    <>
      <StatStrip label="Complaints at a glance" onFilter={show} items={[
        { label: 'Total complaints', value: cases.length, filter: 'all' },
        { label: 'New', value: cases.filter((c) => c.stage === 'new').length, filter: 'new', tone: cases.some((c) => c.stage === 'new') ? 'warn' : undefined },
        { label: 'In progress', value: open.filter((c) => c.stage !== 'new').length, filter: 'progress' },
        { label: 'Overdue cases', value: open.filter((c) => c.overdue).length, filter: 'overdue', tone: open.some((c) => c.overdue) ? 'bad' : 'ok' },
        { label: 'Overdue actions', value: overdueActions, filter: 'overdue_actions', tone: overdueActions ? 'bad' : 'ok' },
        { label: 'Senior attention', value: open.filter((c) => c.escalated).length, filter: 'escalated', tone: open.some((c) => c.escalated) ? 'bad' : undefined },
        { label: 'Resolved or closed', value: cases.length - open.length, filter: 'done', tone: 'ok' },
      ]} />
      <div className="grid-2">
        <section className="card" aria-labelledby="att-h">
          <h2 id="att-h">Needs attention</h2>
          <p className="small muted">Escalated, overdue, due within 7 days, or with no owner.</p>
          {attention.length === 0 ? <Empty>Nothing needs attention right now.</Empty> : <CaseRows cases={attention.slice(0, 8)} compact />}
          {attention.length > 8 && <Button variant="ghost" onClick={() => show('attention')}>See all {attention.length}</Button>}
        </section>
        <section className="card" aria-labelledby="trend-h">
          <h2 id="trend-h">Trend</h2>
          <p className="small muted">Complaints logged and resolved in the last six months.</p>
          <MonthBars cases={cases} months={6} />
        </section>
        {mine.length > 0 && (
          <section className="card" aria-labelledby="mine-h">
            <h2 id="mine-h">Your open cases</h2>
            <CaseRows cases={mine} compact />
          </section>
        )}
      </div>
    </>
  );
}

function MonthBars({ cases, months }: { cases: any[]; months: number }) {
  const keys = Array.from({ length: months }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (months - 1 - i)); return d.toISOString().slice(0, 7); });
  const rows = keys.map((k) => ({ k, logged: cases.filter((c) => monthKey(c.created_at) === k).length, resolved: cases.filter((c) => c.resolved_at && monthKey(c.resolved_at) === k).length }));
  const max = Math.max(1, ...rows.map((r) => r.logged));
  return (
    <ul className="cmp-bars">{rows.map((r) => (
      <li key={r.k}>
        <span className="cmp-bars-label">{monthName(r.k)}</span>
        <span className="cmp-bars-track" aria-hidden="true"><span style={{ width: `${(r.logged / max) * 100}%` }} /></span>
        <span className="cmp-bars-val"><strong>{r.logged}</strong> logged · {r.resolved} resolved</span>
      </li>
    ))}</ul>
  );
}

// One row per case: reference and title, stage, who owns it, what is next, when it is due.
function CaseRows({ cases, compact }: { cases: any[]; compact?: boolean }) {
  if (cases.length === 0) return <Empty>No complaints to show.</Empty>;
  return (
    <ul className="list cmp-rows">{cases.map((c) => (
      <li key={c.id} className={c.overdue ? 'is-overdue' : c.escalated && isOpen(c) ? 'is-escalated' : undefined}>
        <div className="cmp-row-main">
          <Link to={`/complaints/${c.id}`}><strong>{c.ref}</strong> · {caseTitle(c)}</Link>
          <span className="small muted">{[c.company_code, c.property_name, name(DEPTS, c.department), `logged ${fmtDate(c.created_at)}`].filter(Boolean).join(' · ')}</span>
          {!compact && isOpen(c) && <span className="small"><strong>Next:</strong> {nextStep(c)}</span>}
        </div>
        <div className="cmp-row-meta">
          <span className="row" style={{ gap: 6 }}>
            <Status s={STAGE_TONE[c.stage]} text={STAGE_NAME[c.stage]} />
            {!compact && <Status s={PRIORITY_TONE[c.priority]} text={label(c.priority)} />}
            {c.confidential && <Status s="review" text="Confidential" />}
            {c.escalated && isOpen(c) && <Status s="action" text="Senior attention" />}
          </span>
          <span className="small">{c.owner_name ?? <em>No owner</em>}{isOpen(c) && c.due_on && <> · <span className={c.overdue ? 'cmp-late' : undefined}>{c.overdue ? 'Overdue since' : 'Due'} {fmtDate(c.due_on)}</span></>}</span>
        </div>
      </li>
    ))}</ul>
  );
}

function applyFilters(cases: any[], f: Filters) {
  const words = f.q.trim().toLowerCase();
  return cases.filter((c) =>
    (!words || [c.ref, c.title, c.summary, c.property_name, c.owner_name, c.complainant_name, c.raised_by_name].some((v) => v?.toLowerCase().includes(words)))
    && (!f.category || c.category === f.category) && (!f.property || c.property_id === f.property) && (!f.department || c.department === f.department)
    && (!f.priority || c.priority === f.priority) && (!f.owner || (f.owner === 'none' ? !c.owner_id : c.owner_id === f.owner)) && (!f.stage || c.stage === f.stage)
    && (!f.from || c.created_at.slice(0, 10) >= f.from) && (!f.to || c.created_at.slice(0, 10) <= f.to)
    && (!f.quick || f.quick === 'all'
      || (f.quick === 'new' && c.stage === 'new') || (f.quick === 'progress' && isOpen(c) && c.stage !== 'new')
      || (f.quick === 'overdue' && c.overdue) || (f.quick === 'overdue_actions' && c.overdue_actions > 0)
      || (f.quick === 'escalated' && isOpen(c) && c.escalated) || (f.quick === 'done' && !isOpen(c))
      || (f.quick === 'attention' && isOpen(c) && (c.overdue || c.escalated || c.overdue_actions > 0 || !c.owner_id || dueSoon(c)))));
}
const QUICK: Record<string, string> = { all: 'All complaints', new: 'New', progress: 'In progress', overdue: 'Overdue cases', overdue_actions: 'Cases with overdue actions', escalated: 'Needing senior attention', done: 'Resolved or closed', attention: 'Needs attention' };

function Register({ cases, f, setF }: { cases: any[]; f: Filters; setF: (f: Filters) => void }) {
  const shown = applyFilters(cases, f);
  const uniq = (key: string, nameKey: string) => [...new Map(cases.filter((c) => c[key]).map((c) => [c[key], c[nameKey]])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const active = Object.entries(f).some(([, v]) => v);
  const more = (['priority', 'category', 'department', 'property', 'from', 'to'] as const).filter((k) => f[k]).length;
  return (
    <>
      <form className="card cmp-filters" role="search" aria-label="Find complaints" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search"><input type="search" name="q" value={f.q} onChange={set('q')} placeholder="Reference, title, property, person…" /></Field>
        <Field label="Stage"><select name="stage" value={f.stage} onChange={set('stage')}><option value="">Any</option>{STAGES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Assigned to"><select name="owner" value={f.owner} onChange={set('owner')}><option value="">Anyone</option><option value="none">No owner</option>{uniq('owner_id', 'owner_name').map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <details className="cmp-more" open={more > 0 || undefined}>
          <summary>More filters{more > 0 && ` (${more} on)`}</summary>
          <div className="cmp-filters-inner">
        <Field label="Priority"><select name="priority" value={f.priority} onChange={set('priority')}><option value="">Any</option>{PRIORITIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Category"><select name="category" value={f.category} onChange={set('category')}><option value="">Any</option>{CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Department"><select name="department" value={f.department} onChange={set('department')}><option value="">Any</option>{DEPTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Property"><select name="property" value={f.property} onChange={set('property')}><option value="">Any</option>{uniq('property_id', 'property_name').map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Logged from"><input type="date" name="from" value={f.from} onChange={set('from')} /></Field>
        <Field label="Logged to"><input type="date" name="to" value={f.to} onChange={set('to')} /></Field>
          </div>
        </details>
      </form>
      <div className="row between cmp-register-head">
        <p className="small" role="status">{shown.length} of {cases.length} complaints{f.quick && f.quick !== 'all' && <> · {QUICK[f.quick]}</>}</p>
        <span className="row">
          {active && <Button variant="ghost" onClick={() => setF(NO_FILTERS)}>Clear filters</Button>}
          <Button variant="secondary" onClick={() => exportCsv(shown, 'complaints-register')}>Export CSV</Button>
        </span>
      </div>
      <section className="card"><CaseRows cases={shown} /></section>
    </>
  );
}

function exportCsv(cases: any[], file: string) {
  const cols: [string, (c: any) => unknown][] = [
    ['Reference', (c) => c.ref], ['Logged', (c) => c.created_at.slice(0, 10)], ['Company', (c) => c.company_code], ['Property', (c) => c.property_name],
    ['Title', (c) => (c.confidential ? 'Confidential' : caseTitle(c))], ['Category', (c) => name(CATEGORIES, c.category)], ['Department', (c) => name(DEPTS, c.department)],
    ['Priority', (c) => label(c.priority)], ['Stage', (c) => STAGE_NAME[c.stage]], ['Owner', (c) => c.owner_name], ['Due', (c) => c.due_on?.slice(0, 10)],
    ['Overdue', (c) => (c.overdue ? 'Yes' : 'No')], ['Senior attention', (c) => (c.escalated && isOpen(c) ? 'Yes' : 'No')], ['Open actions', (c) => c.open_actions],
    ['Resolved', (c) => c.resolved_at?.slice(0, 10)], ['Days to resolve', (c) => (c.resolved_at ? daysBetween(c.created_at, c.resolved_at) : '')],
  ];
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]|^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  const csv = [cols.map(([h]) => h), ...cases.map((c) => cols.map(([, fn]) => fn(c)))].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${file}-${londonToday()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Reports({ cases }: { cases: any[] }) {
  const [months, setMonths] = useState('6');
  const since = useMemo(() => { if (months === 'all') return ''; const d = new Date(); d.setMonth(d.getMonth() - Number(months)); return d.toISOString().slice(0, 10); }, [months]);
  const inPeriod = cases.filter((c) => !since || c.created_at.slice(0, 10) >= since);
  const resolved = inPeriod.filter((c) => c.resolved_at);
  const days = resolved.map((c) => daysBetween(c.created_at, c.resolved_at)).sort((a, b) => a - b);
  const onTime = resolved.filter((c) => !c.due_on || c.resolved_at.slice(0, 10) <= c.due_on.slice(0, 10)).length;
  const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
  const median = days.length ? days[Math.floor(days.length / 2)] : null;
  const count = (key: string, nameOf: (c: any) => string) => [...inPeriod.reduce((m, c) => { const k = c[key]; if (k) m.set(k, { name: nameOf(c), n: (m.get(k)?.n ?? 0) + 1 }); return m; }, new Map<string, { name: string; n: number }>()).values()].sort((a, b) => b.n - a.n);
  const depts = DEPTS.map(([k, t]) => {
    const rows = inPeriod.filter((c) => c.department === k);
    const res = rows.filter((c) => c.resolved_at);
    const d = res.map((c) => daysBetween(c.created_at, c.resolved_at));
    return { k, t, total: rows.length, open: rows.filter(isOpen).length, overdue: rows.filter((c) => c.overdue).length, avg: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
      onTime: res.length ? Math.round((res.filter((c) => !c.due_on || c.resolved_at.slice(0, 10) <= c.due_on.slice(0, 10)).length / res.length) * 100) : null };
  }).filter((r) => r.total > 0);
  const overdue = inPeriod.filter((c) => c.overdue);
  return (
    <div className="cmp-reports">
      <div className="row between cmp-register-head">
        <Field label="Period"><select name="period" value={months} onChange={(e) => setMonths(e.target.value)}><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="all">All time</option></select></Field>
        <span className="row">
          <Button variant="secondary" onClick={() => exportCsv(inPeriod, 'complaints-report')}>Export CSV</Button>
          <Button variant="ghost" onClick={() => window.print()}>Print or save as PDF</Button>
        </span>
      </div>
      <StatStrip label="Report figures" items={[
        { label: 'Complaints logged', value: inPeriod.length },
        { label: 'Still open', value: inPeriod.filter(isOpen).length },
        { label: 'Overdue now', value: overdue.length, tone: overdue.length ? 'bad' : 'ok' },
        { label: 'Average days to resolve', value: avg ?? '—' },
        { label: 'Median days to resolve', value: median ?? '—' },
        { label: 'Resolved on time', value: resolved.length ? `${Math.round((onTime / resolved.length) * 100)}%` : '—', tone: resolved.length && onTime / resolved.length < 0.9 ? 'warn' : 'ok' },
      ]} />
      <div className="grid-2">
        <section className="card" aria-labelledby="vol-h"><h2 id="vol-h">Volume by month</h2><MonthBars cases={cases} months={months === 'all' ? 12 : Number(months)} /></section>
        <section className="card" aria-labelledby="rec-h"><h2 id="rec-h">Recurring issues</h2>
          <p className="small muted">By category, then the properties with most complaints.</p>
          <TopList rows={count('category', (c) => name(CATEGORIES, c.category)).slice(0, 6)} />
          <h3 className="cmp-sub">Properties</h3>
          <TopList rows={count('property_id', (c) => c.property_name).slice(0, 6)} />
        </section>
        <section className="card cmp-wide" aria-labelledby="dep-h"><h2 id="dep-h">Department performance</h2>
          {depts.length === 0 ? <Empty>No complaints in this period.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Department</th><th scope="col" className="num">Total</th><th scope="col" className="num">Open</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Avg days</th><th scope="col" className="num">On time</th></tr></thead>
              <tbody>{depts.map((r) => <tr key={r.k}><td><strong>{r.t}</strong></td><td className="num">{r.total}</td><td className="num">{r.open}</td><td className="num">{r.overdue}</td><td className="num">{r.avg ?? '—'}</td><td className="num">{r.onTime == null ? '—' : `${r.onTime}%`}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
        <section className="card" aria-labelledby="od-h"><h2 id="od-h">Overdue cases</h2><CaseRows cases={overdue} compact /></section>
      </div>
    </div>
  );
}
function TopList({ rows }: { rows: { name: string; n: number }[] }) {
  if (!rows.length) return <Empty>None.</Empty>;
  const max = rows[0].n;
  return <ul className="cmp-bars">{rows.map((r) => <li key={r.name}><span className="cmp-bars-label">{r.name}</span><span className="cmp-bars-track" aria-hidden="true"><span style={{ width: `${(r.n / max) * 100}%` }} /></span><span className="cmp-bars-val"><strong>{r.n}</strong></span></li>)}</ul>;
}

function NewComplaint({ companies, confidential, onClose }: { companies: string[]; confidential: string[]; onClose: () => void }) {
  const hub = useHub();
  const nav = useNavigate();
  const first = hub.company !== 'all' && companies.includes(hub.company) ? hub.company : companies[0];
  const [f, setF] = useState({ company_id: first, title: '', category: 'service', source: 'resident', channel: 'phone', complainant_name: '', property_id: '', department: '', priority: 'medium', owner_id: '', due_on: '', summary: '', confidential: false });
  const people = useApi<any[]>(`/people?company=${f.company_id}`);
  const props = useApi<any[]>('/properties');
  const save = useSubmit(async () => {
    const c = await post('/complaints', { ...f, property_id: f.property_id || null, owner_id: f.owner_id || null, due_on: f.due_on || null, complainant_name: f.complainant_name || null, department: f.department || undefined, title: f.title || undefined });
    nav(`/complaints/${c.id}`);
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} title="Log a complaint" footer={<Button busy={save.busy} onClick={() => save.run()}>Log complaint</Button>}>
      <ErrorSummary error={save.error} />
      {companies.length > 1 && <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, owner_id: '', property_id: '', confidential: false })}>{companies.map((id) => <option key={id} value={id}>{hub.co(id)?.name ?? id}</option>)}</select></Field>}
      {confidential.includes(f.company_id) && (
        <label className="check" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={f.confidential} onChange={(e) => setF({ ...f, confidential: e.target.checked, category: e.target.checked ? 'hr' : f.category, department: e.target.checked ? 'hr' : f.department })} />
          <span><strong>Confidential (HR)</strong><br /><span className="small muted">Only staff authorised for confidential complaints, the owner and people you add can open it. Task lists show the reference only.</span></span></label>
      )}
      <Field label="Short title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={set('title')} placeholder="e.g. Repeated noise from room 3" /></Field>
      <Field label="Category"><select name="category" value={f.category} onChange={set('category')}>{CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="Who made the complaint?"><select name="source" value={f.source} onChange={set('source')}>{SOURCES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="How did it reach you?"><select name="channel" value={f.channel} onChange={set('channel')}>{CHANNELS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="Complainant's name" optional hint="Leave blank if they want to stay anonymous."><input name="complainant_name" value={f.complainant_name} onChange={set('complainant_name')} /></Field>
      <Field label="Property" optional error={save.error?.fields.property_id}><select name="property_id" value={f.property_id} onChange={set('property_id')}><option value="">Not about a property</option>{props.data?.filter((p) => p.company_id === f.company_id || p.linked_company_ids?.includes?.(f.company_id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Responsible department" optional hint="Chosen from the category if left blank."><select name="department" value={f.department} onChange={set('department')}><option value="">From the category</option>{DEPTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="Priority"><select name="priority" value={f.priority} onChange={set('priority')}>{PRIORITIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="Owner" optional hint="Left blank, it goes to the complaints manager with the fewest open cases." error={save.error?.fields.owner_id}><select name="owner_id" value={f.owner_id} onChange={set('owner_id')}><option value="">Complaints manager</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
      <Field label="Respond by" optional hint="10 days from today if left blank."><input type="date" name="due_on" value={f.due_on} onChange={set('due_on')} /></Field>
      <Field label="What is the complaint?" hint="What happened, when, and what the complainant would like to happen." error={save.error?.fields.summary}><textarea name="summary" rows={5} value={f.summary} onChange={set('summary')} /></Field>
    </Dialog>
  );
}

// ── A single case ──
const EVENT_LABEL: Record<string, string> = { created: 'Logged', stage: 'Stage changed', assigned: 'Owner', updated: 'Details updated', note: 'Internal note', advice: 'Advice', recommendation: 'Recommendation', evidence: 'Evidence added', action: 'Action set', action_done: 'Action done', escalated: 'Escalated for senior attention', deescalated: 'Senior attention no longer needed', reminder: 'Reminder' };
const FIELD_NAME: Record<string, string> = { priority: 'priority', department: 'department', category: 'category', due_on: 'deadline', title: 'title', resolution: 'resolution', confidential: 'confidentiality', complainant_name: 'complainant', access: 'access' };

export function ComplaintPage() {
  const { id } = useParams();
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any>(`/complaints/${id}`);
  const [edit, setEdit] = useState<any>(null);
  const [note, setNote] = useState({ kind: 'note', body: '' });
  const [act, setAct] = useState<any>(null);
  const [person, setPerson] = useState('');
  const c = d.data?.case;
  const people = useApi<any[]>(c && d.data.role !== 'party' ? `/people?company=${c.company_id}` : null);
  const save = useSubmit(async () => {
    const b: any = { stage: edit.stage, priority: edit.priority, department: edit.department, category: edit.category, owner_id: edit.owner_id || null, due_on: edit.due_on || null,
      title: edit.title || null, resolution: edit.resolution || null, escalated: edit.escalated, escalation_reason: edit.escalation_reason || null, comment: edit.comment || undefined };
    if (d.data.can.confidential) b.confidential = edit.confidential;
    await patch(`/complaints/${id}`, b); setEdit(null); toast('Complaint updated.'); d.reload();
  });
  const addNote = useSubmit(async () => { await post(`/complaints/${id}/events`, note); setNote({ kind: note.kind, body: '' }); toast('Added to the timeline.'); d.reload(); });
  const addAction = useSubmit(async () => { await post(`/complaints/${id}/actions`, { title: act.title, owner_id: act.owner_id, due_on: act.due_on || null }); setAct(null); toast('Action set and sent to its owner.'); d.reload(); });
  const done = useSubmit(async (aid: string) => { await post(`/complaints/${id}/actions/${aid}/done`); toast('Action marked done.'); d.reload(); });
  const file = useSubmit(async (fl: File) => { await upload(`/complaints/${id}/files`, fl, fl.name); toast('Evidence uploaded.'); d.reload(); });
  const grant = useSubmit(async () => { await post(`/complaints/${id}/access`, { person_id: person }); setPerson(''); toast('Access given.'); d.reload(); });
  const revoke = useSubmit(async (pid: string) => { await api('DELETE', `/complaints/${id}/access/${pid}`); toast('Access removed.'); d.reload(); });

  if (d.error) return <><PageHead title="Complaint" crumbs={[['Complaints', '/complaints'], ['Complaint']]} /><LoadError error={d.error} retry={d.reload} /></>;
  if (!c) return <Skeleton lines={8} />;
  const { events, actions, files, access, role, can } = d.data;
  const open = OPEN.includes(c.stage);
  const today = londonToday();
  const overdue = open && c.due_on && c.due_on.slice(0, 10) < today;
  const nextAction = actions.find((x: any) => !x.done_at);
  const stageIdx = STAGES.findIndex(([k]) => k === c.stage);
  const startEdit = (extra: object = {}) => setEdit({ stage: c.stage, priority: c.priority, department: c.department, category: c.category, owner_id: c.owner_id ?? '', due_on: c.due_on?.slice(0, 10) ?? '', title: c.title ?? '', resolution: c.resolution ?? '', escalated: c.escalated, escalation_reason: c.escalation_reason ?? '', confidential: c.confidential, comment: '', ...extra });

  return (
    <>
      <PageHead title={`${c.ref} · ${caseTitle(c)}`} crumbs={[['Complaints', '/complaints'], [c.ref]]}
        actions={can.manage && <>
          <Button onClick={() => startEdit()}>Update case</Button>
          {open && !c.escalated && <Button variant="secondary" onClick={() => startEdit({ escalated: true })}>Escalate</Button>}
          {open && <Button variant="secondary" onClick={() => startEdit({ stage: 'resolved' })}>Resolve</Button>}
        </>} />
      {c.confidential && <p className="notice warn"><strong>Confidential.</strong> Only authorised staff can open this complaint. Every view is recorded.</p>}
      {c.escalated && open && <p className="notice bad"><strong>Needs senior attention.</strong> {c.escalation_reason}</p>}

      <ol className="cmp-stages" aria-label="Progress">{STAGES.map(([k, t], i) => (
        <li key={k} className={i < stageIdx ? 'done' : i === stageIdx ? 'now' : undefined} aria-current={i === stageIdx ? 'step' : undefined}><span>{t}</span></li>
      ))}</ol>

      <section className="card cmp-glance" aria-labelledby="glance-h">
        <h2 id="glance-h" className="sr-only">At a glance</h2>
        <dl>
          <div><dt>Responsible</dt><dd>{c.owner_name ?? <em>No owner yet</em>}</dd></div>
          <div><dt>What happens next</dt><dd>{open ? (nextAction ? `${nextAction.title} — ${nextAction.owner_name ?? 'no owner'}` : STAGES[stageIdx][2]) : STAGES[stageIdx][2]}</dd></div>
          <div><dt>Due</dt><dd className={overdue ? 'cmp-late' : undefined}>{c.due_on ? `${overdue ? 'Overdue since ' : ''}${fmtDate(c.due_on)}` : 'No deadline'}</dd></div>
          <div><dt>Stage</dt><dd><Status s={STAGE_TONE[c.stage]} text={STAGE_NAME[c.stage]} /> <Status s={PRIORITY_TONE[c.priority]} text={`${label(c.priority)} priority`} /></dd></div>
        </dl>
      </section>

      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="desc-h">
            <h2 id="desc-h">The complaint</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.summary}</p>
            <dl className="facts">
              <dt>Reference</dt><dd>{c.ref}</dd>
              <dt>Category</dt><dd>{name(CATEGORIES, c.category)}</dd>
              <dt>Department</dt><dd>{name(DEPTS, c.department)}</dd>
              <dt>Property</dt><dd>{c.property_id ? <Link to={`/properties/${c.property_id}`}>{c.property_name}</Link> : 'Not about a property'}</dd>
              <dt>From</dt><dd>{name(SOURCES, c.source)}{c.complainant_name && ` — ${c.complainant_name}`}{c.channel && `, ${CHANNEL_TEXT[c.channel]}`}</dd>
              <dt>Logged</dt><dd>{fmtDateTime(c.created_at)} by {c.raised_by_name}</dd>
              <dt>Company</dt><dd>{c.company_name}</dd>
              {c.resolved_at && <><dt>Resolved</dt><dd>{fmtDate(c.resolved_at)} ({daysBetween(c.created_at, c.resolved_at)} days)</dd></>}
              {c.closed_at && <><dt>Closed</dt><dd>{fmtDate(c.closed_at)}</dd></>}
            </dl>
          </section>
          <section className="card" aria-labelledby="res-h">
            <h2 id="res-h">Resolution</h2>
            {c.resolution ? <p style={{ whiteSpace: 'pre-wrap' }}>{c.resolution}</p> : <p className="muted">Not resolved yet. The resolution is recorded when the case is resolved.</p>}
          </section>
          {role !== 'party' && (
            <section className="card" aria-labelledby="act-h">
              <div className="row between"><h2 id="act-h">Follow-up actions</h2>{can.manage && <Button variant="secondary" onClick={() => setAct({ title: '', owner_id: '', due_on: '' })}><Icon name="plus" size={18} />Add action</Button>}</div>
              <p className="small muted">Each action is a task for its owner and shows on their day.</p>
              <ErrorSummary error={done.error} />
              {actions.length === 0 ? <Empty>No actions yet.</Empty> : <ul className="list">{actions.map((x: any) => (
                <li key={x.id}>
                  <div><strong className={x.done_at ? 'cmp-done' : undefined}>{x.title}</strong><br />
                    <span className="small muted">{x.owner_name ?? 'No owner'} · {x.done_at ? `done ${fmtDate(x.done_at)}` : x.due_on ? <span className={x.overdue ? 'cmp-late' : undefined}>{x.overdue ? 'overdue since' : 'due'} {fmtDate(x.due_on)}</span> : 'no deadline'}</span></div>
                  {x.done_at ? <Status s="verified" text="Done" /> : (can.manage || x.owner_id === hub.me.person.id) && <Button variant="secondary" disabled={done.busy} onClick={() => done.run(x.id)}>Mark done</Button>}
                </li>
              ))}</ul>}
            </section>
          )}
          {role !== 'party' && (
            <section className="card" aria-labelledby="ev-h">
              <h2 id="ev-h">Evidence and documents</h2>
              {files.length === 0 ? <p className="muted">No documents yet.</p> : <ul className="list">{files.map((fl: any) => <li key={fl.id}><button type="button" className="btn ghost" onClick={() => download(`/files/${fl.id}`, fl.original_name)}><Icon name="paperclip" size={16} />{fl.original_name}</button><span className="small muted">{fl.uploaded_by_name} · {fmtDate(fl.uploaded_at)}</span></li>)}</ul>}
              {can.note && <FilePicker label="Add evidence" hint="PDF or photo, up to 10 MB." accept="application/pdf,image/*" instant busy={file.busy} error={file.error?.message} onChange={(fs) => fs[0] && file.run(fs[0])} />}
            </section>
          )}
          {c.confidential && can.confidential && (
            <section className="card" aria-labelledby="acc-h">
              <h2 id="acc-h">Who else can open it</h2>
              <p className="small muted">Besides staff authorised for confidential complaints and the owner.</p>
              {access.length === 0 ? <p className="muted">Nobody else.</p> : <ul className="list">{access.map((p: any) => <li key={p.person_id}><span>{p.name}</span><Button variant="ghost" disabled={revoke.busy} onClick={() => revoke.run(p.person_id)}>Remove</Button></li>)}</ul>}
              <ErrorSummary error={grant.error} />
              <div className="row"><select aria-label="Person to give access" value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Choose a person…</option>{people.data?.filter((p) => p.id !== c.owner_id && !access.some((x: any) => x.person_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
                <Button variant="secondary" disabled={!person} busy={grant.busy} onClick={() => grant.run()}>Give access</Button></div>
            </section>
          )}
        </div>
        <section className="card" aria-labelledby="tl-h">
          <h2 id="tl-h">Timeline</h2>
          {can.note && (
            <form className="cmp-note" onSubmit={(e) => { e.preventDefault(); addNote.run(); }}>
              <ErrorSummary error={addNote.error} />
              <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Add to the timeline</legend>
                <div className="row">{[['note', 'Internal note'], ['advice', 'Advice'], ['recommendation', 'Recommendation']].map(([k, t]) => <label key={k} className="check"><input type="radio" name="kind" checked={note.kind === k} onChange={() => setNote({ ...note, kind: k })} />{t}</label>)}</div>
              </fieldset>
              <Field label="Text" error={addNote.error?.fields.body}><textarea name="body" rows={3} value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} /></Field>
              <Button type="submit" variant="secondary" busy={addNote.busy} disabled={note.body.trim().length < 2}>Add</Button>
            </form>
          )}
          <ol className="cmp-timeline">{[...events].reverse().map((e: any) => (
            <li key={e.id} className={`k-${e.kind}`}>
              <div className="small muted">{fmtDateTime(e.created_at)} · {e.actor_name ?? 'The Hub'}</div>
              <strong>{EVENT_LABEL[e.kind] ?? label(e.kind)}</strong>
              {e.kind === 'stage' && <> — {STAGE_NAME[e.meta.from] ?? '…'} → {STAGE_NAME[e.meta.to]}</>}
              {e.kind === 'assigned' && <> — {e.to_name ?? 'nobody'}{e.from_name && ` (was ${e.from_name})`}</>}
              {e.kind === 'updated' && e.meta.fields && <> — {e.meta.fields.map((k: string) => FIELD_NAME[k] ?? k).join(', ')}</>}
              {e.body && <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{e.body}</p>}
            </li>
          ))}</ol>
        </section>
      </div>

      <Dialog open={!!edit} onClose={() => setEdit(null)} title={`Update ${c.ref}`} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {edit && <><ErrorSummary error={save.error} />
          <Field label="Stage"><select name="stage" value={edit.stage} onChange={(e) => setEdit({ ...edit, stage: e.target.value })}>{STAGES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="What changed?" optional hint="Shown on the timeline with the stage change."><textarea name="comment" rows={2} value={edit.comment} onChange={(e) => setEdit({ ...edit, comment: e.target.value })} /></Field>
          {['resolved', 'closed'].includes(edit.stage) && <Field label="Resolution" hint="What was found, what was done and how the complainant was told." error={save.error?.fields.resolution}><textarea name="resolution" rows={4} value={edit.resolution} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} /></Field>}
          <Field label="Owner" error={save.error?.fields.owner_id}><select name="owner_id" value={edit.owner_id} onChange={(e) => setEdit({ ...edit, owner_id: e.target.value })}><option value="">No owner</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Respond by" optional><input type="date" name="due_on" value={edit.due_on} onChange={(e) => setEdit({ ...edit, due_on: e.target.value })} /></Field>
          <Field label="Priority"><select name="priority" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>{PRIORITIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Department"><select name="department" value={edit.department} onChange={(e) => setEdit({ ...edit, department: e.target.value })}>{DEPTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Category"><select name="category" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Short title" optional><input name="title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={edit.escalated} onChange={(e) => setEdit({ ...edit, escalated: e.target.checked })} /> Needs senior attention</label>
          {edit.escalated && <Field label="Why?" hint="Senior staff are told when you save." error={save.error?.fields.escalation_reason}><textarea name="escalation_reason" rows={2} value={edit.escalation_reason} onChange={(e) => setEdit({ ...edit, escalation_reason: e.target.value })} /></Field>}
          {can.confidential && <label className="check"><input type="checkbox" checked={edit.confidential} onChange={(e) => setEdit({ ...edit, confidential: e.target.checked })} /> Confidential (HR): authorised staff only</label>}
        </>}
      </Dialog>
      <Dialog open={!!act} onClose={() => setAct(null)} title="Add a follow-up action" footer={<Button busy={addAction.busy} onClick={() => addAction.run()}>Add action</Button>}>
        {act && <><ErrorSummary error={addAction.error} />
          <Field label="Action" error={addAction.error?.fields.title}><input name="title" value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} placeholder="e.g. Call the resident to agree quiet hours" /></Field>
          <Field label="Who will do it?" error={addAction.error?.fields.owner_id}><select name="owner_id" value={act.owner_id} onChange={(e) => setAct({ ...act, owner_id: e.target.value })}><option value="">Choose…</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="By when?" optional><input type="date" name="due_on" value={act.due_on} onChange={(e) => setAct({ ...act, due_on: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
