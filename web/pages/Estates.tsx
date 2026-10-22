import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, PhotoGrid, Skeleton, Status, Tabs, useToast } from '../ui.tsx';
import { uploadPhotos } from './Visits.tsx';
import { NewAction } from './Governance.tsx';

const REPAIR_STATUS: Record<string, [string, string]> = { reported: ['info', 'Reported'], triaged: ['info', 'Triaged'], assigned: ['planned', 'Assigned'], in_progress: ['review', 'In Progress'], awaiting_verification: ['submitted', 'Awaiting Verification'], closed: ['completed', 'Closed'] };
const URGENCY: Record<string, [string, string]> = { emergency: ['urgent', 'Emergency'], urgent: ['high', 'Urgent'], routine: ['normal', 'Routine'] };
const SAFETY_STATE: Record<string, [string, string]> = { never_done: ['action', 'Never recorded'], failed: ['action', 'Failed'], overdue: ['action', 'Overdue'], due_soon: ['review', 'Due soon'], in_date: ['verified', 'In date'] };

type Tab = 'repairs' | 'safety' | 'agents';
export function Estates() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'repairs';
  const showAgents = hub.can('agents.manage') || hub.can('governance.view');
  return (
    <>
      <PageHead title="Repairs and property safety" intro="Repairs, safety schedules and managing agents. Record property matters only — never resident names or details." />
      <Tabs label="Sections" tabs={[['repairs', 'Repairs'], ['safety', 'Safety schedule'], ...(showAgents ? [['agents', 'Managing agents'] as [Tab, string]] : [])]} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'repairs' && <Repairs />}
      {tab === 'safety' && <Safety property={params.get('property')} />}
      {tab === 'agents' && showAgents && <Agents />}
    </>
  );
}

export function ReportRepair({ properties, onClose, onSaved }: { properties: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ property_id: properties.length === 1 ? properties[0].id : '', title: '', description: '', impact: '', urgency: 'routine', immediate_action: '' });
  const [photos, setPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const save = useSubmit(async () => {
    const r = await post('/repairs', { ...f, description: f.description || null, impact: f.impact || null, immediate_action: f.immediate_action || null });
    const failed = photos.length ? await uploadPhotos(`/repairs/${r.id}/photos`, photos, setProgress) : 0;
    toast(failed ? `Repair reported. ${failed} photo${failed === 1 ? '' : 's'} did not upload — add ${failed === 1 ? 'it' : 'them'} on the repair.` : 'Repair reported. The repairs manager has it as a task.'); onSaved();
  });
  return (
    <Dialog open onClose={onClose} title="Report a repair" footer={<Button busy={save.busy} onClick={() => save.run()}>Report</Button>}>
      <div className="notice warn">If anyone is in danger, call 999 first. For gas, call the National Gas Emergency number.</div>
      <ErrorSummary error={save.error} />
      <Field label="Property" error={save.error?.fields.property_id}><select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">Choose…</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>
      <Field label="What is wrong?" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Details" optional hint="Property details only — use room labels, not names."><textarea name="description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Urgency"><select name="urgency" value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value })}><option value="emergency">Emergency — risk to safety now</option><option value="urgent">Urgent — within a week</option><option value="routine">Routine</option></select></Field>
      <Field label="Impact" optional><input name="impact" value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} /></Field>
      <Field label="Immediate action taken" optional><input name="immediate_action" value={f.immediate_action} onChange={(e) => setF({ ...f, immediate_action: e.target.value })} /></Field>
      <FilePicker label="Photos of the problem" hint="Up to 20. Do not photograph residents." accept="image/jpeg,image/png,image/webp" multiple busy={progress !== null} progress={progress} onChange={setPhotos} />
    </Dialog>
  );
}

function Repairs() {
  const hub = useHub();
  const d = useApi<any[]>(`/repairs${hub.q()}`);
  const props = useApi<any[]>(`/properties${hub.q()}`);
  const [reporting, setReporting] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const rows = (d.data ?? []).filter((r) => showClosed || r.status !== 'closed');
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}><label className="check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed repairs</label><Button onClick={() => setReporting(true)}>Report a repair</Button></div>
      {d.loading && !d.data ? <Skeleton /> : rows.length === 0 ? <Empty>No open repairs.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Repair</th><th>Property</th><th>Urgency</th><th>Assigned to</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td><Link to={`/estates/repairs/${r.id}`}>{r.title}</Link></td><td>{r.property_name} <CompanyBadge code={r.company_code} name={r.company_name} /></td><td><Status s={URGENCY[r.urgency][0]} text={URGENCY[r.urgency][1]} /></td><td>{r.assignee_name ?? r.agent_name ?? r.contractor ?? '—'}</td><td>{fmtDate(r.due_on)}{r.overdue && <div><Status s="action" text="Overdue" /></div>}</td><td><Status s={REPAIR_STATUS[r.status][0]} text={REPAIR_STATUS[r.status][1]} /></td></tr>)}</tbody></table></div>
      )}
      {reporting && <ReportRepair properties={props.data ?? []} onClose={() => setReporting(false)} onSaved={() => { setReporting(false); d.reload(); }} />}
    </>
  );
}

// Calendar days from reporting to the work being done.
const daysBetween = (from: string, to: string) => { const n = Math.round((Date.parse(to) - Date.parse(from.slice(0, 10))) / 864e5); return n <= 0 ? 'Same day' : `${n} day${n === 1 ? '' : 's'}`; };

export function RepairPage() {
  const { id } = useParams();
  const d = useApi<any>(`/repairs/${id}`);
  const toast = useToast();
  const [move, setMove] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [upd, setUpd] = useState({ body: '', file: null as File | null });
  const [pickerKey, setPickerKey] = useState(0); // remounts the picker to clear it after an update
  const [assign, setAssign] = useState<any>(null);
  const people = useApi<any[]>(assign && d.data ? `/people?company=${d.data.repair.company_id}` : null);
  const agents = useApi<any[]>(assign && d.data ? `/agents?company=${d.data.repair.company_id}` : null);
  const status = useSubmit(async () => { await post(`/repairs/${id}/status`, { status: move, note }); setMove(null); setNote(''); toast('Repair updated.'); d.reload(); });
  const addUpd = useSubmit(async () => { await upload(`/repairs/${id}/updates`, upd.file, upd.file?.name ?? '', undefined, { body: upd.body }); setUpd({ body: '', file: null }); setPickerKey((k) => k + 1); d.reload(); });
  const [photoProgress, setPhotoProgress] = useState<number | null>(null);
  const addPhotos = useSubmit(async (fs: File[]) => { const failed = await uploadPhotos(`/repairs/${id}/photos`, fs, setPhotoProgress); toast(failed ? `${failed} photo${failed === 1 ? '' : 's'} did not upload.` : 'Photos added.'); d.reload(); });
  const saveAssign = useSubmit(async () => { await patch(`/repairs/${id}`, { assignee_id: assign.assignee_id || null, agent_id: assign.agent_id || null, contractor: assign.contractor || null, due_on: assign.due_on || null, urgency: assign.urgency }); setAssign(null); toast('Saved.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { repair: r, updates, files, can } = d.data;
  return (
    <>
      <PageHead title={r.title} crumbs={[['Repairs', '/estates'], [r.title]]} intro={<>{r.property_name} · <span className="badge co">{r.company_code}</span> · reported by {r.reported_by_name} on {fmtDate(r.created_at)}</>}
        actions={<><Status s={URGENCY[r.urgency][0]} text={URGENCY[r.urgency][1]} /><Status s={REPAIR_STATUS[r.status][0]} text={REPAIR_STATUS[r.status][1]} /></>} />
      <ErrorSummary error={status.error ?? addUpd.error ?? addPhotos.error} />
      <div className="grid-2">
        <section className="card" aria-labelledby="rd-h"><h2 id="rd-h">Details</h2>
          <dl className="facts"><dt>Details</dt><dd>{r.description ?? '—'}</dd><dt>Impact</dt><dd>{r.impact ?? '—'}</dd><dt>Immediate action</dt><dd>{r.immediate_action ?? '—'}</dd><dt>Repairs manager</dt><dd>{r.manager_name ?? 'Not set — choose one in Governance → Leads'}</dd><dt>Assigned</dt><dd>{r.assignee_name ?? r.agent_name ?? r.contractor ?? 'Not yet'}</dd><dt>Due</dt><dd>{fmtDate(r.due_on)}</dd>{r.completed_on && <><dt>Work completed</dt><dd>{fmtDate(r.completed_on)}</dd></>}{r.verified_at && <><dt>Verified and closed</dt><dd>{fmtDateTime(r.verified_at)}</dd><dt>Time to fix</dt><dd>{daysBetween(r.created_at, r.completed_on)} · {r.completed_on <= r.due_on ? <Status s="verified" text="On time" /> : <Status s="action" text="Late" />}</dd></>}</dl>
          <h3 style={{ marginTop: 16 }}>What happens next</h3>
          <div className="row">
            {can.manage && r.status !== 'closed' && <Button variant="secondary" onClick={() => setAssign({ assignee_id: r.assignee_id ?? '', agent_id: r.agent_id ?? '', contractor: r.contractor ?? '', due_on: r.due_on ?? '', urgency: r.urgency })}>Assign or change</Button>}
            {can.next.map((s: string) => <Button key={s} variant={s === 'closed' ? 'go' : 'primary'} onClick={() => setMove(s)}>{s === 'closed' ? 'Verify and close' : s === 'in_progress' && r.status === 'awaiting_verification' ? 'Send back — not finished' : `Move to ${REPAIR_STATUS[s][1]}`}</Button>)}
          </div>
        </section>
        <section className="card" aria-labelledby="ru-h"><h2 id="ru-h">Updates</h2>
          {updates.length === 0 ? <p className="muted">No updates.</p> : <ul className="list">{updates.map((u: any) => <li key={u.id}><div><strong>{u.author_name}</strong> <span className="muted small">{fmtDateTime(u.created_at)}</span>{u.status_to && <span className="small"> · {REPAIR_STATUS[u.status_from]?.[1]} → {REPAIR_STATUS[u.status_to][1]}</span>}<p style={{ margin: '4px 0 0' }}>{u.body}</p></div></li>)}</ul>}
          {files.some((f: any) => f.is_image) && <><h3>Photos</h3><PhotoGrid photos={files.filter((f: any) => f.is_image)} caption={(f) => fmtDateTime(f.uploaded_at)} /></>}
          {files.some((f: any) => !f.is_image) && <p>Documents: {files.filter((f: any) => !f.is_image).map((f: any) => <button key={f.id} type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button>)}</p>}
          {(can.work || can.photos) && r.status !== 'closed' && <FilePicker label="Add photos" hint="Before and after photos help the repairs manager verify the work." accept="image/jpeg,image/png,image/webp" multiple instant busy={photoProgress !== null} progress={photoProgress} onChange={(fs) => addPhotos.run(fs)} />}
          {can.work && r.status !== 'closed' && <><Field label="Add an update"><textarea name="body" value={upd.body} onChange={(e) => setUpd({ ...upd, body: e.target.value })} /></Field>
            <FilePicker key={pickerKey} label="Photo or document" accept="image/*,application/pdf" onChange={(fs) => setUpd({ ...upd, file: fs[0] ?? null })} />
            <Button variant="secondary" busy={addUpd.busy} disabled={upd.body.trim().length < 2} onClick={() => addUpd.run()}>Add update</Button></>}
        </section>
      </div>
      <Dialog open={!!move} onClose={() => setMove(null)} title={move === 'closed' ? 'Verify and close' : `Move to ${move ? REPAIR_STATUS[move][1] : ''}`} variant="modal" footer={<Button busy={status.busy} disabled={note.trim().length < 2} onClick={() => status.run()}>Confirm</Button>}>
        {move === 'closed' && <p>Only close it when you have checked the work is done. Someone other than the person who did the work must verify it.</p>}
        <ErrorSummary error={status.error} />
        <Field label={move === 'closed' ? 'What did you check?' : 'Note'}><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={!!assign} onClose={() => setAssign(null)} title="Assign repair" footer={<Button busy={saveAssign.busy} onClick={() => saveAssign.run()}>Save</Button>}>
        {assign && <><ErrorSummary error={saveAssign.error} />
          <Field label="Urgency"><select name="urgency" value={assign.urgency} onChange={(e) => setAssign({ ...assign, urgency: e.target.value })}>{Object.entries(URGENCY).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Staff member" optional><select name="assignee_id" value={assign.assignee_id} onChange={(e) => setAssign({ ...assign, assignee_id: e.target.value })}><option value="">None</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Managing agent" optional><select name="agent_id" value={assign.agent_id} onChange={(e) => setAssign({ ...assign, agent_id: e.target.value })}><option value="">None</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Contractor" optional><input name="contractor" value={assign.contractor} onChange={(e) => setAssign({ ...assign, contractor: e.target.value })} /></Field>
          <Field label="Deadline" optional><input name="due_on" type="date" value={assign.due_on} onChange={(e) => setAssign({ ...assign, due_on: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

export function SafetyTable({ rows, onCheck, canAdd }: { rows: any[]; onCheck?: (r: any) => void; canAdd?: boolean }) {
  if (!rows.length) return <Empty>No safety checks scheduled{canAdd ? '. Add the checks each property needs.' : '.'}</Empty>;
  return (
    <div className="table-wrap"><table><thead><tr><th>Check</th><th>Property</th><th>Responsible</th><th>Last done</th><th>Next due</th><th>Status</th>{onCheck && <th><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}<div className="muted small">Every {r.interval_days} day{r.interval_days === 1 ? '' : 's'}</div></td><td>{r.property_name} <span className="badge co">{r.company_code}</span></td><td>{r.responsible}</td><td>{r.last_done ? `${fmtDate(r.last_done)} (${label(r.last_result)})` : '—'}</td><td>{fmtDate(r.next_due)}</td><td><Status s={SAFETY_STATE[r.state][0]} text={SAFETY_STATE[r.state][1]} /></td>
        {onCheck && <td><Button variant="secondary" onClick={() => onCheck(r)}>Record check<span className="sr-only"> for {r.name} at {r.property_name}</span></Button></td>}</tr>)}</tbody></table></div>
  );
}
export function RecordCheck({ req, onClose, onSaved }: { req: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ done_on: londonToday(), done_by_text: '', result: 'pass', findings: '', file: null as File | null });
  const save = useSubmit(async () => {
    const r = await upload(`/safety/requirements/${req.id}/checks`, f.file, f.file?.name ?? '', undefined, { done_on: f.done_on, done_by_text: f.done_by_text, result: f.result, ...(f.findings ? { findings: f.findings } : {}) });
    toast(r.action ? 'Check recorded. Because it failed, an improvement action was opened.' : 'Check recorded.'); onSaved();
  });
  return (
    <Dialog open onClose={onClose} title={`Record: ${req.name}`} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Date of check" error={save.error?.fields.done_on}><input name="done_on" type="date" max={londonToday()} value={f.done_on} onChange={(e) => setF({ ...f, done_on: e.target.value })} /></Field>
      <Field label="Done by" optional><input name="done_by_text" value={f.done_by_text} onChange={(e) => setF({ ...f, done_by_text: e.target.value })} /></Field>
      <Field label="Result"><select name="result" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="pass">Pass</option><option value="advisory">Pass with advice</option><option value="fail">Fail</option></select></Field>
      <Field label="Findings" optional={f.result === 'pass'} hint="Property details only." error={save.error?.fields.findings}><textarea name="findings" value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} /></Field>
      <FilePicker label="Certificate or photo" accept="application/pdf,image/*" onChange={(fs) => setF({ ...f, file: fs[0] ?? null })} />
    </Dialog>
  );
}

function Safety({ property }: { property: string | null }) {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/safety${hub.q({ property })}`);
  const props = useApi<any[]>(`/properties${hub.q()}`);
  const [check, setCheck] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const add = useSubmit(async () => { await post('/safety/requirements', { ...f, interval_days: Number(f.interval_days), notes: f.notes || null }); setF(null); toast('Check added to the schedule.'); d.reload(); });
  const manage = hub.can('safety.manage');
  return (
    <>
      <p className="muted">Each property has its own schedule. A failed check opens an improvement action that must be verified before it can close.</p>
      {manage && <p><Button onClick={() => setF({ property_id: property ?? '', name: '', interval_days: 365, responsible: '', notes: '' })}>Add a scheduled check</Button></p>}
      {d.loading && !d.data ? <Skeleton /> : <SafetyTable rows={d.data ?? []} onCheck={manage ? setCheck : undefined} canAdd={manage} />}
      {check && <RecordCheck req={check} onClose={() => setCheck(null)} onSaved={() => { setCheck(null); d.reload(); }} />}
      <Dialog open={!!f} onClose={() => setF(null)} title="Add a scheduled check" footer={<Button busy={add.busy} onClick={() => add.run()}>Add</Button>}>
        {f && <><ErrorSummary error={add.error} />
          <Field label="Property"><select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">Choose…</option>{props.data?.filter((p) => hub.can('safety.manage', p.company_id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>
          <Field label="Check" hint="For example: Gas safety inspection, Fire alarm test, Electrical installation report." error={add.error?.fields.name}><input name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="How often (days)" hint="7 = weekly, 30 = monthly, 365 = yearly. Use the interval your obligations require."><input name="interval_days" type="number" min={1} max={3660} value={f.interval_days} onChange={(e) => setF({ ...f, interval_days: e.target.value })} /></Field>
          <Field label="Responsible" error={add.error?.fields.responsible}><input name="responsible" value={f.responsible} onChange={(e) => setF({ ...f, responsible: e.target.value })} /></Field>
          <Field label="Notes" optional><textarea name="notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

function Agents() {
  const hub = useHub();
  const d = useApi<any[]>(`/agents${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const create = useSubmit(async () => { await post('/agents', f); setF(null); d.reload(); });
  return (
    <>
      {hub.can('agents.manage') && <p><Button onClick={() => setF({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies.find((c) => c.perms.includes('agents.manage'))?.id, name: '' })}>Add a managing agent</Button></p>}
      {(d.data ?? []).length === 0 ? <Empty>No managing agents.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Agent</th><th>Company</th><th className="num">Properties</th><th>Last review</th><th className="num">Open actions</th></tr></thead>
          <tbody>{d.data!.map((a) => <tr key={a.id}><td><Link to={`/estates/agents/${a.id}`}>{a.name}</Link></td><td><CompanyBadge code={a.company_code} name={a.company_name} /></td><td className="num">{a.properties}</td><td>{a.last_review ? `${fmtDate(a.last_review)} · average ${a.last_score} of 5` : <Status s="evidence_missing" text="Not reviewed" />}</td><td className="num">{a.open_actions}</td></tr>)}</tbody></table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Add a managing agent" variant="modal" footer={<Button busy={create.busy} onClick={() => create.run()}>Add</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{hub.me.companies.filter((c) => c.perms.includes('agents.manage')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Name" error={create.error?.fields.name}><input name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

export function AgentPage() {
  const { id } = useParams();
  const d = useApi<any>(`/agents/${id}`);
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const [prop, setProp] = useState('');
  const [user, setUser] = useState<any>(null);
  const [review, setReview] = useState<any>(null);
  const [action, setAction] = useState(false);
  const props = useApi<any[]>(d.data ? `/properties?company=${d.data.agent.company_id}` : null);
  const save = useSubmit(async () => { const { id: _i, company_id: _c, company_code: _cc, company_name: _cn, created_at: _ca, ...b } = edit; await patch(`/agents/${id}`, b); setEdit(null); toast('Saved.'); d.reload(); });
  const link = useSubmit(async (property_id: string, remove = false) => { await post(`/agents/${id}/properties`, { property_id, remove }); setProp(''); d.reload(); });
  const addUser = useSubmit(async () => { await post(`/agents/${id}/users`, { ...user, expires_at: user.expires_at ? new Date(`${user.expires_at}T23:59:00`).toISOString() : null }); setUser(null); toast('Portal access given. They will be invited by email if sign-in is set up.'); d.reload(); });
  const removeUser = useSubmit(async (email: string, full_name: string) => { await post(`/agents/${id}/users`, { email, full_name, remove: true }); d.reload(); });
  const saveReview = useSubmit(async () => { await post(`/agents/${id}/reviews`, { ...review, scores: review.scores.map((s: any) => ({ ...s, score: Number(s.score) })) }); setReview(null); toast('Review saved.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { agent: a, can, properties, users, reviews, actions, repairs } = d.data;
  const fields: [string, string][] = [['contact', 'Contact'], ['responsibilities', 'Responsibilities'], ['required_evidence', 'Evidence they must provide'], ['escalation', 'Escalation route']];
  return (
    <>
      <PageHead title={a.name} crumbs={[['Managing agents', '/estates?tab=agents'], [a.name]]} intro={<><CompanyBadge code={a.company_code} name={a.company_name} /> Contract {fmtDate(a.contract_start)} – {fmtDate(a.contract_end)}</>} actions={can.manage && <Button variant="secondary" onClick={() => setEdit({ ...a })}>Edit</Button>} />
      <ErrorSummary error={link.error ?? removeUser.error} />
      <div className="grid-2">
        <section className="card" aria-labelledby="ag-h"><h2 id="ag-h">Agreement</h2><dl className="facts">{fields.flatMap(([k, t]) => [<dt key={`${k}t`}>{t}</dt>, <dd key={k}>{a[k] ?? '—'}</dd>])}</dl></section>
        <section className="card" aria-labelledby="ap-h"><h2 id="ap-h">Properties</h2>
          {properties.length === 0 ? <p className="muted">None linked.</p> : <ul className="list">{properties.map((p: any) => <li key={p.id}><Link to={`/properties/${p.id}`}>{p.name} ({p.ref})</Link>{can.manage && <Button variant="ghost" onClick={() => link.run(p.id, true)}>Unlink</Button>}</li>)}</ul>}
          {can.manage && <div className="row"><select aria-label="Property to link" value={prop} onChange={(e) => setProp(e.target.value)} style={{ flex: 1 }}><option value="">Link a property…</option>{props.data?.filter((p) => !properties.some((x: any) => x.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select><Button variant="secondary" disabled={!prop} onClick={() => link.run(prop)}>Link</Button></div>}
        </section>
        <section className="card" aria-labelledby="sc-h"><div className="row between"><h2 id="sc-h">Scorecards</h2>{can.manage && <Button variant="secondary" onClick={() => setReview({ period_start: '', period_end: londonToday(), summary: '', scores: [{ criterion: 'Safety certificates on time', score: 3, evidence: '' }, { criterion: 'Repairs completed by deadline', score: 3, evidence: '' }, { criterion: 'Communication and escalation', score: 3, evidence: '' }] })}>New review</Button>}</div>
          {reviews.length === 0 ? <Empty>No reviews yet.</Empty> : reviews.map((r: any) => <details key={r.id} className="card"><summary>{fmtDate(r.period_start)} – {fmtDate(r.period_end)} · {r.reviewer_name}</summary><table><thead><tr><th>Criterion</th><th className="num">Score (1–5)</th><th>Evidence</th></tr></thead><tbody>{r.scores.map((s: any, i: number) => <tr key={i}><td>{s.criterion}</td><td className="num">{s.score}</td><td>{s.evidence}</td></tr>)}</tbody></table>{r.summary && <p>{r.summary}</p>}</details>)}
        </section>
        <section className="card" aria-labelledby="cp-h"><div className="row between"><h2 id="cp-h">Corrective plan</h2>{can.manage && <Button variant="secondary" onClick={() => setAction(true)}>Add an action</Button>}</div>
          {actions.length === 0 ? <p className="muted">No actions.</p> : <ul className="list">{actions.map((x: any) => <li key={x.id}><Link to={`/governance/actions/${x.id}`}>{x.action}</Link><span className="small">{label(x.status)} · due {fmtDate(x.due_on)}</span></li>)}</ul>}
          <h3 style={{ marginTop: 16 }}>Open repairs assigned</h3>
          {repairs.length === 0 ? <p className="muted">None.</p> : <ul className="list">{repairs.map((r: any) => <li key={r.id}><Link to={`/estates/repairs/${r.id}`}>{r.title}</Link><span className="small">{r.property_name} · due {fmtDate(r.due_on)}</span></li>)}</ul>}
        </section>
        <section className="card" aria-labelledby="au-h"><div className="row between"><h2 id="au-h">Portal users</h2>{can.manage && <Button variant="secondary" onClick={() => setUser({ email: '', full_name: '', expires_at: '' })}>Give portal access</Button>}</div>
          <p className="small muted">Agent users see only this agent’s properties, repairs and safety schedule — nothing about staff.</p>
          {users.length === 0 ? <p className="muted">None.</p> : <ul className="list">{users.map((u: any) => <li key={u.person_id}><span>{u.name}<br /><span className="muted small">{u.email}{u.expires_at && ` · until ${fmtDate(u.expires_at)}`}</span></span>{can.manage && <Button variant="ghost" onClick={() => removeUser.run(u.email, u.name)}>Remove access</Button>}</li>)}</ul>}
        </section>
      </div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="Edit agent" footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        {edit && <><ErrorSummary error={save.error} /><Field label="Name"><input name="name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Contract start" optional><input name="contract_start" type="date" value={edit.contract_start ?? ''} onChange={(e) => setEdit({ ...edit, contract_start: e.target.value || null })} /></Field><Field label="Contract end" optional><input name="contract_end" type="date" value={edit.contract_end ?? ''} onChange={(e) => setEdit({ ...edit, contract_end: e.target.value || null })} /></Field></div>
          {fields.map(([k, t]) => <Field key={k} label={t} optional><textarea name={k} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value || null })} /></Field>)}</>}
      </Dialog>
      <Dialog open={!!user} onClose={() => setUser(null)} title="Give portal access" variant="modal" footer={<Button busy={addUser.busy} onClick={() => addUser.run()}>Give access</Button>}>
        {user && <><ErrorSummary error={addUser.error} /><Field label="Full name"><input name="full_name" value={user.full_name} onChange={(e) => setUser({ ...user, full_name: e.target.value })} /></Field><Field label="Email" error={addUser.error?.fields.email}><input name="email" type="email" value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} /></Field><Field label="Access ends" optional><input name="expires_at" type="date" value={user.expires_at} onChange={(e) => setUser({ ...user, expires_at: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={!!review} onClose={() => setReview(null)} title="Agent review" footer={<Button busy={saveReview.busy} onClick={() => saveReview.run()}>Save review</Button>}>
        {review && <><ErrorSummary error={saveReview.error} />
          <div className="form-grid"><Field label="From"><input name="period_start" type="date" value={review.period_start} onChange={(e) => setReview({ ...review, period_start: e.target.value })} /></Field><Field label="To"><input name="period_end" type="date" value={review.period_end} onChange={(e) => setReview({ ...review, period_end: e.target.value })} /></Field></div>
          {review.scores.map((s: any, i: number) => <fieldset key={i} className="card"><legend style={{ fontWeight: 600 }}>{s.criterion}</legend>
            <Field label="Score (1 = poor, 5 = excellent)"><input name={`s-${i}`} type="number" min={1} max={5} value={s.score} onChange={(e) => setReview({ ...review, scores: review.scores.map((x: any, j: number) => (j === i ? { ...x, score: e.target.value } : x)) })} style={{ maxWidth: 100 }} /></Field>
            <Field label="Evidence for this score"><input name={`e-${i}`} value={s.evidence} onChange={(e) => setReview({ ...review, scores: review.scores.map((x: any, j: number) => (j === i ? { ...x, evidence: e.target.value } : x)) })} /></Field></fieldset>)}
          <Field label="Summary" optional><textarea name="summary" value={review.summary} onChange={(e) => setReview({ ...review, summary: e.target.value })} /></Field></>}
      </Dialog>
      {action && <NewAction source={{ company_id: a.company_id, source_type: 'agent', source_id: a.id }} onClose={() => setAction(false)} onSaved={() => { setAction(false); d.reload(); }} />}
    </>
  );
}

// The only page an agent user can use.
export function AgentPortal() {
  const d = useApi<any>('/agent-portal');
  const [reporting, setReporting] = useState(false);
  const [check, setCheck] = useState<any>(null);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={6} />;
  return (
    <>
      <PageHead title="Agent portal" intro={`For ${d.data.agents.map((a: any) => `${a.name} (${a.company_name})`).join(', ')}. You can see only the properties you manage for us.`} actions={<Button onClick={() => setReporting(true)}>Report a repair</Button>} />
      {d.data.agents.map((a: any) => <div key={a.id} className="notice"><strong>Your responsibilities:</strong> {a.responsibilities ?? '—'}<br /><strong>Evidence to provide:</strong> {a.required_evidence ?? '—'}<br /><strong>Escalation:</strong> {a.escalation ?? '—'}</div>)}
      <section className="card" aria-labelledby="pr-h"><h2 id="pr-h">Open repairs</h2>
        {d.data.repairs.length === 0 ? <Empty>No open repairs.</Empty> : <ul className="list">{d.data.repairs.map((r: any) => <li key={r.id}><span><Link to={`/estates/repairs/${r.id}`}>{r.title}</Link><br /><span className="small muted">{r.property_name} · due {fmtDate(r.due_on)}{r.assigned_to_you && ' · assigned to you'}</span></span><Status s={REPAIR_STATUS[r.status][0]} text={REPAIR_STATUS[r.status][1]} /></li>)}</ul>}
      </section>
      <section className="card" aria-labelledby="ps-h"><h2 id="ps-h">Safety schedule</h2><SafetyTable rows={d.data.safety} onCheck={setCheck} /></section>
      <section className="card" aria-labelledby="pp-h"><h2 id="pp-h">Properties</h2><ul className="list">{d.data.properties.map((p: any) => <li key={p.id}><span>{p.name} ({p.ref})<br /><span className="small muted">{p.address_line1}, {p.postcode}</span></span><span className="badge co">{p.company_code}</span></li>)}</ul></section>
      {reporting && <ReportRepair properties={d.data.properties} onClose={() => setReporting(false)} onSaved={() => { setReporting(false); d.reload(); }} />}
      {check && <RecordCheck req={check} onClose={() => setCheck(null)} onSaved={() => { setCheck(null); d.reload(); }} />}
    </>
  );
}
