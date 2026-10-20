import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

type Tab = 'pack' | 'leads' | 'meetings' | 'decisions' | 'risks' | 'audits' | 'actions' | 'quality' | 'framework';
const PACK_STATUS: Record<string, [string, string]> = { evidence_missing: ['evidence_missing', 'Evidence Missing'], awaiting_review: ['review', 'Awaiting Review'], action_required: ['action', 'Action Required'], verified: ['verified', 'Verified'], not_applicable: ['not_required', 'Not Applicable'] };
const AREAS: [string, string][] = [['staffing', 'Staffing'], ['quality', 'Quality'], ['safeguarding_oversight', 'Safeguarding oversight'], ['property_safety', 'Property safety'], ['complaints_oversight', 'Complaints oversight'], ['finance', 'Finance'], ['data_protection', 'Data protection']];
const ACTION_STATUS: Record<string, [string, string]> = { open: ['info', 'Open'], evidence_submitted: ['review', 'Evidence submitted'], verified: ['verified', 'Verified'], closed: ['completed', 'Closed'], reopened: ['action', 'Reopened'] };

function PersonSelect({ companyId, value, onChange, label: l, optional }: { companyId: string; value: string; onChange: (v: string) => void; label: string; optional?: boolean }) {
  const people = useApi<any[]>(companyId ? `/people?company=${companyId}` : null);
  return <Field label={l} optional={optional}><select name={l} value={value} onChange={(e) => onChange(e.target.value)}><option value="">{optional ? 'None' : 'Choose…'}</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>;
}
function CompanySelect({ perm, value, onChange }: { perm: string; value: string; onChange: (v: string) => void }) {
  const hub = useHub();
  return <Field label="Company"><select name="company_id" value={value} onChange={(e) => onChange(e.target.value)}>{hub.me.companies.filter((c) => c.perms.includes(perm)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>;
}
const firstCo = (hub: ReturnType<typeof useHub>, perm: string) => (hub.company !== 'all' && hub.can(perm, hub.company) ? hub.company : hub.me.companies.find((c) => c.perms.includes(perm))?.id ?? '');

export function Governance() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'pack';
  const tabs: [Tab, string][] = [['pack', 'Monthly pack'], ['leads', 'Leads and structure'], ['meetings', 'Meetings'], ['decisions', 'Decisions'], ['risks', 'Risks'], ['audits', 'Audits'], ['actions', 'Actions'],
    ...(hub.can('quality.view') ? [['quality', 'Quality summaries'] as [Tab, string]] : []), ['framework', 'Assessment framework']];
  return (
    <>
      <PageHead title="Governance and assurance" intro="Who is accountable, what was decided, what could go wrong, and whether improvements actually worked — kept separately for each company." />
      <Tabs label="Governance sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'pack' && <Pack />}
      {tab === 'leads' && <Leads />}
      {tab === 'meetings' && <Meetings />}
      {tab === 'decisions' && <Decisions />}
      {tab === 'risks' && <Risks />}
      {tab === 'audits' && <Audits />}
      {tab === 'actions' && <ActionsList />}
      {tab === 'quality' && <Quality />}
      {tab === 'framework' && <Framework />}
    </>
  );
}

function Pack() {
  const hub = useHub();
  const [month, setMonth] = useState(londonToday().slice(0, 7));
  const d = useApi<any[]>(`/packs${hub.q({ month })}`);
  return (
    <>
      <div className="row between no-print" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="pack-month">Month</label><input id="pack-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 200 }} /></div>
        <Button variant="secondary" onClick={() => print()}>Print or save as PDF</Button>
      </div>
      <p className="muted">Each area has its own status. There is deliberately no single compliance score, because one number hides where action is needed.</p>
      {d.error && <LoadError error={d.error} />}
      {d.loading && !d.data ? <Skeleton lines={8} /> : d.data?.map((c) => (
        <section key={c.company_id} className="card" aria-labelledby={`pk-${c.company_id}`}>
          <h2 id={`pk-${c.company_id}`}><CompanyBadge code={c.company_code} name={c.company_name} /> {c.company_name} — {new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00Z`))}</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Area</th><th>Status</th><th>Figures</th><th className="no-print"><span className="sr-only">Records</span></th></tr></thead>
            <tbody>{c.sections.map((s: any) => { const [st, t] = PACK_STATUS[s.status]; return (
              <tr key={s.key}><td><strong>{s.title}</strong>{s.note && <div className="muted small">{s.note}</div>}</td><td><Status s={st} text={t} /></td>
                <td className="small">{s.figures.length ? s.figures.map(([k, v]: [string, any]) => <div key={k}>{k}: <strong>{v}</strong></div>) : '—'}</td>
                <td className="no-print"><Link to={s.link} aria-label={`Records for ${s.title}`}>Records</Link></td></tr>); })}</tbody>
          </table></div>
        </section>
      ))}
    </>
  );
}

function Leads() {
  const hub = useHub();
  const toast = useToast();
  const leads = useApi<any[]>(`/governance/leads${hub.q()}`);
  const org = useApi<any[]>(`/governance/org-chart${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => { await post('/governance/leads', { ...f, deputy_person_id: f.deputy_person_id || null, lead_person_id: f.lead_person_id || null }); setF(null); toast('Lead recorded. The previous lead is kept in history.'); leads.reload(); });
  const rows = org.data ?? [];
  const tree = (managerId: string | null, companyId: string, depth = 0): any[] => rows.filter((r) => r.company_id === companyId && (managerId ? r.manager_person_id === managerId : !r.manager_person_id || !rows.some((x) => x.person_id === r.manager_person_id && x.company_id === companyId)))
    .flatMap((r) => (depth > 6 ? [] : [<li key={r.id}>{r.person_name} — <span className="muted">{r.job_title}</span>{rows.some((x) => x.manager_person_id === r.person_id && x.company_id === companyId) && <ul>{tree(r.person_id, companyId, depth + 1)}</ul>}</li>]));
  const companies = [...new Map(rows.map((r) => [r.company_id, r.company_code])).entries()];
  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="ld-h">
        <div className="row between"><h2 id="ld-h">Named leads and deputies</h2>{hub.can('governance.manage') && <Button variant="secondary" onClick={() => setF({ company_id: firstCo(hub, 'governance.manage'), area: 'quality', lead_person_id: '', deputy_person_id: '', delegated_authority: '' })}>Set a lead</Button>}</div>
        <p className="small muted">Naming someone a lead records responsibility. It does not give them any extra access.</p>
        {(leads.data ?? []).length === 0 ? <Empty>No leads recorded.</Empty> : <ul className="list">{leads.data!.map((l) => <li key={l.id}><span><strong>{label(l.area)}</strong> <CompanyBadge code={l.company_code} name={l.company_name} /><br />Lead: {l.lead_name ?? 'Not set'}{l.deputy_name && ` · Deputy: ${l.deputy_name}`}{l.delegated_authority && <><br /><span className="small muted">Delegated authority: {l.delegated_authority}</span></>}</span></li>)}</ul>}
      </section>
      <section className="card" aria-labelledby="oc-h">
        <h2 id="oc-h">Organisation chart</h2>
        <p className="small muted">From each appointment’s manager. People with appointments in several companies appear under each.</p>
        {companies.map(([cid, code]) => <div key={cid}><h3 style={{ fontSize: '1rem' }}>{code}</h3><ul>{tree(null, cid)}</ul></div>)}
      </section>
      <Dialog open={!!f} onClose={() => setF(null)} title="Set a lead" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {f && <><ErrorSummary error={save.error} />
          <CompanySelect perm="governance.manage" value={f.company_id} onChange={(v) => setF({ ...f, company_id: v })} />
          <Field label="Area"><select name="area" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>{AREAS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <PersonSelect companyId={f.company_id} label="Lead" value={f.lead_person_id} onChange={(v) => setF({ ...f, lead_person_id: v })} />
          <PersonSelect companyId={f.company_id} label="Deputy" optional value={f.deputy_person_id} onChange={(v) => setF({ ...f, deputy_person_id: v })} />
          <Field label="Delegated authority" optional><textarea name="delegated_authority" value={f.delegated_authority} onChange={(e) => setF({ ...f, delegated_authority: e.target.value })} /></Field></>}
      </Dialog>
    </div>
  );
}

// ── Meetings ──
function Meetings() {
  const hub = useHub();
  const list = useApi<any[]>(`/meetings${hub.q()}`);
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<any>(null);
  const create = useSubmit(async () => { const m = await post('/meetings', { title: f.title, held_on: f.held_on, company_ids: f.company_ids, agenda: f.agenda.split('\n').map((s: string) => s.trim()).filter(Boolean).map((item: string) => ({ item })) }); setF(null); list.reload(); setOpen(m.id); });
  const cos = hub.me.companies.filter((c) => c.perms.includes('governance.manage'));
  return (
    <>
      {cos.length > 0 && <p><Button onClick={() => setF({ title: '', held_on: londonToday(), company_ids: [firstCo(hub, 'governance.manage')], agenda: '' })}>New meeting</Button></p>}
      {(list.data ?? []).length === 0 ? <Empty>No meetings recorded.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Meeting</th><th>Date</th><th>Companies</th><th>Minutes</th><th className="num">Decisions</th></tr></thead>
          <tbody>{list.data!.map((m) => <tr key={m.id}><td><button type="button" className="btn ghost" onClick={() => setOpen(m.id)}>{m.title}</button><div className="muted small">Chair: {m.chair_name ?? '—'}</div></td><td>{fmtDate(m.held_on)}</td><td>{m.company_codes.join(', ')}{m.company_codes.length > 1 && <div className="small muted">Joint meeting</div>}</td>
            <td>{m.minutes_status === 'approved' ? <Status s="verified" text={`Approved v${m.minutes_version}`} /> : <Status s="planned" text={m.minutes_version ? 'Amendment in draft' : 'Draft'} />}</td><td className="num">{m.decisions}</td></tr>)}</tbody></table></div>
      )}
      {open && <MeetingPanel id={open} onClose={() => { setOpen(null); list.reload(); }} />}
      <Dialog open={!!f} onClose={() => setF(null)} title="New meeting" footer={<Button busy={create.busy} onClick={() => create.run()}>Create</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <Field label="Title" error={create.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Date"><input name="held_on" type="date" value={f.held_on} onChange={(e) => setF({ ...f, held_on: e.target.value })} /></Field>
          <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Companies at this meeting</legend><span className="hint">Choose more than one for a joint meeting. Each decision will say which company it affects.</span>
            {cos.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={f.company_ids.includes(c.id)} onChange={(e) => setF({ ...f, company_ids: e.target.checked ? [...f.company_ids, c.id] : f.company_ids.filter((x: string) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
          <Field label="Agenda" hint="One item per line." optional><textarea name="agenda" value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

function MeetingPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/meetings/${id}`);
  const toast = useToast();
  const [m, setM] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [dec, setDec] = useState<any>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const mm = m ?? d.data?.meeting;
  const save = useSubmit(async () => { await patch(`/meetings/${id}`, { agenda: mm.agenda, attendance: mm.attendance, conflicts: mm.conflicts || null, ...(mm.minutes_status === 'draft' ? { minutes: mm.minutes || null } : {}) }); setM(null); toast('Meeting saved.'); d.reload(); });
  const approve = useSubmit(async () => { await save.run(); await post(`/meetings/${id}/approve-minutes`, { amendment_reason: reason || undefined }); toast('Minutes approved. This version is kept.'); setReason(''); d.reload(); });
  const amend = useSubmit(async () => { await post(`/meetings/${id}/amend`); d.reload(); });
  const addDecision = useSubmit(async () => { await post('/decisions', { ...dec, meeting_id: id, review_on: dec.review_on || null }); setDec(null); toast('Decision recorded.'); d.reload(); });
  const paper = useSubmit(async (i: number, file: File) => { setProgress(0); try { const r = await upload(`/meetings/${id}/papers`, file, file.name, setProgress); setM({ ...mm, agenda: mm.agenda.map((a: any, j: number) => (j === i ? { ...a, paper_file_id: r.id, paper_name: r.original_name } : a)) }); } finally { setProgress(null); } });
  if (d.error) return <Dialog open onClose={onClose} title="Meeting"><LoadError error={d.error} /></Dialog>;
  if (!mm) return <Dialog open onClose={onClose} title="Meeting"><Skeleton /></Dialog>;
  const manage = d.data.can.manage;
  const set = (patchObj: any) => setM({ ...mm, ...patchObj });
  return (
    <Dialog open onClose={onClose} title={mm.title}>
      <p>{fmtDate(mm.held_on)} · {d.data.companies.map((c: any) => c.code).join(', ')}</p>
      <ErrorSummary error={save.error ?? approve.error ?? addDecision.error ?? paper.error} />
      <fieldset disabled={!manage} style={{ border: 0, padding: 0, margin: 0 }}>
        <h3>Agenda and papers</h3>
        <ol>{mm.agenda.map((a: any, i: number) => <li key={i}>{a.item}{a.paper_file_id ? <> — <button type="button" className="btn ghost" onClick={() => download(`/files/${a.paper_file_id}`, a.paper_name ?? 'paper')}>paper</button></> : manage && <> — <FilePicker label={`Paper for ${a.item}`} accept="application/pdf,image/*" instant compact busy={paper.busy} buttonText="Attach paper" onChange={(fs) => paper.run(i, fs[0])} /></>}</li>)}</ol>
        {progress !== null && <progress max={100} value={progress} aria-label="Upload progress" />}
        <h3>Attendance</h3>
        {mm.attendance.map((x: any, i: number) => <div key={i} className="row" style={{ marginBottom: 4 }}><span style={{ minWidth: 160 }}>{x.name}</span><select aria-label={`Attendance for ${x.name}`} value={x.status} onChange={(e) => set({ attendance: mm.attendance.map((y: any, j: number) => (j === i ? { ...y, status: e.target.value } : y)) })} style={{ width: 'auto' }}><option value="present">Present</option><option value="apologies">Apologies</option><option value="absent">Absent</option></select></div>)}
        {manage && <Button variant="ghost" onClick={() => { const n = prompt('Name of attendee'); if (n) set({ attendance: [...mm.attendance, { name: n, status: 'present' }] }); }}>Add attendee</Button>}
        <Field label="Conflicts of interest declared" optional><textarea name="conflicts" value={mm.conflicts ?? ''} onChange={(e) => set({ conflicts: e.target.value })} /></Field>
        <Field label="Minutes" hint={mm.minutes_status === 'approved' ? 'Approved. Start an amendment to change them; this version stays on record.' : 'Draft until approved.'}><textarea name="minutes" rows={8} readOnly={mm.minutes_status === 'approved'} value={mm.minutes ?? ''} onChange={(e) => set({ minutes: e.target.value })} /></Field>
        {mm.minutes_status === 'draft' && mm.minutes_version > 0 && <Field label="Reason for amending the approved minutes" error={approve.error?.fields.amendment_reason}><input name="amendment_reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </fieldset>
      {manage && <div className="row" style={{ margin: '12px 0' }}><Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>{mm.minutes_status === 'draft' ? <Button variant="go" busy={approve.busy} onClick={() => approve.run()}>Approve minutes</Button> : <Button variant="secondary" busy={amend.busy} onClick={() => amend.run()}>Start an amendment</Button>}</div>}
      {d.data.versions.length > 0 && <details><summary>Approved versions ({d.data.versions.length})</summary><ul>{d.data.versions.map((v: any) => <li key={v.version}>v{v.version} approved by {v.approved_by_name}, {fmtDateTime(v.approved_at)}{v.amendment_reason && ` — amended: ${v.amendment_reason}`}</li>)}</ul></details>}
      <h3 style={{ marginTop: 16 }}>Decisions</h3>
      {d.data.decisions.length === 0 ? <p className="muted">None recorded.</p> : <ul className="list">{d.data.decisions.map((x: any) => <li key={x.id}><div><strong>{x.title}</strong> <span className="badge co">{x.company_code}</span><p className="small" style={{ margin: '4px 0' }}>Rationale: {x.rationale}</p><span className="muted small">Authorised by {x.authoriser_name} · review {fmtDate(x.review_on)}</span></div></li>)}</ul>}
      {manage && <Button variant="secondary" onClick={() => setDec({ company_id: mm.company_ids[0], title: '', evidence: '', options: '', rationale: '', resources: '', authoriser_id: '', decided_on: mm.held_on, review_on: '' })}>Record a decision</Button>}
      <Dialog open={!!dec} onClose={() => setDec(null)} title="Record a decision" variant="modal" footer={<Button busy={addDecision.busy} onClick={() => addDecision.run()}>Save decision</Button>}>
        {dec && <><ErrorSummary error={addDecision.error} />
          <Field label="Which company does this decision affect?"><select name="company_id" value={dec.company_id} onChange={(e) => setDec({ ...dec, company_id: e.target.value })}>{d.data.companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Decision" error={addDecision.error?.fields.title}><input name="title" value={dec.title} onChange={(e) => setDec({ ...dec, title: e.target.value })} /></Field>
          <Field label="Evidence considered" optional><textarea name="evidence" value={dec.evidence} onChange={(e) => setDec({ ...dec, evidence: e.target.value })} /></Field>
          <Field label="Options considered" optional><textarea name="options" value={dec.options} onChange={(e) => setDec({ ...dec, options: e.target.value })} /></Field>
          <Field label="Rationale" error={addDecision.error?.fields.rationale}><textarea name="rationale" value={dec.rationale} onChange={(e) => setDec({ ...dec, rationale: e.target.value })} /></Field>
          <Field label="Resources needed" optional><input name="resources" value={dec.resources} onChange={(e) => setDec({ ...dec, resources: e.target.value })} /></Field>
          <PersonSelect companyId={dec.company_id} label="Authorised by" value={dec.authoriser_id} onChange={(v) => setDec({ ...dec, authoriser_id: v })} />
          <Field label="Review date" optional><input name="review_on" type="date" value={dec.review_on} onChange={(e) => setDec({ ...dec, review_on: e.target.value })} /></Field></>}
      </Dialog>
    </Dialog>
  );
}

function Decisions() {
  const hub = useHub();
  const d = useApi<any[]>(`/decisions${hub.q()}`);
  return (d.data ?? []).length === 0 ? <Empty>No decisions recorded. Decisions are recorded from a meeting.</Empty> : (
    <div className="table-wrap"><table><thead><tr><th>Decision</th><th>Company</th><th>Decided</th><th>Authorised by</th><th>Review</th></tr></thead>
      <tbody>{d.data!.map((x) => <tr key={x.id}><td><strong>{x.title}</strong><div className="small">{x.rationale}</div>{x.meeting_title && <div className="muted small">From: {x.meeting_title}</div>}</td><td><CompanyBadge code={x.company_code} name={x.company_name} /></td><td>{fmtDate(x.decided_on)}</td><td>{x.authoriser_name}</td><td>{fmtDate(x.review_on)}</td></tr>)}</tbody></table></div>
  );
}

// ── Risks ──
const scoreStatus = (s: number): [string, string] => (s >= 15 ? ['action', `High (${s})`] : s >= 8 ? ['review', `Medium (${s})`] : ['verified', `Low (${s})`]);
function Risks() {
  const hub = useHub();
  const toast = useToast();
  const list = useApi<any[]>(`/risks${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const create = useSubmit(async () => { await post('/risks', { ...f, likelihood: Number(f.likelihood), impact: Number(f.impact), owner_id: f.owner_id || null, review_on: f.review_on || null, target_score: f.target_score ? Number(f.target_score) : null }); setF(null); toast('Risk added.'); list.reload(); });
  return (
    <>
      {hub.can('governance.manage') && <p><Button onClick={() => setF({ company_id: firstCo(hub, 'governance.manage'), title: '', description: '', controls: '', likelihood: 3, impact: 3, owner_id: '', review_on: '', target_score: '' })}>Add a risk</Button></p>}
      <p className="small muted">Score = likelihood × impact (each 1–5). 15 or more is high.</p>
      {(list.data ?? []).length === 0 ? <Empty>No risks recorded.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Risk</th><th>Company</th><th>Owner</th><th>Score</th><th>Review</th><th className="num">Open actions</th></tr></thead>
          <tbody>{list.data!.map((r) => { const [s, t] = scoreStatus(r.score); return <tr key={r.id}><td><button type="button" className="btn ghost" onClick={() => setOpen(r.id)}>{r.title}</button>{r.status === 'closed' && <Status s="ended" text="Closed" />}</td><td><CompanyBadge code={r.company_code} name={r.company_name} /></td><td>{r.owner_name ?? '—'}</td><td><Status s={s} text={t} /></td><td>{fmtDate(r.review_on)}{r.review_on && r.review_on < londonToday() && <div><Status s="action" text="Overdue" /></div>}</td><td className="num">{r.open_actions}</td></tr>; })}</tbody></table></div>
      )}
      {open && <RiskPanel id={open} onClose={() => { setOpen(null); list.reload(); }} />}
      <Dialog open={!!f} onClose={() => setF(null)} title="Add a risk" footer={<Button busy={create.busy} onClick={() => create.run()}>Add</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <CompanySelect perm="governance.manage" value={f.company_id} onChange={(v) => setF({ ...f, company_id: v })} />
          <Field label="Risk" error={create.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Description" optional><textarea name="description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Current controls" optional><textarea name="controls" value={f.controls} onChange={(e) => setF({ ...f, controls: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label="Likelihood (1–5)"><input name="likelihood" type="number" min={1} max={5} value={f.likelihood} onChange={(e) => setF({ ...f, likelihood: e.target.value })} /></Field>
            <Field label="Impact (1–5)"><input name="impact" type="number" min={1} max={5} value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} /></Field>
            <Field label="Target score" optional><input name="target_score" type="number" min={1} max={25} value={f.target_score} onChange={(e) => setF({ ...f, target_score: e.target.value })} /></Field>
          </div>
          <PersonSelect companyId={f.company_id} label="Owner" optional value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} />
          <Field label="Review by" optional><input name="review_on" type="date" value={f.review_on} onChange={(e) => setF({ ...f, review_on: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
function RiskPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/risks/${id}`);
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [act, setAct] = useState<any>(null);
  const assess = useSubmit(async () => { await post(`/risks/${id}/assess`, { likelihood: Number(a.likelihood), impact: Number(a.impact), note: a.note }); setA(null); toast('Reassessed.'); d.reload(); });
  const r = d.data?.risk;
  return (
    <Dialog open onClose={onClose} title={r?.title ?? 'Risk'}>
      {!r ? <Skeleton /> : <>
        <dl className="facts"><dt>Score</dt><dd><Status s={scoreStatus(r.score)[0]} text={scoreStatus(r.score)[1]} /> (likelihood {r.likelihood} × impact {r.impact}){r.target_score && ` · target ${r.target_score}`}</dd><dt>Controls</dt><dd>{r.controls ?? '—'}</dd><dt>Review by</dt><dd>{fmtDate(r.review_on)}</dd></dl>
        {d.data.can.manage && <div className="row" style={{ margin: '12px 0' }}><Button variant="secondary" onClick={() => setA({ likelihood: r.likelihood, impact: r.impact, note: '' })}>Reassess</Button><Button variant="secondary" onClick={() => setAct({})}>Add a further action</Button></div>}
        <h3>Assessment history</h3>
        <ul className="list">{d.data.assessments.map((x: any) => <li key={x.id}><span>{x.likelihood} × {x.impact} = <strong>{x.likelihood * x.impact}</strong> — {x.note}</span><span className="muted small">{x.assessed_by_name}, {fmtDate(x.assessed_at)}</span></li>)}</ul>
        <h3>Further actions</h3>
        {d.data.actions.length === 0 ? <p className="muted">None.</p> : <ul className="list">{d.data.actions.map((x: any) => <li key={x.id}><Link to={`/governance/actions/${x.id}`}>{x.action}</Link><Status s={ACTION_STATUS[x.status][0]} text={ACTION_STATUS[x.status][1]} /></li>)}</ul>}
      </>}
      <Dialog open={!!a} onClose={() => setA(null)} title="Reassess risk" variant="modal" footer={<Button busy={assess.busy} onClick={() => assess.run()}>Save</Button>}>
        {a && <><ErrorSummary error={assess.error} /><div className="form-grid"><Field label="Likelihood (1–5)"><input name="likelihood" type="number" min={1} max={5} value={a.likelihood} onChange={(e) => setA({ ...a, likelihood: e.target.value })} /></Field><Field label="Impact (1–5)"><input name="impact" type="number" min={1} max={5} value={a.impact} onChange={(e) => setA({ ...a, impact: e.target.value })} /></Field></div>
          <Field label="Why has it changed?" error={assess.error?.fields.note}><textarea name="note" value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} /></Field></>}
      </Dialog>
      {act && r && <NewAction source={{ company_id: r.company_id, source_type: 'risk', source_id: r.id, finding: r.title }} onClose={() => setAct(null)} onSaved={() => { setAct(null); d.reload(); }} />}
    </Dialog>
  );
}

export function NewAction({ source, onClose, onSaved }: { source: { company_id: string; source_type: string; source_id?: string; finding?: string }; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ finding: source.finding ?? '', action: '', significance: 'standard', owner_id: '', due_on: '', effectiveness_review_on: '' });
  const save = useSubmit(async () => { await post('/actions', { ...source, ...f, owner_id: f.owner_id || null, due_on: f.due_on || null, effectiveness_review_on: f.effectiveness_review_on || null }); toast('Action created.'); onSaved(); });
  return (
    <Dialog open onClose={onClose} title="New improvement action" variant="modal" footer={<Button busy={save.busy} onClick={() => save.run()}>Create action</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Finding" error={save.error?.fields.finding}><textarea name="finding" value={f.finding} onChange={(e) => setF({ ...f, finding: e.target.value })} /></Field>
      <Field label="Action" error={save.error?.fields.action}><textarea name="action" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
      <Field label="Significance" hint="A significant action can only close after verification and a review of whether it worked."><select name="significance" value={f.significance} onChange={(e) => setF({ ...f, significance: e.target.value })}><option value="standard">Standard</option><option value="significant">Significant</option></select></Field>
      <PersonSelect companyId={source.company_id} label="Owner" optional value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} />
      <div className="form-grid"><Field label="Deadline" optional><input name="due_on" type="date" value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></Field><Field label="Check it worked on" optional><input name="effectiveness_review_on" type="date" value={f.effectiveness_review_on} onChange={(e) => setF({ ...f, effectiveness_review_on: e.target.value })} /></Field></div>
    </Dialog>
  );
}

// ── Audits ──
const RUBRIC: [string, string][] = [['met', 'Met'], ['partly_met', 'Partly met'], ['not_met', 'Not met'], ['not_applicable', 'Not applicable']];
function Audits() {
  const hub = useHub();
  const list = useApi<any[]>(`/audits${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const create = useSubmit(async () => { const a = await post('/audits', { ...f, reviewer_id: f.reviewer_id || null, rubric: f.rubric.split('\n').map((s: string) => s.trim()).filter(Boolean).map((criterion: string) => ({ criterion })) }); setF(null); list.reload(); setOpen(a.id); });
  return (
    <>
      {hub.can('governance.manage') && <p><Button onClick={() => setF({ company_id: firstCo(hub, 'governance.manage'), area: 'staff_files', title: '', scope: '', sample: '', reviewer_id: '', planned_on: londonToday(), rubric: '' })}>Plan an audit</Button></p>}
      {(list.data ?? []).length === 0 ? <Empty>No audits planned.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Audit</th><th>Company</th><th>Planned</th><th>Status</th><th className="num">Findings (open)</th></tr></thead>
          <tbody>{list.data!.map((a) => <tr key={a.id}><td><button type="button" className="btn ghost" onClick={() => setOpen(a.id)}>{a.title}</button><div className="muted small">{label(a.area)} · reviewer {a.reviewer_name ?? '—'}</div></td><td><CompanyBadge code={a.company_code} name={a.company_name} /></td><td>{fmtDate(a.planned_on)}</td><td>{a.status === 'completed' ? <Status s="verified" text={`Completed ${fmtDate(a.completed_on)}`} /> : <Status s={a.planned_on < londonToday() ? 'action' : 'planned'} text={label(a.status)} />}</td><td className="num">{a.findings} ({a.open_findings})</td></tr>)}</tbody></table></div>
      )}
      {open && <AuditPanel id={open} onClose={() => { setOpen(null); list.reload(); }} />}
      <Dialog open={!!f} onClose={() => setF(null)} title="Plan an audit" footer={<Button busy={create.busy} onClick={() => create.run()}>Create</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <CompanySelect perm="governance.manage" value={f.company_id} onChange={(v) => setF({ ...f, company_id: v })} />
          <Field label="Area"><select name="area" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>{['staff_files', 'recruitment', 'training', 'supervision', 'governance', 'agents', 'information_security', 'property_safety'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
          <Field label="Title" error={create.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Scope" optional><textarea name="scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></Field>
          <Field label="Sample" optional hint="For example: 5 of 20 staff files chosen at random."><input name="sample" value={f.sample} onChange={(e) => setF({ ...f, sample: e.target.value })} /></Field>
          <PersonSelect companyId={f.company_id} label="Reviewer" optional value={f.reviewer_id} onChange={(v) => setF({ ...f, reviewer_id: v })} />
          <Field label="Planned for"><input name="planned_on" type="date" value={f.planned_on} onChange={(e) => setF({ ...f, planned_on: e.target.value })} /></Field>
          <Field label="Rubric" hint="One criterion per line. Use your own approved rubric." optional><textarea name="rubric" value={f.rubric} onChange={(e) => setF({ ...f, rubric: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
function AuditPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/audits/${id}`);
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [finding, setFinding] = useState(false);
  const au = a ?? d.data?.audit;
  const save = useSubmit(async (complete: boolean) => { await patch(`/audits/${id}`, { rubric: au.rubric, summary: au.summary || null, status: complete ? 'completed' : au.status === 'planned' ? 'in_progress' : au.status }); setA(null); toast(complete ? 'Audit completed.' : 'Saved.'); d.reload(); });
  if (!au) return <Dialog open onClose={onClose} title="Audit"><Skeleton /></Dialog>;
  const edit = d.data.can.manage && au.status !== 'completed';
  return (
    <Dialog open onClose={onClose} title={au.title}>
      <dl className="facts"><dt>Area</dt><dd>{label(au.area)}</dd><dt>Scope</dt><dd>{au.scope ?? '—'}</dd><dt>Sample</dt><dd>{au.sample ?? '—'}</dd></dl>
      <ErrorSummary error={save.error} />
      <h3 style={{ marginTop: 16 }}>Rubric</h3>
      {au.rubric.length === 0 && <p className="muted">No criteria.</p>}
      {au.rubric.map((r: any, i: number) => (
        <fieldset key={i} className="card" disabled={!edit}><legend style={{ fontWeight: 600 }}>{r.criterion}</legend>
          <div className="chips" role="radiogroup" aria-label={`Result for ${r.criterion}`}>{RUBRIC.map(([k, t]) => <label key={k} className="check" style={{ marginRight: 12 }}><input type="radio" name={`r-${i}`} checked={r.result === k} onChange={() => setA({ ...au, rubric: au.rubric.map((x: any, j: number) => (j === i ? { ...x, result: k } : x)) })} /> {t}</label>)}</div>
          <Field label="Note" optional><input name={`r-${i}-note`} value={r.note ?? ''} onChange={(e) => setA({ ...au, rubric: au.rubric.map((x: any, j: number) => (j === i ? { ...x, note: e.target.value } : x)) })} /></Field>
        </fieldset>
      ))}
      <Field label="Summary" optional><textarea name="summary" readOnly={!edit} value={au.summary ?? ''} onChange={(e) => setA({ ...au, summary: e.target.value })} /></Field>
      {edit && <div className="row"><Button variant="secondary" busy={save.busy} onClick={() => save.run(false)}>Save Changes</Button><Button variant="go" busy={save.busy} onClick={() => save.run(true)}>Complete audit</Button></div>}
      <h3 style={{ marginTop: 16 }}>Findings and actions</h3>
      {d.data.actions.length === 0 ? <p className="muted">No findings.</p> : <ul className="list">{d.data.actions.map((x: any) => <li key={x.id}><span><Link to={`/governance/actions/${x.id}`}>{x.finding}</Link><br /><span className="small muted">{x.action} · owner {x.owner_name ?? '—'}</span></span><Status s={ACTION_STATUS[x.status][0]} text={ACTION_STATUS[x.status][1]} /></li>)}</ul>}
      {d.data.can.manage && <Button variant="secondary" onClick={() => setFinding(true)}>Record a finding</Button>}
      {finding && <NewAction source={{ company_id: au.company_id, source_type: 'audit', source_id: au.id }} onClose={() => setFinding(false)} onSaved={() => { setFinding(false); d.reload(); }} />}
    </Dialog>
  );
}

// ── Actions ──
function ActionsList() {
  const hub = useHub();
  const [mine, setMine] = useState<'all' | 'mine'>('all');
  const [creating, setCreating] = useState(false);
  const d = useApi<any[]>(`/actions${hub.q()}`);
  const rows = (d.data ?? []).filter((x) => mine === 'all' || x.owner_id === hub.me.person.id);
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}><Chips label="Whose actions" value={mine} onChange={setMine} options={[['all', 'All I can see'], ['mine', 'Mine']]} />{hub.can('governance.manage') && <Button onClick={() => setCreating(true)}>New action</Button>}</div>
      <p className="small muted">Every action follows: finding → action → owner → deadline → evidence → verification → check that it worked.</p>
      {rows.length === 0 ? <Empty>No actions.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Action</th><th>From</th><th>Company</th><th>Owner</th><th>Deadline</th><th>Status</th></tr></thead>
          <tbody>{rows.map((x) => <tr key={x.id}><td><Link to={`/governance/actions/${x.id}`}>{x.action}</Link>{x.significance === 'significant' && <div><Status s="review" text="Significant" /></div>}</td><td>{label(x.source_type)}</td><td><CompanyBadge code={x.company_code} name={x.company_name} /></td><td>{x.owner_name ?? '—'}</td><td>{fmtDate(x.due_on)}{x.overdue && <div><Status s="action" text="Overdue" /></div>}</td><td><Status s={ACTION_STATUS[x.status][0]} text={ACTION_STATUS[x.status][1]} />{x.effectiveness && <div className="small">{label(x.effectiveness)}</div>}</td></tr>)}</tbody></table></div>
      )}
      {creating && <NewAction source={{ company_id: firstCo(hub, 'governance.manage'), source_type: 'other' }} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); d.reload(); }} />}
    </>
  );
}

export function ActionPage() {
  const { id } = useParams();
  const d = useApi<any>(`/actions/${id}`);
  const toast = useToast();
  const [ev, setEv] = useState({ note: '', file: null as File | null });
  const [v, setV] = useState({ note: '' });
  const [r, setR] = useState({ effectiveness: 'effective', recurred: false, note: '' });
  const done = (m: string) => { toast(m); d.reload(); };
  const evidence = useSubmit(async () => {
    if (ev.note.trim().length < 3) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { note: 'Describe what was done' } });
    await upload(`/actions/${id}/evidence`, ev.file, ev.file?.name ?? '', undefined, { note: ev.note });
    setEv({ note: '', file: null }); done('Evidence submitted. Someone else will verify it.');
  });
  const verify = useSubmit(async (accept: boolean) => { await post(`/actions/${id}/verify`, { accept, note: v.note }); setV({ note: '' }); done(accept ? 'Verified.' : 'Sent back for more evidence.'); });
  const review = useSubmit(async () => { await post(`/actions/${id}/review`, r); done('Effectiveness recorded.'); });
  const close = useSubmit(async () => { await post(`/actions/${id}/close`); done('Closed.'); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const x = d.data.action, can = d.data.can;
  const steps: [string, boolean, string][] = [['Finding', true, x.finding], ['Action', true, x.action], ['Owner and deadline', !!x.owner_id, `${x.owner_name ?? 'No owner yet'} · ${fmtDate(x.due_on)}`], ['Evidence', !!x.evidence_at, x.evidence_note ?? 'Not yet'], ['Verification', !!x.verified_at, x.verified_at ? `${x.verified_by_name}, ${fmtDate(x.verified_at)}: ${x.verification_note}` : x.verification_note ? `Sent back: ${x.verification_note}` : 'Not yet'], ['Did it work?', !!x.effectiveness, x.effectiveness ? `${label(x.effectiveness)}${x.recurred ? ' — the issue came back' : ''}: ${x.effectiveness_note}` : x.effectiveness_review_on ? `Due ${fmtDate(x.effectiveness_review_on)}` : 'Not yet']];
  return (
    <>
      <PageHead title={x.action} crumbs={[['Governance', '/governance?tab=actions'], ['Action']]} intro={<><CompanyBadge code={x.company_code} name={x.company_name} /> From {label(x.source_type)} · {x.significance === 'significant' ? 'Significant' : 'Standard'}</>} actions={<Status s={ACTION_STATUS[x.status][0]} text={ACTION_STATUS[x.status][1]} />} />
      <ErrorSummary error={evidence.error ?? verify.error ?? review.error ?? close.error} />
      <ol className="card" style={{ listStyle: 'none', paddingLeft: 24 }}>{steps.map(([t, ok, body]) => <li key={t} style={{ marginBottom: 12 }}><Status s={ok ? 'verified' : 'not_required'} text={ok ? 'Done' : 'To do'} /> <strong>{t}</strong><div style={{ whiteSpace: 'pre-wrap' }}>{body}</div></li>)}</ol>
      {d.data.files.length > 0 && <p>Evidence files: {d.data.files.map((f: any) => <button key={f.id} type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button>)}</p>}
      {can.evidence && ['open', 'reopened'].includes(x.status) && (
        <section className="card" aria-labelledby="ev-h"><h2 id="ev-h">Add evidence</h2>
          <p className="small muted">Uploading evidence does not close the action: someone else checks it.</p>
          <Field label="What was done?" error={evidence.error?.fields.note}><textarea name="note" value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} /></Field>
          <FilePicker label="Supporting file" accept="application/pdf,image/*" onChange={(fs) => setEv({ ...ev, file: fs[0] ?? null })} />
          <Button busy={evidence.busy} onClick={() => evidence.run()}>Submit evidence</Button></section>
      )}
      {can.manage && x.status === 'evidence_submitted' && (
        <section className="card" aria-labelledby="vf-h"><h2 id="vf-h">Verify</h2>
          <Field label="What did you check?" error={verify.error?.fields.note}><textarea name="vnote" value={v.note} onChange={(e) => setV({ note: e.target.value })} /></Field>
          <div className="row"><Button variant="go" busy={verify.busy} onClick={() => verify.run(true)}>Verify</Button><Button variant="secondary" busy={verify.busy} onClick={() => verify.run(false)}>Ask for more evidence</Button></div></section>
      )}
      {can.manage && x.verified_at && !x.effectiveness && (
        <section className="card" aria-labelledby="ef-h"><h2 id="ef-h">Did it work?</h2>
          <Field label="Effectiveness"><select name="effectiveness" value={r.effectiveness} onChange={(e) => setR({ ...r, effectiveness: e.target.value })}><option value="effective">Effective</option><option value="partly_effective">Partly effective</option><option value="not_effective">Not effective</option></select></Field>
          <label className="check"><input type="checkbox" checked={r.recurred} onChange={(e) => setR({ ...r, recurred: e.target.checked })} /> The issue has happened again</label>
          <Field label="What did you look at?" error={review.error?.fields.note}><textarea name="rnote" value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} /></Field>
          <Button busy={review.busy} onClick={() => review.run()}>Record review</Button></section>
      )}
      {can.manage && x.status === 'verified' && <Button variant="go" busy={close.busy} onClick={() => close.run()}>Close action</Button>}
    </>
  );
}

// ── Quality summaries ──
const MEASURES: [string, string][] = [['missed_contacts', 'Missed contacts'], ['follow_up_outstanding', 'Follow-up outstanding'], ['safeguarding_actions_outstanding', 'Safeguarding actions outstanding'], ['complaint_themes', 'Complaint themes'], ['resident_feedback', 'Resident feedback'], ['outcome_measure', 'Outcome measure']];
function Quality() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/quality-summaries${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => { await post('/quality-summaries', { ...f, value: f.value === '' ? null : Number(f.value), theme: f.theme || null }); setF(null); toast('Summary saved. Someone else must verify it.'); d.reload(); });
  const verify = useSubmit(async (sid: string) => { await post(`/quality-summaries/${sid}/verify`); d.reload(); });
  return (
    <>
      <div className="notice">These are summary figures copied from the separate support system. They contain no names or case details, are not a live link, and counts below 5 are hidden to prevent identification. Low numbers are not, on their own, a sign of good practice.</div>
      {hub.can('quality.manage') && <p><Button onClick={() => setF({ company_id: firstCo(hub, 'quality.manage'), measure: 'missed_contacts', period_start: '', period_end: '', value: '', theme: '', definition: '', source: '', sensitive: false })}>Enter a summary</Button></p>}
      <ErrorSummary error={verify.error} />
      {(d.data ?? []).length === 0 ? <Empty>No summaries entered.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Measure</th><th>Company</th><th>Period</th><th className="num">Value</th><th>Source and definition</th><th>Verified</th></tr></thead>
          <tbody>{d.data!.map((s) => <tr key={s.id}><td>{label(s.measure)}{s.theme && <div className="small">{s.theme}</div>}{s.sensitive && <div><Status s="review" text="Restricted" /></div>}</td><td><CompanyBadge code={s.company_code} name={s.company_name} /></td><td>{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</td><td className="num">{s.suppressed ?? (s.value === null ? '—' : Number(s.value))}</td>
            <td className="small">{s.source}<div className="muted">{s.definition}</div><div className="muted">Entered {fmtDateTime(s.entered_at)} by {s.entered_by_name}</div></td>
            <td>{s.verified_at ? <Status s="verified" text={`By ${s.verified_by_name}`} /> : hub.can('quality.manage', s.company_id) && s.entered_by !== hub.me.person.id ? <Button variant="secondary" busy={verify.busy} onClick={() => verify.run(s.id)}>Verify</Button> : <Status s="review" text="Awaiting Review" />}</td></tr>)}</tbody></table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Enter a quality summary" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {f && <><ErrorSummary error={save.error} />
          <CompanySelect perm="quality.manage" value={f.company_id} onChange={(v) => setF({ ...f, company_id: v })} />
          <Field label="Measure"><select name="measure" value={f.measure} onChange={(e) => setF({ ...f, measure: e.target.value })}>{MEASURES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <div className="form-grid"><Field label="From" error={save.error?.fields.period_start}><input name="period_start" type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Field><Field label="To" error={save.error?.fields.period_end}><input name="period_end" type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Field><Field label="Value" optional hint="A count or percentage only."><input name="value" type="number" min={0} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field></div>
          <Field label="Theme" optional hint="General theme only — never names or case details." error={save.error?.fields.theme}><input name="theme" value={f.theme} onChange={(e) => setF({ ...f, theme: e.target.value })} /></Field>
          <Field label="Definition" error={save.error?.fields.definition}><input name="definition" value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} /></Field>
          <Field label="Source" error={save.error?.fields.source}><input name="source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={f.sensitive} onChange={(e) => setF({ ...f, sensitive: e.target.checked })} /> Restricted (only quality managers can see it)</label></>}
      </Dialog>
    </>
  );
}

// ── Assessment framework mapping ──
function Framework() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/framework${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => {
    const body = { framework: f.framework, ref: f.ref, title: f.title, status: f.status, note: f.note || null, evidence: f.evidence.split('\n').map((s: string) => s.trim()).filter(Boolean).map((l: string) => { const [label2, link] = l.split('|').map((x) => x.trim()); return { label: label2, link: link || label2 }; }) };
    if (f.id) await patch(`/framework/${f.id}`, body); else await post('/framework', { ...body, company_id: f.company_id });
    setF(null); toast('Saved.'); d.reload();
  });
  return (
    <>
      <p className="muted">Enter the criteria from your current assessment framework and map evidence to them. The Hub does not supply official criteria and cannot guarantee any inspection outcome.</p>
      {hub.can('governance.manage') && <p><Button onClick={() => setF({ company_id: firstCo(hub, 'governance.manage'), framework: '', ref: '', title: '', status: 'evidence_missing', note: '', evidence: '' })}>Add a criterion</Button></p>}
      {(d.data ?? []).length === 0 ? <Empty>No framework criteria entered.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Ref</th><th>Criterion</th><th>Company</th><th>Evidence</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{d.data!.map((x) => { const [s, t] = PACK_STATUS[x.status]; return <tr key={x.id}><td>{x.framework} {x.ref}</td><td>{x.title}{x.note && <div className="small muted">{x.note}</div>}</td><td>{x.company_code}</td><td className="small">{x.evidence.map((e: any, i: number) => <div key={i}>{e.link.startsWith('/') ? <Link to={e.link}>{e.label}</Link> : e.label}</div>)}</td><td><Status s={s} text={t} /></td>
            <td>{hub.can('governance.manage', x.company_id) && <Button variant="ghost" onClick={() => setF({ ...x, evidence: x.evidence.map((e: any) => `${e.label} | ${e.link}`).join('\n') })}>Edit</Button>}</td></tr>; })}</tbody></table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit criterion' : 'Add a criterion'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {f && <><ErrorSummary error={save.error} />
          {!f.id && <CompanySelect perm="governance.manage" value={f.company_id} onChange={(v) => setF({ ...f, company_id: v })} />}
          <div className="form-grid"><Field label="Framework name"><input name="framework" value={f.framework} onChange={(e) => setF({ ...f, framework: e.target.value })} /></Field><Field label="Reference"><input name="ref" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field></div>
          <Field label="Criterion (as written in your framework)"><textarea name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Evidence" hint="One per line: description | link (for example: Supervision records | /performance?tab=supervision)" optional><textarea name="evidence" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} /></Field>
          <Field label="Status"><select name="status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(PACK_STATUS).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Note" optional><textarea name="note" value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
