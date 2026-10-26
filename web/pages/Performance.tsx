import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, patch, post, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtMinutes, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Avatar, Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

type Tab = 'kpis' | 'reviews' | 'supervision' | 'recognition' | 'definitions';
const KPI_STATUS: Record<string, [string, string]> = { met: ['verified', 'Target met'], below: ['action', 'Below target'], insufficient: ['not_required', 'Not enough data'], info: ['info', 'For information'] };
const DRILL: Record<string, string> = { approved_hours: '/attendance', on_time_starts: '/attendance', visit_coverage: '/attendance', tasks_on_time: '/tasks', development_actions: '/tasks', clearance: '/people', supervision_on_time: '/performance?tab=supervision', coaching_hours: '/performance?tab=supervision' };

export function Performance() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'kpis';
  const tabs: [Tab, string][] = [['kpis', 'KPIs and advice'], ['reviews', 'Reviews'], ['supervision', 'Supervision'], ['recognition', 'Recognition'], ...(hub.can('performance.manage') || hub.me.superAdmin ? [['definitions', 'KPI definitions'] as [Tab, string]] : [])];
  return (
    <>
      <PageHead title="Performance" intro="Measures, reviews, supervision and recognition. Figures support conversations; they never trigger decisions about pay, conduct or contracts on their own." />
      <Tabs label="Performance sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'kpis' && <Kpis />}
      {tab === 'reviews' && <Reviews />}
      {tab === 'supervision' && <Supervision />}
      {tab === 'recognition' && <Recognition />}
      {tab === 'definitions' && <Definitions />}
    </>
  );
}

// Everyone in one company side by side; pick a name to open their full KPIs.
function TeamKpis({ companyId, month, onPick }: { companyId: string; month: string; onPick: (personId: string) => void }) {
  const d = useApi<any[]>(`/kpis/team?company=${companyId}&month=${month}`);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  if (!d.data.length) return <Empty>No current staff in this company.</Empty>;
  const cols = d.data[0].kpis;
  const show = (k: any) => k.value === null ? '—' : k.unit === 'percent' ? `${k.value}%` : `${k.value} h`;
  return (
    <section className="card" aria-labelledby="team-h">
      <h2 id="team-h">KPIs for each person</h2>
      <p className="small muted">Green: target met. Red: below target. Grey: not enough data or no target. Choose a name for their full KPIs, trends and advice.</p>
      <div className="table-wrap"><table className="kpi-table">
        <thead><tr><th scope="col">Person</th>{cols.map((k: any) => <th key={k.key} scope="col" className="num">{k.title}</th>)}</tr></thead>
        <tbody>{d.data.map((p) => (
          <tr key={p.id}>
            <th scope="row"><button type="button" className="btn ghost person-cell" onClick={() => onPick(p.id)}><Avatar personId={p.id} name={p.name} hasPhoto={p.has_photo} /><span>{p.name}<br /><span className="small muted">{p.job_title}</span></span></button></th>
            {p.kpis.map((k: any) => <td key={k.key} className={`num kpi-${k.status}`} title={k.denominator ? `${k.numerator} of ${k.denominator}` : undefined}>{show(k)}<span className="sr-only"> — {KPI_STATUS[k.status][1]}</span></td>)}
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

// ── KPIs ──
function Kpis() {
  const hub = useHub();
  const toast = useToast();
  const manager = hub.can('performance.view_all');
  const [month, setMonth] = useState(londonToday().slice(0, 7));
  const [who, setWho] = useState<'me' | 'company' | 'team'>('me');
  const [person, setPerson] = useState('');
  const companyId = hub.company !== 'all' ? hub.company : null;
  const people = useApi<any[]>(who === 'company' && companyId ? `/people?company=${companyId}` : null);
  const personParam = who === 'me' ? 'me' : person || undefined;
  const d = useApi<any[]>(who === 'team' ? null : `/kpis${hub.q({ month, person: personParam })}`);
  const [about, setAbout] = useState<any>(null);
  const [trend, setTrend] = useState<any>(null);
  const [help, setHelp] = useState<string | null>(null);
  const toAction = useSubmit(async (companyId: string, title: string) => { await post('/tasks', { company_id: companyId, title, due_on: null, priority: 'normal' }); toast('Added to your tasks.'); });

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="kpi-month">Month</label><input id="kpi-month" type="month" value={month} max={londonToday().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 200 }} /></div>
        {manager && <Chips label="Whose measures" value={who} onChange={(v) => { setWho(v); setPerson(''); }} options={[['me', 'Mine'], ['team', 'Each person'], ['company', 'Company']]} />}
        {who === 'company' && companyId && (
          <div className="field" style={{ margin: 0 }}><label htmlFor="kpi-person">Person</label>
            <select id="kpi-person" value={person} onChange={(e) => setPerson(e.target.value)} style={{ width: 260 }}><option value="">Whole company</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></div>
        )}
      </div>
      {who === 'company' && !companyId && <p className="notice">Showing each company separately. Choose a company at the top to look at one person.</p>}
      {who === 'team' && (companyId ? <TeamKpis companyId={companyId} month={month} onPick={(id) => { setWho('company'); setPerson(id); }} />
        : <p className="notice">Choose a company at the top to see everyone’s KPIs side by side.</p>)}
      <ErrorSummary error={toAction.error} />
      {d.error && <LoadError error={d.error} retry={d.reload} />}
      {who !== 'team' && (d.loading && !d.data ? <Skeleton lines={8} /> : (d.data ?? []).length === 0 ? <Empty>No measures to show.</Empty> : d.data!.map((c) => (
        <section key={c.company_id} className="card" aria-labelledby={`k-${c.company_id}`}>
          <h2 id={`k-${c.company_id}`}><CompanyBadge code={c.company_code} name={c.company_name} /> {c.company_name}</h2>
          <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
            {c.kpis.map((k: any) => {
              const [st, stText] = KPI_STATUS[k.status];
              return (
                <li key={k.key} className="kpi">
                  <div className="row between"><span className="label">{k.title}</span><Status s={st} text={stText} /></div>
                  <div className="value">{k.value === null ? '—' : k.unit === 'percent' ? `${k.value}%` : `${k.value} h`}</div>
                  <div className="explain">
                    {k.unit === 'percent' && (k.denominator ? `${k.numerator} of ${k.denominator}` : 'No records yet')}
                    {k.status === 'insufficient' && ` · needs at least ${k.definition.min_data}`}
                    {k.target !== null && ` · target ${k.target}%`}
                  </div>
                  {k.hours && <div className="hours" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginTop: 8 }}>
                    {(['planned', 'recorded', 'submitted', 'approved'] as const).map((h) => <div key={h}><span className="muted">{label(h)}</span><strong>{fmtMinutes(k.hours[h])}</strong></div>)}
                  </div>}
                  <div className="row" style={{ marginTop: 8, gap: 4 }}>
                    <Button variant="ghost" onClick={() => setAbout(k)} aria-label={`About ${k.title}`}>About</Button>
                    <Button variant="ghost" onClick={() => setTrend({ ...k, company_id: c.company_id })} aria-label={`Six-month trend for ${k.title}`}>Trend</Button>
                    <Link className="btn ghost" to={DRILL[k.key]} aria-label={`Records behind ${k.title}`}>Records</Link>
                  </div>
                </li>
              );
            })}
          </ul>
          {c.advice.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Practical advice</h3>
              <ul className="list">{c.advice.map((a: any) => (
                <li key={a.key}><div>
                  <p style={{ margin: 0 }}><strong>{a.finding}</strong></p>
                  <p className="small" style={{ margin: '4px 0' }}>Source: {a.source} Scope: {a.context}.</p>
                  <p className="small muted" style={{ margin: '4px 0' }}>Limitation: {a.limitation}</p>
                  {a.next_step && <p style={{ margin: '4px 0' }}>Next step: {a.next_step}</p>}
                  <div className="row">
                    {a.next_step && <Button variant="secondary" busy={toAction.busy} onClick={() => toAction.run(c.company_id, a.next_step.slice(0, 200))}>Turn into an action</Button>}
                    <Button variant="ghost" onClick={() => setHelp(c.company_id)}>Request Help</Button>
                  </div>
                </div></li>
              ))}</ul>
            </>
          )}
        </section>
      )))}
      <Dialog open={!!about} onClose={() => setAbout(null)} title={about?.title ?? ''}>
        {about && <dl className="facts">
          <dt>Purpose</dt><dd>{about.definition.purpose}</dd>
          <dt>How it is worked out</dt><dd>{about.definition.formula}</dd>
          <dt>Source records</dt><dd>{about.definition.sources}</dd>
          <dt>Period</dt><dd>Calendar month, UK time</dd>
          <dt>Target</dt><dd>{about.target === null ? 'None — shown for information' : `${about.target}% or ${about.definition.direction === 'lower' ? 'lower' : 'higher'}`}</dd>
          <dt>Minimum data</dt><dd>{about.definition.min_data} records</dd>
          <dt>Applies to</dt><dd>{about.definition.applies_to}</dd>
          <dt>Owner</dt><dd>{about.definition.owner}</dd>
          <dt>Version</dt><dd>{about.definition.version}{about.definition.company_id ? ' (company-specific)' : ' (group default)'}, from {fmtDate(about.definition.effective_from)}</dd>
          <dt>Limitations</dt><dd>{about.definition.limitations}</dd>
        </dl>}
      </Dialog>
      {trend && <TrendDialog k={trend} month={month} person={personParam} onClose={() => setTrend(null)} />}
      {help && <RequestHelpDialog companyId={help} onClose={() => setHelp(null)} />}
    </>
  );
}

// Single series → bars with a dashed target line; the table below carries the same numbers.
function TrendDialog({ k, month, person, onClose }: { k: any; month: string; person?: string; onClose: () => void }) {
  const d = useApi<any[]>(`/kpis/series?company=${k.company_id}&key=${k.key}&month=${month}${person ? `&person=${person}` : ''}`);
  const pts = d.data ?? [];
  const pct = k.unit === 'percent';
  const max = pct ? 100 : Math.max(1, ...pts.map((p) => p.value ?? 0));
  const W = 480, H = 200, pad = 28, bw = (W - pad) / 6;
  const y = (v: number) => H - 24 - ((H - 44) * v) / max;
  const fmt = (v: number | null) => (v === null ? 'Not enough data' : pct ? `${v}%` : `${v} h`);
  return (
    <Dialog open onClose={onClose} title={`${k.title}: last six months`}>
      {d.error && <LoadError error={d.error} />}
      {!d.data ? <Skeleton /> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Bar chart of ${k.title} by month. The same figures are in the table below.`} style={{ maxWidth: W, display: 'block' }}>
            <line x1={pad} x2={W} y1={H - 24} y2={H - 24} stroke="var(--line-strong)" />
            {pts.map((p, i) => {
              const x = pad + i * bw + 6;
              return (
                <g key={p.month}>
                  <title>{`${p.label}: ${fmt(p.value)}${p.denominator ? ` (${p.numerator} of ${p.denominator})` : ''}`}</title>
                  {/* Hit area larger than the bar, for the native tooltip */}
                  <rect x={x - 4} y={8} width={bw - 4} height={H - 32} fill="transparent" />
                  {p.value !== null && <path d={`M${x},${H - 24} V${y(p.value) + 4} q0,-4 4,-4 h${bw - 20} q4,0 4,4 V${H - 24} Z`} fill="var(--chart-1)" />}
                  {p.value === null && <text x={x + (bw - 12) / 2} y={H - 30} textAnchor="middle" fontSize="11" fill="var(--text-2)">n/a</text>}
                  <text x={x + (bw - 12) / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="var(--text-2)">{p.label.slice(0, 3)}</text>
                </g>
              );
            })}
            {k.target !== null && <><line x1={pad} x2={W} y1={y(k.target)} y2={y(k.target)} stroke="var(--text)" strokeDasharray="4 4" /><text x={pad} y={y(k.target) - 4} fontSize="12" fill="var(--text)">Target {k.target}%</text></>}
          </svg>
          <div className="table-wrap" style={{ marginTop: 16 }}><table>
            <caption>{k.title} by month</caption>
            <thead><tr><th>Month</th><th className="num">Value</th><th className="num">Records</th><th>Definition</th></tr></thead>
            <tbody>{pts.map((p) => <tr key={p.month}><td>{p.label}</td><td className="num">{fmt(p.value)}</td><td className="num">{p.denominator === null ? '—' : `${p.numerator} of ${p.denominator}`}</td><td>Version {p.version}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
    </Dialog>
  );
}

export function RequestHelpDialog({ companyId, onClose }: { companyId?: string; onClose: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies;
  const [f, setF] = useState({ company_id: companyId ?? (hub.company !== 'all' ? hub.company : cos[0]?.id ?? ''), message: '' });
  const send = useSubmit(async () => { await post('/help-requests', f); toast('Your manager has been asked to help. It is in their task list.'); onClose(); });
  return (
    <Dialog open onClose={onClose} title="Request Help" variant="modal" footer={<Button busy={send.busy} onClick={() => send.run()}>Send to my manager</Button>}>
      <p>Your manager in the company you choose gets a task and a notification. For a grievance or a concern about your manager, contact HR directly instead.</p>
      <ErrorSummary error={send.error} />
      <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="What do you need help with?" error={send.error?.fields.message}><textarea name="message" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
    </Dialog>
  );
}

// ── Shared: follow-up actions (tasks) for a review or supervision ──
function Actions({ base, actions, canAdd, reload }: { base: string; actions: any[]; canAdd: boolean; reload: () => void }) {
  const [f, setF] = useState({ title: '', due_on: '' });
  const add = useSubmit(async () => { await post(`${base}/actions`, { title: f.title, due_on: f.due_on || null }); setF({ title: '', due_on: '' }); reload(); });
  return (
    <section aria-label="Actions" style={{ marginTop: 16 }}>
      <h3>Actions</h3>
      {actions.length === 0 ? <p className="muted">No actions yet.</p> : <ul className="list">{actions.map((t) => <li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link><span className="row">{t.due_on && <span className="small">due {fmtDate(t.due_on)}</span>}<Status s={t.status} /></span></li>)}</ul>}
      {canAdd && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); add.run(); }}>
          <ErrorSummary error={add.error} />
          <div className="form-grid"><Field label="New action" error={add.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Due" optional><input name="due_on" type="date" value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></Field></div>
          <Button type="submit" variant="secondary" busy={add.busy}>Add action</Button>
        </form>
      )}
    </section>
  );
}

function PersonPicker({ companyId, value, onChange, error }: { companyId: string; value: string; onChange: (v: string) => void; error?: string }) {
  const { me } = useHub();
  const people = useApi<any[]>(companyId ? `/people?company=${companyId}` : null);
  return <Field label="Person" error={error}><select name="person_id" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{people.data?.filter((p) => p.id !== me.person.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>;
}

// ── Reviews ──
function Reviews() {
  const hub = useHub();
  const list = useApi<any[]>(`/reviews${hub.q()}`);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const cos = hub.me.companies.filter((c) => c.perms.includes('reviews.manage'));
  return (
    <>
      {cos.length > 0 && <p><Button onClick={() => setCreating(true)}>Start a review</Button></p>}
      {list.loading && !list.data ? <Skeleton /> : (list.data ?? []).length === 0 ? <Empty>No reviews yet. Reviews appear here once your manager publishes them.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Type</th><th>Period</th><th>Company</th><th>Status</th></tr></thead>
          <tbody>{list.data!.map((r) => (
            <tr key={r.id}><td><button type="button" className="btn ghost" onClick={() => setOpen(r.id)}>{r.person_name}</button><div className="muted small">by {r.author_name}</div></td><td>{label(r.kind)}</td><td>{fmtDate(r.period_start)} – {fmtDate(r.period_end)}</td>
              <td><CompanyBadge code={r.company_code} name={r.company_name} /></td>
              <td>{r.status === 'draft' ? <Status s="planned" text="Draft" /> : <Status s="verified" text="Published" />}{r.acknowledged_at && <div className="small">Acknowledged</div>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {open && <ReviewPanel id={open} onClose={() => { setOpen(null); list.reload(); }} />}
      {creating && <NewReview cos={cos} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); list.reload(); setOpen(id); }} />}
    </>
  );
}

function NewReview({ cos, onClose, onSaved }: { cos: any[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({ company_id: cos[0].id, person_id: '', kind: 'periodic', period_start: '', period_end: londonToday(), objectives: '' });
  const save = useSubmit(async () => {
    if (!f.person_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { person_id: 'Choose a person' } });
    const r = await post('/reviews', { ...f, objectives: f.objectives || null });
    onSaved(r.id);
  });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onClose={onClose} title="Start a review" footer={<Button busy={save.busy} onClick={() => save.run()}>Create draft</Button>}>
      <p className="small muted">The review stays a draft, visible only to you and other reviewers, until you publish it.</p>
      <ErrorSummary error={save.error} />
      <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, person_id: '' })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <PersonPicker companyId={f.company_id} value={f.person_id} onChange={(v) => setF({ ...f, person_id: v })} error={save.error?.fields.person_id} />
      <Field label="Type"><select name="kind" value={f.kind} onChange={set('kind')}><option value="probation">Probation</option><option value="periodic">Periodic</option><option value="annual">Annual</option></select></Field>
      <div className="form-grid">
        <Field label="Period from" error={save.error?.fields.period_start}><input name="period_start" type="date" value={f.period_start} onChange={set('period_start')} /></Field>
        <Field label="Period to" error={save.error?.fields.period_end}><input name="period_end" type="date" value={f.period_end} onChange={set('period_end')} /></Field>
      </div>
      <Field label="Objectives" optional><textarea name="objectives" value={f.objectives} onChange={set('objectives')} /></Field>
    </Dialog>
  );
}

const REVIEW_FIELDS: [string, string][] = [['objectives', 'Objectives'], ['achievements', 'Achievements and evidence'], ['development', 'Development'], ['feedback', 'Feedback']];
function ReviewPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/reviews/${id}`);
  const toast = useToast();
  const [draft, setDraft] = useState<any>(null);
  const [response, setResponse] = useState<string | null>(null);
  const save = useSubmit(async () => { await patch(`/reviews/${id}`, draft); setDraft(null); toast('Draft saved.'); d.reload(); });
  const publish = useSubmit(async () => { await post(`/reviews/${id}/publish`); toast('Published. The person has been notified.'); d.reload(); });
  const respond = useSubmit(async (acknowledge: boolean) => { await post(`/reviews/${id}/respond`, { staff_response: response ?? undefined, acknowledge }); toast(acknowledge ? 'Acknowledged.' : 'Response saved.'); d.reload(); });
  const r = d.data?.review;
  return (
    <Dialog open onClose={onClose} title={r ? `${label(r.kind)} review — ${r.person_name}` : 'Review'}>
      {d.error && <LoadError error={d.error} />}
      {!r ? <Skeleton /> : (
        <>
          <p><CompanyBadge code={r.company_code} name={r.company_name} /> {fmtDate(r.period_start)} – {fmtDate(r.period_end)} · by {r.author_name} · {r.status === 'draft' ? <Status s="planned" text="Draft" /> : <Status s="verified" text={`Published ${fmtDate(r.published_at)}`} />}</p>
          <ErrorSummary error={save.error ?? publish.error ?? respond.error} />
          {REVIEW_FIELDS.map(([k, t]) => draft ? (
            <Field key={k} label={t} hint="Required before publishing. Drafts can be saved unfinished." error={publish.error?.fields[k]}><textarea name={k} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></Field>
          ) : (
            <div key={k} style={{ marginBottom: 12 }}><h3 style={{ fontSize: '1rem', margin: 0 }}>{t}</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r[k] ?? <span className="muted">Not written yet.</span>}</p></div>
          ))}
          <div className="row">
            {d.data.can.edit && (draft ? <><Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button><Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button></> : <Button variant="secondary" onClick={() => setDraft(Object.fromEntries(REVIEW_FIELDS.map(([k]) => [k, r[k]])))}>Edit draft</Button>)}
            {d.data.can.publish && !draft && <Button variant="go" busy={publish.busy} onClick={() => publish.run()}>Publish to {r.person_name}</Button>}
          </div>
          <section style={{ marginTop: 16 }} aria-labelledby="resp-h">
            <h3 id="resp-h">Response from {r.person_name}</h3>
            {d.data.can.respond ? (
              <>
                <Field label="Your response" hint="Add your view, including anything you disagree with. Your manager can read it." optional><textarea name="staff_response" value={response ?? r.staff_response ?? ''} onChange={(e) => setResponse(e.target.value)} /></Field>
                <div className="row">
                  <Button variant="secondary" busy={respond.busy} onClick={() => respond.run(false)}>Save response</Button>
                  {!r.acknowledged_at && <Button busy={respond.busy} onClick={() => respond.run(true)}>Acknowledge</Button>}
                </div>
                <p className="small muted" style={{ marginTop: 8 }}>Acknowledging means you have read this review. It does not mean you agree with it.</p>
              </>
            ) : <p style={{ whiteSpace: 'pre-wrap' }}>{r.staff_response ?? <span className="muted">No response yet.</span>}</p>}
            {r.acknowledged_at && <p><Status s="verified" text={`Acknowledged ${fmtDate(r.acknowledged_at)} (read, not necessarily agreed)`} /></p>}
          </section>
          <Actions base={`/reviews/${id}`} actions={d.data.actions} canAdd={d.data.can.addAction} reload={d.reload} />
        </>
      )}
    </Dialog>
  );
}

// ── Supervision ──
function Supervision() {
  const hub = useHub();
  const list = useApi<any[]>(`/supervisions${hub.q()}`);
  const manager = hub.can('supervision.manage');
  const due = useApi<any[]>(manager ? `/supervisions/due${hub.q()}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<any>(null);
  const today = londonToday();
  const coachingMinutes = (list.data ?? []).filter((s) => s.person_id === hub.me.person.id && s.kind !== 'supervision' && s.status === 'completed').reduce((t, s) => t + s.minutes, 0);
  return (
    <>
      <div className="kpis"><div className="kpi"><div className="value">{fmtMinutes(coachingMinutes)}</div><div className="label">Coaching and mentoring you have received</div><div className="explain">Completed sessions recorded in the Hub</div></div></div>
      {manager && (
        <section className="card" aria-labelledby="due-h">
          <div className="row between"><h2 id="due-h">Supervision due</h2><Button onClick={() => setCreating({})}>Record a session</Button></div>
          <p className="small muted">Due 8 weeks after the last completed session unless a next date was agreed.</p>
          {due.loading && !due.data ? <Skeleton /> : (due.data ?? []).length === 0 ? <Empty>No current roles in view.</Empty> : (
            <ul className="list">{due.data!.map((p) => {
              const overdue = !p.due_on || p.due_on < today;
              return <li key={`${p.person_id}${p.company_id}`}><span><strong>{p.person_name}</strong> <CompanyBadge code={p.company_code} name={p.company_name} /><br /><span className="muted small">{p.job_title} · last {p.last_held ? fmtDate(p.last_held) : 'never recorded'}</span></span>
                <span className="row">{overdue ? <Status s="action" text={p.due_on ? `Overdue since ${fmtDate(p.due_on)}` : 'None recorded'} /> : <Status s="info" text={`Due ${fmtDate(p.due_on)}`} />}<Button variant="secondary" onClick={() => setCreating({ company_id: p.company_id, person_id: p.person_id })}>Record</Button></span></li>;
            })}</ul>
          )}
        </section>
      )}
      <section className="card" aria-labelledby="sv-h">
        <h2 id="sv-h">Sessions</h2>
        {list.loading && !list.data ? <Skeleton /> : (list.data ?? []).length === 0 ? <Empty>No sessions recorded.</Empty> : (
          <ul className="list">{list.data!.map((s) => <li key={s.id}><span><button type="button" className="btn ghost" onClick={() => setOpen(s.id)}>{label(s.kind)} — {s.person_name}</button><br /><span className="muted small">{fmtDate(s.held_on)} · {fmtMinutes(s.minutes)} · with {s.supervisor_name}</span></span>
            <span className="row"><CompanyBadge code={s.company_code} name={s.company_name} />{s.status === 'draft' ? <Status s="planned" text="Draft" /> : <Status s="completed" />}</span></li>)}</ul>
        )}
      </section>
      {open && <SupervisionPanel id={open} onClose={() => { setOpen(null); list.reload(); due.reload(); }} />}
      {creating && <NewSupervision preset={creating} onClose={() => setCreating(null)} onSaved={(id) => { setCreating(null); list.reload(); setOpen(id); }} />}
    </>
  );
}

function NewSupervision({ preset, onClose, onSaved }: { preset: any; onClose: () => void; onSaved: (id: string) => void }) {
  const hub = useHub();
  const cos = hub.me.companies.filter((c) => c.perms.includes('supervision.manage'));
  const [f, setF] = useState({ company_id: preset.company_id ?? cos[0]?.id ?? '', person_id: preset.person_id ?? '', kind: 'supervision', held_on: londonToday(), minutes: '60', agenda: '' });
  const save = useSubmit(async () => {
    if (!f.person_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { person_id: 'Choose a person' } });
    const r = await post('/supervisions', { ...f, minutes: Number(f.minutes), agenda: f.agenda || null });
    onSaved(r.id);
  });
  return (
    <Dialog open onClose={onClose} title="Record a session" footer={<Button busy={save.busy} onClick={() => save.run()}>Create draft</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, person_id: '' })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <PersonPicker companyId={f.company_id} value={f.person_id} onChange={(v) => setF({ ...f, person_id: v })} error={save.error?.fields.person_id} />
      <div className="form-grid">
        <Field label="Type"><select name="kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="supervision">Supervision</option><option value="coaching">Coaching</option><option value="mentoring">Mentoring</option></select></Field>
        <Field label="Date" error={save.error?.fields.held_on}><input name="held_on" type="date" value={f.held_on} onChange={(e) => setF({ ...f, held_on: e.target.value })} /></Field>
        <Field label="Minutes" error={save.error?.fields.minutes}><input name="minutes" type="number" min={5} max={480} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>
      </div>
      <Field label="Agenda" optional><textarea name="agenda" value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
    </Dialog>
  );
}

function SupervisionPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/supervisions/${id}`);
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const [reflection, setReflection] = useState<string | null>(null);
  const save = useSubmit(async () => { await patch(`/supervisions/${id}`, edit); setEdit(null); toast('Saved.'); d.reload(); });
  const complete = useSubmit(async () => { await post(`/supervisions/${id}/complete`); toast('Completed. The person can now read the shared notes.'); d.reload(); });
  const reflect = useSubmit(async () => { await patch(`/supervisions/${id}`, { staff_reflection: reflection }); toast('Reflection saved.'); d.reload(); });
  const s = d.data?.supervision;
  const can = d.data?.can;
  const fields: [string, string, string?][] = [['agenda', 'Agenda'], ['shared_notes', 'Notes', 'Shared with the person'], ['support_agreed', 'Support agreed'], ...(can?.restricted ? [['restricted_notes', 'Restricted notes', 'Management only. Never shown to the person.'] as [string, string, string]] : [])];
  return (
    <Dialog open onClose={onClose} title={s ? `${label(s.kind)} — ${s.person_name}` : 'Session'}>
      {d.error && <LoadError error={d.error} />}
      {!s ? <Skeleton /> : (
        <>
          <p><CompanyBadge code={s.company_code} name={s.company_name} /> {fmtDate(s.held_on)} · {fmtMinutes(s.minutes)} · with {s.supervisor_name} · {s.status === 'draft' ? <Status s="planned" text="Draft" /> : <Status s="completed" />}</p>
          <ErrorSummary error={save.error ?? complete.error ?? reflect.error} />
          {fields.map(([k, t, hint]) => edit ? (
            <Field key={k} label={t} hint={hint} optional><textarea name={k} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>
          ) : (
            <div key={k} style={{ marginBottom: 12 }}><h3 style={{ fontSize: '1rem', margin: 0 }}>{t}{hint && <span className="muted small"> — {hint}</span>}</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s[k] ?? <span className="muted">—</span>}</p></div>
          ))}
          {edit && <Field label="Next session due" optional><input name="next_due" type="date" value={edit.next_due ?? ''} onChange={(e) => setEdit({ ...edit, next_due: e.target.value || null })} /></Field>}
          <div className="row">
            {can.edit && (edit ? <><Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button></> : <Button variant="secondary" onClick={() => setEdit(Object.fromEntries([...fields.map(([k]) => [k, s[k]]), ['next_due', s.next_due]]))}>Edit notes</Button>)}
            {can.complete && !edit && <Button variant="go" busy={complete.busy} onClick={() => complete.run()}>Mark completed</Button>}
          </div>
          <section style={{ marginTop: 16 }} aria-labelledby="refl-h">
            <h3 id="refl-h">Reflection from {s.person_name}</h3>
            {can.reflect ? (
              <><Field label="Your reflection" optional hint="What was useful, and what support you still need."><textarea name="staff_reflection" value={reflection ?? s.staff_reflection ?? ''} onChange={(e) => setReflection(e.target.value)} /></Field>
                <Button variant="secondary" busy={reflect.busy} onClick={() => reflect.run()}>Save reflection</Button></>
            ) : <p style={{ whiteSpace: 'pre-wrap' }}>{s.staff_reflection ?? <span className="muted">None yet.</span>}</p>}
          </section>
          <Actions base={`/supervisions/${id}`} actions={d.data.actions} canAdd={can.addAction} reload={d.reload} />
        </>
      )}
    </Dialog>
  );
}

// ── Recognition ──
const CATS: [string, string][] = [['learning', 'Learning'], ['quality', 'Quality'], ['teamwork', 'Teamwork'], ['improvement', 'Improvement']];
function Recognition() {
  const hub = useHub();
  const toast = useToast();
  const list = useApi<any[]>(`/recognitions${hub.q()}`);
  const [f, setF] = useState({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies[0]?.id ?? '', person_id: '', category: 'teamwork', note: '' });
  const propose = useSubmit(async () => {
    if (!f.person_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { person_id: 'Choose a colleague' } });
    await post('/recognitions', f); setF({ ...f, person_id: '', note: '' }); toast('Thank you. A manager will review it before it is shown.'); list.reload();
  });
  const decide = useSubmit(async (id: string, approve: boolean) => { await post(`/recognitions/${id}/decide`, { approve }); toast(approve ? 'Recognition approved.' : 'Recognition declined.'); list.reload(); });
  const rows = list.data ?? [];
  const pending = rows.filter((r) => r.status === 'proposed' && hub.can('reviews.manage', r.company_id) && r.person_id !== hub.me.person.id);
  return (
    <div className="grid-2">
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); propose.run(); }} aria-labelledby="rec-h">
        <h2 id="rec-h">Recognise a colleague</h2>
        <p className="small muted">For learning, quality, teamwork or improvement. A manager checks it before it appears.</p>
        <ErrorSummary error={propose.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, person_id: '' })}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <PersonPicker companyId={f.company_id} value={f.person_id} onChange={(v) => setF({ ...f, person_id: v })} error={propose.error?.fields.person_id} />
        <Field label="For"><select name="category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="What did they do?" error={propose.error?.fields.note}><textarea name="note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <Button type="submit" busy={propose.busy}>Send for review</Button>
      </form>
      <section className="card" aria-labelledby="recl-h">
        <h2 id="recl-h">Recognition</h2>
        <ErrorSummary error={decide.error} />
        {pending.length > 0 && <><h3>Waiting for your decision</h3><ul className="list">{pending.map((r) => <li key={r.id}><span><strong>{r.person_name}</strong> — {label(r.category)}<br /><span className="small">{r.note}</span><br /><span className="muted small">Proposed by {r.proposed_by_name}</span></span><span className="row"><Button variant="go" disabled={decide.busy} onClick={() => decide.run(r.id, true)}>Approve</Button><Button variant="secondary" disabled={decide.busy} onClick={() => decide.run(r.id, false)}>Decline</Button></span></li>)}</ul></>}
        {rows.filter((r) => r.status === 'approved').length === 0 ? <Empty>No recognition yet.</Empty> : <ul className="list">{rows.filter((r) => r.status === 'approved').map((r) => <li key={r.id}><span><strong>{r.person_name}</strong> <CompanyBadge code={r.company_code} name={r.company_name} /> — {label(r.category)}<br /><span className="small">{r.note}</span></span><span className="muted small">{fmtDate(r.created_at)}</span></li>)}</ul>}
        {rows.some((r) => r.status === 'proposed' && r.proposed_by === hub.me.person.id) && <p className="small muted">You have recognition waiting for a manager’s review.</p>}
      </section>
    </div>
  );
}

// ── KPI definitions: a change becomes a new version from a date; old months keep their definition ──
function Definitions() {
  const hub = useHub();
  const toast = useToast();
  const list = useApi<any[]>(`/kpi-definitions${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const cos = hub.me.companies.filter((c) => c.perms.includes('performance.manage'));
  const save = useSubmit(async () => { await post('/kpi-definitions', { ...f, target: f.target === '' || f.target === null ? null : Number(f.target), min_data: Number(f.min_data) }); setF(null); toast('New version saved.'); list.reload(); });
  const rows = list.data ?? [];
  const current = rows.filter((d, i) => rows.findIndex((x) => x.key === d.key && x.company_id === d.company_id) === i);
  return (
    <>
      <p className="muted">Formulas are fixed in the software and described below. You can change the wording, target and minimum data. Each change is a new version from a date you choose, so earlier months are still measured as they were.</p>
      {list.loading && !list.data ? <Skeleton /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Measure</th><th>Applies to</th><th className="num">Target</th><th className="num">Min. data</th><th>Version</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{current.map((d) => (
            <tr key={d.id}><td>{d.title}<div className="muted small">{d.formula}</div></td><td>{d.company_code ?? 'All companies'}</td><td className="num">{d.target === null ? '—' : `${Number(d.target)}%`}</td><td className="num">{d.min_data}</td>
              <td>v{d.version} from {fmtDate(d.effective_from)}<div className="muted small">{rows.filter((x) => x.key === d.key && x.company_id === d.company_id).length - 1} earlier</div></td>
              <td><Button variant="ghost" onClick={() => setF({ key: d.key, company_id: cos[0]?.id ?? null, title: d.title, purpose: d.purpose, target: d.target === null ? '' : Number(d.target), min_data: d.min_data, limitations: d.limitations, next_step: d.next_step ?? '', effective_from: `${londonToday().slice(0, 7)}-01`, unit: d.unit })} aria-label={`New version of ${d.title}`}>New version</Button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="New version" footer={<Button busy={save.busy} onClick={() => save.run()}>Save version</Button>}>
        {f && <>
          <ErrorSummary error={save.error} />
          <Field label="Applies to"><select name="company_id" value={f.company_id ?? ''} onChange={(e) => setF({ ...f, company_id: e.target.value || null })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name} only</option>)}{hub.me.superAdmin && <option value="">All companies (default)</option>}</select></Field>
          <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Purpose" error={save.error?.fields.purpose}><textarea name="purpose" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
          {f.unit === 'percent' && <Field label="Target (%)" optional error={save.error?.fields.target}><input name="target" type="number" min={0} max={100} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} style={{ maxWidth: 160 }} /></Field>}
          <Field label="Minimum number of records" hint="Below this, the measure says “Not enough data” instead of a percentage." error={save.error?.fields.min_data}><input name="min_data" type="number" min={0} value={f.min_data} onChange={(e) => setF({ ...f, min_data: e.target.value })} style={{ maxWidth: 160 }} /></Field>
          <Field label="Limitations" error={save.error?.fields.limitations}><textarea name="limitations" value={f.limitations} onChange={(e) => setF({ ...f, limitations: e.target.value })} /></Field>
          <Field label="Suggested next step when below target" optional><textarea name="next_step" value={f.next_step} onChange={(e) => setF({ ...f, next_step: e.target.value })} /></Field>
          <Field label="Effective from" error={save.error?.fields.effective_from}><input name="effective_from" type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
        </>}
      </Dialog>
    </>
  );
}
