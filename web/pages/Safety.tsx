// Property safety for every property: overview cards, inspections, the property risk register and safety actions.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Building2, ClipboardCheck, ClipboardList, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react';
import { download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';
import { uploadPhotos } from './Visits.tsx';
import { NewAction, PersonSelect } from './Governance.tsx';
import { Photo } from './Properties.tsx';

const KIND: Record<string, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', communal: 'Communal areas', fire: 'Fire safety', damp: 'Damp & mould', room: 'Room', health_safety: 'Health & safety' };
const SEVERITY: Record<string, [string, string]> = { low: ['normal', 'Low'], medium: ['review', 'Medium'], high: ['high', 'High'], critical: ['urgent', 'Critical'] };
const ACTION_STATUS: Record<string, [string, string]> = { open: ['info', 'Open'], evidence_submitted: ['review', 'Evidence submitted'], verified: ['verified', 'Verified'], closed: ['completed', 'Closed'], reopened: ['action', 'Reopened'] };
export const riskBand = (s: number): [string, string] => (s >= 15 ? ['action', `High · ${s}`] : s >= 8 ? ['review', `Medium · ${s}`] : ['verified', `Low · ${s}`]);
const SOURCE: Record<string, string> = { inspection: 'Inspection', risk: 'Risk', safety_check: 'Scheduled check' };

function Tile({ icon: I, value, label: text, sub, tone }: { icon: LucideIcon; value: React.ReactNode; label: string; sub?: string; tone?: string }) {
  return <li><div className={`rp-kpi ${tone ?? ''}`} style={{ cursor: 'default' }}><span className="rp-kpi-icon"><I size={20} aria-hidden="true" /></span><span className="rp-kpi-value">{value}</span><span className="rp-kpi-label">{text}</span>{sub && <span className="rp-kpi-sub">{sub}</span>}</div></li>;
}

// ── Overview ──
export function SafetyOverview() {
  const hub = useHub();
  const d = useApi<any[]>(`/safety/overview${hub.q()}`);
  const [inspect, setInspect] = useState(false);
  const [risk, setRisk] = useState(false);
  const [text, setText] = useState('');
  const rows = (d.data ?? []).filter((p) => !text || `${p.name} ${p.ref} ${p.address_line1} ${p.postcode} ${p.agent}`.toLowerCase().includes(text.toLowerCase()));
  const sum = (k: string) => (d.data ?? []).reduce((n, p) => n + (p[k] ?? 0), 0);
  const today = londonToday();
  return (
    <div className="rp">
      <div className="rp-head"><div><h2>Property safety</h2><p className="muted small">Every property. Figures come only from inspections, risks and actions recorded here.</p></div>
        <div className="rp-head-actions">{hub.can('safety.manage') && <Button variant="secondary" onClick={() => setRisk(true)}>Add a risk</Button>}<Button onClick={() => setInspect(true)}><ClipboardCheck size={18} aria-hidden="true" />Start inspection</Button></div></div>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton lines={4} /> : <>
        <ul className="rp-kpis" aria-label="Safety figures">
          <Tile icon={Building2} value={d.data.length} label="Properties" sub={`${d.data.filter((p) => !p.last_inspection).length} never inspected`} />
          <Tile icon={ClipboardList} value={d.data.filter((p) => p.failed_30).length} label="Failed inspections" sub="properties, last 30 days" tone={d.data.some((p) => p.failed_30) ? 'warn' : ''} />
          <Tile icon={ShieldAlert} value={sum('open_risks')} label="Open risks" sub={`${sum('high_risks')} scoring 15 or more`} tone={sum('high_risks') ? 'bad' : ''} />
          <Tile icon={AlertTriangle} value={sum('open_actions')} label="Outstanding actions" sub="from inspections and risks" />
          <Tile icon={ShieldCheck} value={d.data.filter((p) => p.next_due && p.next_due < today).length} label="Scheduled checks overdue" sub="properties" tone={d.data.some((p) => p.next_due && p.next_due < today) ? 'bad' : ''} />
        </ul>
        <div className="rp-toolbar"><label className="rp-search"><input type="search" placeholder="Search properties, postcodes, agents…" aria-label="Search properties" value={text} onChange={(e) => setText(e.target.value)} /></label></div>
        {rows.length === 0 ? <Empty>No properties match.</Empty> : <ul className="grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((p) => <li key={p.id} className="card prop-card">
            <Photo id={p.id} has={p.has_photo} name={p.name} />
            <div className="prop-body">
              <div className="row between"><h3 style={{ margin: 0 }}>{p.name}</h3><span className="badge co">{p.company_code}</span></div>
              <div className="muted small">{p.ref} · {p.address_line1}, {p.postcode}<br />{p.agent}</div>
              <dl className="sf-facts">
                <dt>Last inspection</dt><dd>{p.last_inspection ? fmtDate(p.last_inspection) : <span className="muted">None yet</span>}{p.failed_30 > 0 && <> <Status s="action" text="Failed" /></>}</dd>
                <dt>Open risks</dt><dd>{p.open_risks}{p.high_risks > 0 && <> <Status s="action" text={`${p.high_risks} high`} /></>}</dd>
                <dt>Next check due</dt><dd>{p.next_due ? <>{fmtDate(p.next_due)}{p.next_due < today && <> <Status s="action" text="Overdue" /></>}</> : <span className="muted">None scheduled</span>}</dd>
                {p.compliance_score !== undefined && <><dt>Compliance</dt><dd>{p.compliance_score === null ? '—' : `${p.compliance_score}%`}</dd></>}
              </dl>
              <Link className="btn secondary" to={`/properties/${p.id}?tab=safety`}>View property safety</Link>
            </div>
          </li>)}</ul>}
      </>}
      {inspect && <InspectionDialog onClose={() => setInspect(false)} onSaved={() => { setInspect(false); d.reload(); }} />}
      {risk && <RiskDialog onClose={() => setRisk(false)} onSaved={() => { setRisk(false); d.reload(); }} />}
    </div>
  );
}

// ── Recording an inspection (phone-first) ──
type Answer = { result: '' | 'pass' | 'fail' | 'na'; comment: string; severity: string; follow_up: string; owner_id: string; photos: File[] };
export function InspectionDialog({ propertyId, onClose, onSaved }: { propertyId?: string; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const props = useApi<any[]>(propertyId ? null : `/properties${hub.q()}`);
  const [pid, setPid] = useState(propertyId ?? '');
  const prop = useApi<any>(pid ? `/properties/${pid}` : null);
  const company = prop.data?.property.company_id;
  const templates = useApi<any[]>(company ? `/inspection-templates?company=${company}` : null);
  const people = useApi<any[]>(company ? `/people?company=${company}` : null);
  const [tid, setTid] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const t = templates.data?.find((x) => x.id === tid);
  const set = (k: string, a: Partial<Answer>) => setAnswers({ ...answers, [k]: { ...(answers[k] ?? { result: '', comment: '', severity: '', follow_up: 'action', owner_id: '', photos: [] }), ...a } });
  const missing = t ? t.items.filter((q: any) => !answers[q.key]?.result).length : 0;
  const save = useSubmit(async () => {
    const r = await post('/inspections', { property_id: pid, template_id: tid, location: location || null, notes: notes || null,
      items: t.items.map((q: any) => { const a = answers[q.key]; return { key: q.key, result: a?.result || null, ...(a?.result === 'fail' ? { comment: a.comment, severity: a.severity || null, follow_up: a.follow_up || null, owner_id: a.owner_id || null } : a?.comment ? { comment: a.comment } : {}) }; }) });
    let failed = 0;
    for (const it of r.items) { const ph = answers[it.key]?.photos ?? []; if (ph.length) failed += await uploadPhotos(`/inspection-items/${it.id}/photos`, ph, setProgress); }
    toast(`Inspection saved${r.failed ? `: ${r.failed} failed item${r.failed === 1 ? '' : 's'} sent for action` : ''}.${failed ? ` ${failed} photo${failed === 1 ? '' : 's'} did not upload.` : ''}`);
    onSaved();
  });
  const fe = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title="Inspection" footer={<Button busy={save.busy || progress !== null} disabled={!t || missing > 0} onClick={() => save.run()}>{t && missing ? `${missing} to answer` : 'Save inspection'}</Button>}>
      <ErrorSummary error={save.error} />
      {!propertyId && <Field label="Property"><select value={pid} onChange={(e) => { setPid(e.target.value); setTid(''); setAnswers({}); }}><option value="">Choose…</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>}
      {pid && <div className="form-grid">
        <Field label="Inspection"><select value={tid} onChange={(e) => { setTid(e.target.value); setAnswers({}); }}><option value="">Choose…</option>{templates.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Room or area" optional hint="A room label, never a name."><input value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
      </div>}
      {t && <ol className="ins-list">{t.items.map((q: any) => { const a = answers[q.key]; return (
        <li key={q.key} className={`ins-item ${a?.result ?? ''}`}>
          <fieldset><legend>{q.text}</legend>
            <div className="ins-seg">{(['pass', 'fail', 'na'] as const).map((r) => <label key={r} className={`ins-opt r-${r}`}><input type="radio" name={q.key} checked={a?.result === r} onChange={() => set(q.key, { result: r })} /><span>{r === 'na' ? 'N/A' : label(r)}</span></label>)}</div>
            {a?.result === 'fail' && <div className="ins-fail">
              <Field label="What is wrong?" error={fe[`${q.key}.comment`]}><textarea value={a.comment} onChange={(e) => set(q.key, { comment: e.target.value })} /></Field>
              <div className="form-grid">
                <Field label="Severity" error={fe[`${q.key}.severity`]}><select value={a.severity} onChange={(e) => set(q.key, { severity: e.target.value })}><option value="">Choose…</option>{Object.entries(SEVERITY).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Follow-up"><select value={a.follow_up} onChange={(e) => set(q.key, { follow_up: e.target.value })}><option value="action">Safety action</option><option value="repair">Repair</option></select></Field>
                {a.follow_up === 'action' && <Field label="Owner" optional hint="Blank: the property manager."><select value={a.owner_id} onChange={(e) => set(q.key, { owner_id: e.target.value })}><option value="">Property manager</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>}
              </div>
              <FilePicker label="Photos" hint="Up to 6. Do not photograph residents." accept="image/jpeg,image/png,image/webp" multiple onChange={(fs) => set(q.key, { photos: fs })} />
            </div>}
          </fieldset>
        </li>); })}</ol>}
      {t && <Field label="Notes" optional><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>}
    </Dialog>
  );
}

export function InspectionsList({ propertyId }: { propertyId?: string }) {
  const hub = useHub();
  const d = useApi<any[]>(`/inspections${hub.q({ property: propertyId ?? null })}`);
  const [inspect, setInspect] = useState(false);
  return (
    <section className="card" aria-labelledby="in-h">
      <div className="row between"><h2 id="in-h">Inspections</h2><Button onClick={() => setInspect(true)}><ClipboardCheck size={18} aria-hidden="true" />Start inspection</Button></div>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton /> : d.data.length === 0 ? <Empty>No inspections recorded yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Inspection</th>{!propertyId && <th>Property</th>}<th>When</th><th>By</th><th>Result</th></tr></thead>
          <tbody>{d.data.map((i) => <tr key={i.id}><td><Link to={`/estates/inspections/${i.id}`}>{i.name}</Link>{i.location && <div className="muted small">{i.location}</div>}</td>{!propertyId && <td>{i.property_name} <span className="badge co">{i.company_code}</span></td>}
            <td>{fmtDateTime(i.inspected_at)}</td><td>{i.inspector_name}</td><td>{i.failed ? <Status s="action" text={`${i.failed} failed`} /> : <Status s="verified" text="All passed" />}<div className="muted small">{i.passed} pass · {i.not_applicable} N/A</div></td></tr>)}</tbody></table></div>
      )}
      {inspect && <InspectionDialog propertyId={propertyId} onClose={() => setInspect(false)} onSaved={() => { setInspect(false); d.reload(); }} />}
    </section>
  );
}

export function InspectionPage() {
  const { id } = useParams();
  const d = useApi<any>(`/inspections/${id}`);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { inspection: i, items } = d.data;
  return (
    <>
      <PageHead title={i.name} crumbs={[['Property safety', '/estates?tab=safety'], [i.name]]} intro={<><Link to={`/properties/${i.property_id}?tab=safety`}>{i.property_name}</Link> · {i.location ? `${i.location} · ` : ''}{fmtDateTime(i.inspected_at)} by {i.inspector_name}</>}
        actions={i.failed ? <Status s="action" text={`${i.failed} failed`} /> : <Status s="verified" text="All passed" />} />
      {i.notes && <p>{i.notes}</p>}
      <section className="card"><ul className="list">{items.map((it: any) => <li key={it.id} style={{ display: 'block' }}>
        <div className="row between"><strong>{it.question}</strong><Status s={it.result === 'pass' ? 'verified' : it.result === 'fail' ? 'action' : 'not_required'} text={it.result === 'na' ? 'N/A' : label(it.result)} /></div>
        {it.comment && <p style={{ margin: '4px 0' }}>{it.comment}</p>}
        {it.result === 'fail' && <div className="row small"><Status s={SEVERITY[it.severity][0]} text={`${SEVERITY[it.severity][1]} severity`} />
          {it.action_id && <Link to={`/governance/actions/${it.action_id}`}>Safety action · {ACTION_STATUS[it.action_status]?.[1] ?? label(it.action_status)}{it.owner_name ? ` · ${it.owner_name}` : ''}</Link>}
          {it.repair_id && <Link to={`/estates/repairs/${it.repair_id}`}>Repair · {label(it.repair_status)}</Link>}</div>}
        {it.photos.length > 0 && <PhotoGrid photos={it.photos} caption={(f) => fmtDateTime(f.uploaded_at)} />}
      </li>)}</ul></section>
    </>
  );
}

// ── Risk register ──
const blankRisk = (propertyId = '') => ({ property_id: propertyId, location: '', category: '', title: '', description: '', likelihood: 3, impact: 3, controls: '', owner_id: '', target_on: '', review_on: '' });
export function RiskDialog({ propertyId, onClose, onSaved }: { propertyId?: string; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const props = useApi<any[]>(propertyId ? null : `/properties${hub.q()}`);
  const prop = useApi<any>(propertyId ? `/properties/${propertyId}` : null);
  const [f, setF] = useState<any>(blankRisk(propertyId));
  const company = propertyId ? prop.data?.property.company_id : props.data?.find((p) => p.id === f.property_id)?.company_id;
  const save = useSubmit(async () => {
    const r = await post('/property-risks', { ...f, likelihood: Number(f.likelihood), impact: Number(f.impact), ...Object.fromEntries(['location', 'category', 'description', 'controls', 'owner_id', 'target_on', 'review_on'].map((k) => [k, f[k] || null])) });
    toast(`Risk ${r.ref} added.`); onSaved();
  });
  const score = Number(f.likelihood) * Number(f.impact);
  return (
    <Dialog open onClose={onClose} title="Add a risk" footer={<Button busy={save.busy} onClick={() => save.run()}>Add risk</Button>}>
      <ErrorSummary error={save.error} />
      {!propertyId && <Field label="Property"><select value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">Choose…</option>{props.data?.filter((p) => hub.can('safety.manage', p.company_id)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>}
      <Field label="Hazard" error={save.error?.fields.title}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="Room or area" optional><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Category" optional><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Choose…</option>{['fire', 'electrical', 'gas', 'water', 'damp', 'structural', 'slips_trips', 'security', 'health', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
      </div>
      <Field label="Details" optional hint="Property details only."><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <RatingFields f={f} setF={setF} score={score} />
      <Field label="Controls in place" optional><textarea value={f.controls} onChange={(e) => setF({ ...f, controls: e.target.value })} /></Field>
      {company && <PersonSelect companyId={company} label="Owner" optional value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} />}
      <div className="form-grid">
        <Field label="Target date" optional><input type="date" value={f.target_on} onChange={(e) => setF({ ...f, target_on: e.target.value })} /></Field>
        <Field label="Review date" optional><input type="date" value={f.review_on} onChange={(e) => setF({ ...f, review_on: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
function RatingFields({ f, setF, score }: { f: any; setF: (f: any) => void; score: number }) {
  return <div className="form-grid">
    <Field label="Likelihood (1–5)"><select value={f.likelihood} onChange={(e) => setF({ ...f, likelihood: e.target.value })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'][n - 1]}</option>)}</select></Field>
    <Field label="Impact (1–5)"><select value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {['Negligible', 'Minor', 'Moderate', 'Major', 'Severe'][n - 1]}</option>)}</select></Field>
    <div><strong>Rating</strong><div style={{ paddingTop: 8 }}><Status s={riskBand(score)[0]} text={riskBand(score)[1]} /></div></div>
  </div>;
}

export function RisksAndActions({ propertyId }: { propertyId?: string }) {
  const hub = useHub();
  const risks = useApi<any[]>(`/property-risks${hub.q({ property: propertyId ?? null })}`);
  const actions = useApi<any[]>(`/safety/actions${hub.q({ property: propertyId ?? null })}`);
  const [add, setAdd] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const rows = (risks.data ?? []).filter((r) => showClosed || r.status === 'open');
  const open = (actions.data ?? []).filter((x) => !['verified', 'closed'].includes(x.status));
  return (
    <>
      <section className="card" aria-labelledby="rk-h">
        <div className="row between"><h2 id="rk-h">Risk register</h2><span className="row"><label className="check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed</label>{hub.can('safety.manage') && <Button onClick={() => setAdd(true)}>Add a risk</Button>}</span></div>
        {risks.error ? <LoadError error={risks.error} retry={risks.reload} /> : !risks.data ? <Skeleton /> : rows.length === 0 ? <Empty>No open risks recorded.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Ref</th><th>Hazard</th>{!propertyId && <th>Property</th>}<th>Rating</th><th>Owner</th><th>Review</th><th>Actions</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.ref}</td><td><Link to={`/estates/risks/${r.id}`}>{r.title}</Link>{r.location && <div className="muted small">{r.location}</div>}</td>{!propertyId && <td>{r.property_name}</td>}
              <td><Status s={riskBand(r.score)[0]} text={riskBand(r.score)[1]} /></td><td>{r.owner_name ?? '—'}</td><td>{fmtDate(r.review_on)}{r.review_overdue && <div><Status s="action" text="Overdue" /></div>}</td>
              <td>{r.open_actions ? `${r.open_actions} not verified` : '—'}</td><td><Status s={r.status === 'open' ? 'info' : 'completed'} text={label(r.status)} /></td></tr>)}</tbody></table></div>
        )}
      </section>
      <section className="card" aria-labelledby="sa-h">
        <h2 id="sa-h">Safety actions{open.length ? ` (${open.length} outstanding)` : ''}</h2>
        {actions.error ? <LoadError error={actions.error} retry={actions.reload} /> : !actions.data ? <Skeleton /> : actions.data.length === 0 ? <Empty>No safety actions.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Action</th>{!propertyId && <th>Property</th>}<th>From</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>{actions.data.map((x) => <tr key={x.id}><td><Link to={`/governance/actions/${x.id}`}>{x.action}</Link>{x.significance === 'significant' && <div className="muted small">Significant</div>}</td>{!propertyId && <td>{x.property_name}</td>}
              <td>{SOURCE[x.source_type] ?? label(x.source_type)}</td><td>{x.owner_name ?? '—'}</td><td>{fmtDate(x.due_on)}{x.overdue && <div><Status s="action" text="Overdue" /></div>}</td>
              <td><Status s={ACTION_STATUS[x.status]?.[0] ?? 'info'} text={ACTION_STATUS[x.status]?.[1] ?? label(x.status)} /></td></tr>)}</tbody></table></div>
        )}
        <p className="small muted">An action is done once someone other than its owner verifies the evidence. A risk stays open until all its actions are verified.</p>
      </section>
      {add && <RiskDialog propertyId={propertyId} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); risks.reload(); }} />}
    </>
  );
}

export function RiskPage() {
  const { id } = useParams();
  const d = useApi<any>(`/property-risks/${id}`);
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const [close, setClose] = useState('');
  const [closing, setClosing] = useState(false);
  const [act, setAct] = useState(false);
  const save = useSubmit(async () => {
    const r = d.data.risk;
    const b: any = Object.fromEntries(Object.entries(edit).filter(([k, v]) => k !== 'assessment_note' && String(v ?? '') !== String(r[k] ?? '')).map(([k, v]) => [k, ['likelihood', 'impact'].includes(k) ? Number(v) : v === '' ? null : v]));
    if ('likelihood' in b || 'impact' in b) b.assessment_note = edit.assessment_note;
    if (Object.keys(b).length) await patch(`/property-risks/${id}`, b);
    setEdit(null); toast('Saved.'); d.reload();
  });
  const doClose = useSubmit(async () => { await post(`/property-risks/${id}/close`, { note: close }); setClosing(false); toast('Risk closed.'); d.reload(); });
  const addEvidence = useSubmit(async (fs: File[]) => { for (const f of fs) await upload(`/property-risks/${id}/evidence`, f, f.name); toast('Evidence added.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { risk: r, assessments, actions, files, can } = d.data;
  const unverified = actions.filter((x: any) => !['verified', 'closed'].includes(x.status)).length;
  return (
    <>
      <PageHead title={`${r.ref ?? ''} ${r.title}`.trim()} crumbs={[['Property safety', '/estates?tab=risks'], [r.ref ?? r.title]]} intro={<><Link to={`/properties/${r.property_id}?tab=risks`}>{r.property_name}</Link>{r.location && ` · ${r.location}`}{r.category && ` · ${label(r.category)}`}</>}
        actions={<><Status s={riskBand(r.score)[0]} text={riskBand(r.score)[1]} /><Status s={r.status === 'open' ? 'info' : 'completed'} text={label(r.status)} /></>} />
      <div className="grid-2">
        <section className="card" aria-labelledby="rd-h"><h2 id="rd-h">Assessment</h2>
          <dl className="facts"><dt>Details</dt><dd>{r.description ?? '—'}</dd><dt>Likelihood × impact</dt><dd>{r.likelihood} × {r.impact} = {r.score}</dd><dt>Controls</dt><dd>{r.controls ?? '—'}</dd>
            <dt>Owner</dt><dd>{r.owner_name ?? '—'}</dd><dt>Target date</dt><dd>{fmtDate(r.target_on)}</dd><dt>Review</dt><dd>{fmtDate(r.review_on)}</dd>
            {r.closed_at && <><dt>Closed</dt><dd>{fmtDateTime(r.closed_at)} by {r.closed_by_name}: {r.closure_note}</dd></>}</dl>
          <div className="row" style={{ marginTop: 16 }}>
            {can.manage && r.status === 'open' && <Button variant="secondary" onClick={() => setEdit({ title: r.title, location: r.location ?? '', category: r.category ?? '', description: r.description ?? '', likelihood: r.likelihood, impact: r.impact, controls: r.controls ?? '', target_on: r.target_on ?? '', review_on: r.review_on ?? '', assessment_note: '' })}>Edit or re-assess</Button>}
            {can.manage && r.status === 'open' && <Button variant="secondary" onClick={() => setAct(true)}>Add an action</Button>}
            {can.close && <Button variant="go" disabled={unverified > 0} onClick={() => setClosing(true)}>Close risk</Button>}
          </div>
          {r.status === 'open' && unverified > 0 && <p className="small muted">{unverified} action{unverified === 1 ? '' : 's'} not verified yet, so the risk stays open.</p>}
          {r.status === 'open' && can.manage && !can.close && <p className="small muted">As the risk owner, someone else must confirm it can close.</p>}
          <h3 style={{ marginTop: 16 }}>Rating history</h3>
          <ul className="list small">{assessments.map((a: any) => <li key={a.id}><span>{a.likelihood} × {a.impact} = {a.likelihood * a.impact} · {a.note}</span><span className="muted">{a.assessed_by_name}, {fmtDate(a.assessed_at)}</span></li>)}</ul>
        </section>
        <section className="card" aria-labelledby="ra-h"><h2 id="ra-h">Actions and evidence</h2>
          {actions.length === 0 ? <p className="muted">No actions yet.</p> : <ul className="list">{actions.map((x: any) => <li key={x.id}><Link to={`/governance/actions/${x.id}`}>{x.action}</Link><span className="small">{x.owner_name ?? 'No owner'} · due {fmtDate(x.due_on)} · <Status s={ACTION_STATUS[x.status]?.[0] ?? 'info'} text={ACTION_STATUS[x.status]?.[1] ?? label(x.status)} /></span></li>)}</ul>}
          {files.some((f: any) => f.is_image) && <PhotoGrid photos={files.filter((f: any) => f.is_image)} caption={(f) => fmtDateTime(f.uploaded_at)} />}
          {files.some((f: any) => !f.is_image) && <p>{files.filter((f: any) => !f.is_image).map((f: any) => <button key={f.id} type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button>)}</p>}
          {can.evidence && r.status === 'open' && <FilePicker label="Add evidence" accept="image/*,application/pdf" multiple instant busy={addEvidence.busy} onChange={(fs) => addEvidence.run(fs)} />}
        </section>
      </div>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="Edit or re-assess risk" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {edit && <><ErrorSummary error={save.error} />
          <Field label="Hazard"><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <Field label="Room or area" optional><input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /></Field>
          <Field label="Details" optional><textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <RatingFields f={edit} setF={setEdit} score={Number(edit.likelihood) * Number(edit.impact)} />
          {(Number(edit.likelihood) !== r.likelihood || Number(edit.impact) !== r.impact) && <Field label="Why has the rating changed?" error={save.error?.fields.assessment_note}><input value={edit.assessment_note} onChange={(e) => setEdit({ ...edit, assessment_note: e.target.value })} /></Field>}
          <Field label="Controls in place" optional><textarea value={edit.controls} onChange={(e) => setEdit({ ...edit, controls: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Target date" optional><input type="date" value={edit.target_on} onChange={(e) => setEdit({ ...edit, target_on: e.target.value })} /></Field><Field label="Review date" optional><input type="date" value={edit.review_on} onChange={(e) => setEdit({ ...edit, review_on: e.target.value })} /></Field></div></>}
      </Dialog>
      <Dialog open={closing} onClose={() => setClosing(false)} title="Close risk" variant="modal" footer={<Button busy={doClose.busy} disabled={close.trim().length < 5} onClick={() => doClose.run()}>Close risk</Button>}>
        <ErrorSummary error={doClose.error} />
        <Field label="What did you check?"><textarea value={close} onChange={(e) => setClose(e.target.value)} /></Field>
      </Dialog>
      {act && <NewAction source={{ company_id: r.company_id, source_type: 'risk', source_id: r.id, finding: r.title }} onClose={() => setAct(false)} onSaved={() => { setAct(false); d.reload(); }} />}
    </>
  );
}
