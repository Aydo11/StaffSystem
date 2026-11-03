// Repairs: dashboard (figures from records), searchable list with a detail panel, the report form and the repair record.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlarmClock, CalendarPlus, CircleCheck, Lock, PoundSterling, Plus, Repeat, Search, Settings2, Siren, Sparkles, Target, Timer, Wrench, type LucideIcon } from 'lucide-react';
import { download, patch, post, put, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';
import { uploadPhotos } from './Visits.tsx';
import { CATEGORIES, suggestUrgency, URGENCY_RANK, type Urgency } from '../../server/repairPriority.ts';

export const REPAIR_STATUS: Record<string, [string, string]> = {
  reported: ['info', 'Reported'], under_review: ['info', 'Under review'], assigned: ['planned', 'Assigned'], in_progress: ['review', 'In progress'],
  awaiting_parts: ['submitted', 'Awaiting parts / access'], completed: ['submitted', 'Completed'], verified: ['verified', 'Verified'], closed: ['completed', 'Closed'],
  cancelled: ['cancelled', 'Cancelled'], reopened: ['action', 'Reopened'],
};
export const URGENCY: Record<string, [string, string]> = { emergency: ['urgent', 'Emergency'], urgent: ['high', 'Urgent'], routine: ['normal', 'Routine'], planned: ['planned', 'Planned'] };
const URGENCY_HELP: Record<string, string> = { emergency: 'Risk to safety or security now', urgent: 'Could get worse quickly', routine: 'Normal repair', planned: 'Improvement or cosmetic' };
const CAT_LABEL: Record<string, string> = { damp_mould: 'Damp & mould', pest_control: 'Pest control' };
export const catLabel = (c?: string | null) => (c ? CAT_LABEL[c] ?? label(c) : 'Uncategorised');
const DONE = ['verified', 'closed', 'cancelled'];
const MOVE_TEXT: Record<string, string> = { under_review: 'Start review', assigned: 'Mark assigned', in_progress: 'Start work', awaiting_parts: 'Waiting for parts / access', completed: 'Mark completed', verified: 'Verify the work', closed: 'Close', cancelled: 'Cancel repair', reopened: 'Reopen' };

// ── Report form (mobile-first) ──
export function ReportRepair({ properties, onClose, onSaved }: { properties: any[]; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const [f, setF] = useState({ property_id: properties.length === 1 ? properties[0].id : '', title: '', description: '', category: '', location: '', urgency: 'routine' as Urgency, urgency_reason: '', reported_on: londonToday(), immediate_action: '', notes: '', contractor: '', due_on: '' });
  const [photos, setPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const prop = properties.find((p) => p.id === f.property_id);
  const manage = !!prop && hub.can('repairs.manage', prop.company_id);
  const s = suggestUrgency(`${f.title} ${f.description}`);
  const lowered = URGENCY_RANK[f.urgency] > URGENCY_RANK[s.urgency];
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    const opt = (v: string) => v.trim() || null;
    const r = await post('/repairs', { property_id: f.property_id, title: f.title, urgency: f.urgency, reported_on: f.reported_on, description: opt(f.description), category: f.category || null, location: opt(f.location),
      immediate_action: opt(f.immediate_action), notes: opt(f.notes), urgency_reason: lowered ? opt(f.urgency_reason) : null, ...(manage ? { contractor: opt(f.contractor), due_on: f.due_on || null } : {}) });
    const failed = photos.length ? await uploadPhotos(`/repairs/${r.id}/photos`, photos, setProgress, { tag: 'before' }) : 0;
    const raised = r.urgency !== f.urgency ? ` Priority set to ${URGENCY[r.urgency][1].toLowerCase()} from the description.` : '';
    toast(failed ? `Repair reported.${raised} ${failed} photo${failed === 1 ? '' : 's'} did not upload — add ${failed === 1 ? 'it' : 'them'} on the repair.` : `Repair reported.${raised} The repairs manager has it as a task.`); onSaved();
  });
  return (
    <Dialog open onClose={onClose} title="Report a repair" footer={<Button busy={save.busy} onClick={() => save.run()}>Report repair</Button>}>
      <div className="notice warn">If anyone is in danger, call 999 first. For gas, call the National Gas Emergency number.</div>
      <ErrorSummary error={save.error} />
      <Field label="Property" error={save.error?.fields.property_id}><select name="property_id" value={f.property_id} onChange={set('property_id')}><option value="">Choose…</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>
      <Field label="What is wrong?" error={save.error?.fields.title}><input name="title" value={f.title} onChange={set('title')} /></Field>
      <div className="form-grid">
        <Field label="Room or communal area" optional hint="A room label, never a name."><input name="location" list="repair-rooms" value={f.location} onChange={set('location')} /></Field>
        <datalist id="repair-rooms">{[...(prop?.room_refs ?? []), 'Kitchen', 'Bathroom', 'Hallway', 'Communal area', 'Garden', 'Exterior'].map((r: string) => <option key={r} value={r} />)}</datalist>
        <Field label="Category" optional><select name="category" value={f.category} onChange={set('category')}><option value="">Choose…</option>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></Field>
      </div>
      <Field label="Details" optional hint="Property details only — use room labels, not names."><textarea name="description" value={f.description} onChange={set('description')} /></Field>
      <fieldset className="rp-urgency"><legend>Priority</legend>
        {(f.title || f.description) && <p className="rp-suggest"><Sparkles size={16} aria-hidden="true" /> Suggested: <strong>{URGENCY[s.urgency][1]}</strong> — {s.reason.toLowerCase()}.{f.urgency !== s.urgency && <> <button type="button" className="linkish" onClick={() => setF({ ...f, urgency: s.urgency })}>Use it</button></>}</p>}
        <div className="rp-seg" role="radiogroup" aria-label="Priority">
          {(Object.keys(URGENCY) as Urgency[]).map((u) => <label key={u} className={`rp-seg-opt u-${u}`}><input type="radio" name="urgency" value={u} checked={f.urgency === u} onChange={() => setF({ ...f, urgency: u })} /><span>{URGENCY[u][1]}</span><small>{URGENCY_HELP[u]}</small></label>)}
        </div>
        {lowered && prop && (manage ? <Field label="Reason for a lower priority" error={save.error?.fields.urgency_reason}><input name="urgency_reason" value={f.urgency_reason} onChange={set('urgency_reason')} /></Field>
          : <p className="small muted">Only a repairs manager can set a lower priority than suggested, so it will be reported as {URGENCY[s.urgency][1].toLowerCase()}. They can change it.</p>)}
      </fieldset>
      <div className="form-grid">
        <Field label="Date reported" error={save.error?.fields.reported_on}><input name="reported_on" type="date" max={londonToday()} value={f.reported_on} onChange={set('reported_on')} /></Field>
        <Field label="Reported by"><input value={hub.me.person.preferred_name ?? hub.me.person.full_name} readOnly /></Field>
      </div>
      {manage && <div className="form-grid">
        <Field label="Contractor" optional><input name="contractor" value={f.contractor} onChange={set('contractor')} /></Field>
        <Field label="Target date" optional hint="Blank: set from the priority's target."><input name="due_on" type="date" value={f.due_on} onChange={set('due_on')} /></Field>
      </div>}
      <Field label="Immediate action taken" optional><input name="immediate_action" value={f.immediate_action} onChange={set('immediate_action')} /></Field>
      <Field label="Notes" optional><textarea name="notes" value={f.notes} onChange={set('notes')} /></Field>
      <FilePicker label="Photos of the problem" hint="Up to 20. Do not photograph residents." accept="image/jpeg,image/png,image/webp" multiple busy={progress !== null} progress={progress} onChange={setPhotos} />
    </Dialog>
  );
}

// ── Dashboard ──
type Filter = 'active' | 'today' | 'emergency' | 'overdue' | 'completed' | 'repeat' | 'all';
const KPIS: { key: string; label: string; icon: LucideIcon; filter: Filter; tone?: string; fmt?: (s: any) => string; sub?: (s: any) => string | null }[] = [
  { key: 'open', label: 'Open repairs', icon: Wrench, filter: 'active' },
  { key: 'reported_today', label: 'Reported today', icon: CalendarPlus, filter: 'today' },
  { key: 'emergency', label: 'Emergency', icon: Siren, filter: 'emergency', tone: 'bad' },
  { key: 'overdue', label: 'Overdue', icon: AlarmClock, filter: 'overdue', tone: 'warn' },
  { key: 'completed', label: 'Completed this period', icon: CircleCheck, filter: 'completed', tone: 'ok' },
  { key: 'avg_days', label: 'Average resolution', icon: Timer, filter: 'completed', fmt: (s) => (s.avg_days === null ? '—' : `${Number(s.avg_days)} d`), sub: (s) => (s.completed ? `over ${s.completed} completed` : 'nothing completed yet') },
  { key: 'within_target', label: 'Completed within target', icon: Target, filter: 'completed', fmt: (s) => (s.completed ? `${Math.round((100 * s.within_target) / s.completed)}%` : '—'), sub: (s) => (s.completed ? `${s.within_target} of ${s.completed}` : null) },
  { key: 'repeat', label: 'Repeat repairs', icon: Repeat, filter: 'repeat', sub: () => 'same property and category within 90 days' },
  { key: 'spend', label: 'Expenditure', icon: PoundSterling, filter: 'completed', fmt: (s) => money(s.spend), sub: (s) => (s.spend_missing ? `${s.spend_missing} completed without a cost — not included` : 'from recorded costs') },
];

function Bars({ title, data, labelOf, onPick }: { title: string; data: Record<string, number>; labelOf: (k: string) => string; onPick?: (k: string) => void }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <section className="card rp-chart" aria-label={title}><h3>{title}</h3>
      {rows.length === 0 ? <p className="muted small">Nothing open.</p> : <ul>{rows.map(([k, n]) => <li key={k}>
        <button type="button" onClick={() => onPick?.(k)} disabled={!onPick}><span className="rp-bar-label">{labelOf(k)}</span><span className="rp-bar"><span style={{ width: `${(100 * n) / max}%` }} /></span><span className="rp-bar-n">{n}</span></button>
      </li>)}</ul>}
    </section>
  );
}

export function Repairs() {
  const hub = useHub();
  const [property, setProperty] = useState('');
  const d = useApi<any[]>(`/repairs${hub.q({ property: property || null })}`);
  const s = useApi<any>(`/repairs/summary${hub.q({ property: property || null })}`);
  const props = useApi<any[]>(`/properties${hub.q()}`);
  const [reporting, setReporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [urgency, setUrgency] = useState('');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [sla, setSla] = useState(false);
  const today = londonToday();
  const reload = () => { d.reload(); s.reload(); };
  const rows = useMemo(() => (d.data ?? []).filter((r) => {
    if (filter === 'active' && DONE.includes(r.status)) return false;
    if (filter === 'today' && r.reported_on !== today) return false;
    if (filter === 'emergency' && (DONE.includes(r.status) || r.urgency !== 'emergency')) return false;
    if (filter === 'overdue' && !r.overdue) return false;
    if (filter === 'completed' && !(r.completed_on && r.status !== 'cancelled' && s.data && r.completed_on >= s.data.period_from)) return false;
    if (filter === 'repeat' && !r.repeat) return false;
    if (status && r.status !== status) return false;
    if (urgency && r.urgency !== urgency) return false;
    if (category && (r.category ?? 'uncategorised') !== category) return false;
    const t = text.trim().toLowerCase();
    return !t || [r.title, r.description, r.property_name, r.property_ref, r.location, r.contractor, r.assignee_name, r.agent_name].some((v) => v?.toLowerCase().includes(t));
  }), [d.data, filter, status, urgency, category, text, s.data, today]);
  const manageAny = hub.can('repairs.manage');
  const pick = (f: Filter) => { setFilter(f); setStatus(''); setUrgency(''); setCategory(''); };
  return (
    <div className="rp">
      <div className="rp-head">
        <div><h2>Repairs</h2><p className="muted small">{s.data ? `Figures for ${fmtDate(s.data.period_from)} – ${fmtDate(s.data.period_to)} where a period applies. Counts come only from repair records.` : ' '}</p></div>
        <div className="rp-head-actions">
          <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}><option value="">All properties</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select>
          {manageAny && <Button variant="secondary" onClick={() => setSla(true)} aria-label="Repair targets"><Settings2 size={18} aria-hidden="true" /><span className="hide-sm">Targets</span></Button>}
          <Button onClick={() => setReporting(true)}><Plus size={18} aria-hidden="true" />Report repair</Button>
        </div>
      </div>
      {s.error ? <LoadError error={s.error} retry={s.reload} /> : !s.data ? <Skeleton lines={3} /> : (
        <ul className="rp-kpis" aria-label="Repair figures">{KPIS.map((k) => { const I = k.icon; return (
          <li key={k.key}><button type="button" className={`rp-kpi ${k.tone ?? ''}`} aria-pressed={filter === k.filter && !['avg_days', 'within_target', 'spend'].includes(k.key) && (k.key !== 'completed' || filter === 'completed')} onClick={() => pick(k.filter)}>
            <span className="rp-kpi-icon"><I size={20} aria-hidden="true" /></span>
            <span className="rp-kpi-value">{k.fmt ? k.fmt(s.data) : s.data[k.key]}</span>
            <span className="rp-kpi-label">{k.label}</span>
            {k.sub?.(s.data) && <span className="rp-kpi-sub">{k.sub(s.data)}</span>}
          </button></li>); })}</ul>
      )}
      {s.data && <div className="rp-charts">
        <Bars title="Open by category" data={s.data.by_category} labelOf={(k) => catLabel(k === 'uncategorised' ? null : k)} onPick={(k) => { pick('active'); setCategory(k); }} />
        <Bars title="Open by stage" data={s.data.by_status} labelOf={(k) => REPAIR_STATUS[k]?.[1] ?? label(k)} onPick={(k) => { pick('active'); setStatus(k); }} />
        <Bars title="Open by priority" data={s.data.by_urgency} labelOf={(k) => URGENCY[k]?.[1] ?? label(k)} onPick={(k) => { pick('active'); setUrgency(k); }} />
      </div>}
      <div className="rp-toolbar">
        <label className="rp-search"><Search size={18} aria-hidden="true" /><input type="search" placeholder="Search repairs, properties, contractors…" aria-label="Search repairs" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}><option value="active">Open</option><option value="all">All, including finished</option><option value="today">Reported today</option><option value="emergency">Emergency</option><option value="overdue">Overdue</option><option value="completed">Completed this period</option><option value="repeat">Repeat repairs</option></select>
        <select aria-label="Stage" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any stage</option>{Object.entries(REPAIR_STATUS).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select>
        <select aria-label="Priority" value={urgency} onChange={(e) => setUrgency(e.target.value)}><option value="">Any priority</option>{Object.entries(URGENCY).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select>
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Any category</option>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}<option value="uncategorised">Uncategorised</option></select>
      </div>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : d.loading && !d.data ? <Skeleton /> : rows.length === 0 ? <Empty>No repairs match.</Empty> : (
        <div className="table-wrap rp-table"><table><thead><tr><th>Repair</th><th>Property</th><th>Category</th><th>Priority</th><th>Stage</th><th>Assigned</th><th>Target</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="rp-row" onClick={() => setOpen(r)}>
            <td><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); setOpen(r); }}>{r.title}</button>{r.location && <div className="muted small">{r.location}</div>}</td>
            <td data-label="Property">{r.property_name} <CompanyBadge code={r.company_code} name={r.company_name} /></td>
            <td data-label="Category">{catLabel(r.category)}{r.repeat && <span className="rp-tag" title="Same property and category within 90 days"><Repeat size={12} aria-hidden="true" /> Repeat</span>}</td>
            <td data-label="Priority"><Status s={URGENCY[r.urgency][0]} text={URGENCY[r.urgency][1]} /></td>
            <td data-label="Stage"><Status s={REPAIR_STATUS[r.status][0]} text={REPAIR_STATUS[r.status][1]} /></td>
            <td data-label="Assigned">{r.assignee_name ?? r.agent_name ?? r.contractor ?? '—'}</td>
            <td data-label="Target">{fmtDate(r.due_on)}{r.overdue && <div><Status s="action" text="Overdue" /></div>}</td>
          </tr>)}</tbody></table></div>
      )}
      <p className="small muted">{rows.length} shown{d.data && d.data.length >= 1000 ? ' (latest 1,000 repairs)' : ''}.{s.data?.uncategorised ? ` ${s.data.uncategorised} open repair${s.data.uncategorised === 1 ? ' has' : 's have'} no category yet.` : ''}</p>
      {open && <Dialog open onClose={() => setOpen(null)} title={open.title} footer={<Link className="btn" to={`/estates/repairs/${open.id}`}>Open full record</Link>}>
        <div className="row"><Status s={URGENCY[open.urgency][0]} text={URGENCY[open.urgency][1]} /><Status s={REPAIR_STATUS[open.status][0]} text={REPAIR_STATUS[open.status][1]} />{open.overdue && <Status s="action" text="Overdue" />}</div>
        <dl className="facts">
          <dt>Property</dt><dd>{open.property_name} ({open.property_ref})</dd><dt>Where</dt><dd>{open.location ?? '—'}</dd><dt>Category</dt><dd>{catLabel(open.category)}</dd>
          <dt>Details</dt><dd>{open.description ?? '—'}</dd><dt>Reported</dt><dd>{fmtDate(open.reported_on)} by {open.reported_by_name}</dd>
          <dt>Assigned</dt><dd>{open.assignee_name ?? open.agent_name ?? open.contractor ?? 'Not yet'}</dd><dt>Target</dt><dd>{fmtDate(open.due_on)}</dd>
          {open.completed_on && <><dt>Completed</dt><dd>{fmtDate(open.completed_on)}{open.cost !== null && ` · ${money(open.cost)}`}</dd></>}
          {open.suggested_urgency && open.suggested_urgency !== open.urgency && <><dt>Priority note</dt><dd>Suggested {URGENCY[open.suggested_urgency][1].toLowerCase()}{open.urgency_reason ? `; set lower because: ${open.urgency_reason}` : ''}</dd></>}
        </dl>
      </Dialog>}
      {reporting && <ReportRepair properties={props.data ?? []} onClose={() => setReporting(false)} onSaved={() => { setReporting(false); reload(); }} />}
      {sla && <SlaDialog onClose={() => setSla(false)} />}
    </div>
  );
}

function SlaDialog({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/repairs/sla${hub.q()}`);
  const companies = hub.me.companies.filter((c) => c.perms.includes('repairs.manage'));
  const [company, setCompany] = useState(hub.company !== 'all' && companies.some((c) => c.id === hub.company) ? hub.company : companies[0]?.id ?? '');
  const [edit, setEdit] = useState<Record<string, { target_days: number; escalate_after_days: number }>>({});
  const rows = (d.data ?? []).filter((r) => r.company_id === company);
  const val = (u: string, k: 'target_days' | 'escalate_after_days') => edit[u]?.[k] ?? rows.find((r) => r.urgency === u)?.[k] ?? 0;
  const save = useSubmit(async () => {
    await put('/repairs/sla', { company_id: company, targets: Object.keys(URGENCY).map((u) => ({ urgency: u, target_days: val(u, 'target_days'), escalate_after_days: val(u, 'escalate_after_days') })) });
    toast('Targets saved. New repairs use them.'); onClose();
  });
  return (
    <Dialog open onClose={onClose} title="Repair targets" footer={<Button busy={save.busy} onClick={() => save.run()}>Save targets</Button>}>
      <p className="muted">Days from the date reported to the target date, by priority. A repair this many days past its target is escalated once to the repairs manager and property manager.</p>
      <ErrorSummary error={save.error} />
      {companies.length > 1 && <Field label="Company"><select value={company} onChange={(e) => { setCompany(e.target.value); setEdit({}); }}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      {!d.data ? <Skeleton /> : <div className="table-wrap"><table><thead><tr><th>Priority</th><th>Target (days)</th><th>Escalate after (days late)</th></tr></thead><tbody>
        {Object.entries(URGENCY).map(([u, [, t]]) => <tr key={u}><td>{t}</td>
          {(['target_days', 'escalate_after_days'] as const).map((k) => <td key={k}><input type="number" min={0} max={k === 'target_days' ? 365 : 90} aria-label={`${t} ${k === 'target_days' ? 'target days' : 'escalate after days'}`} style={{ maxWidth: 100 }}
            value={val(u, k)} onChange={(e) => setEdit({ ...edit, [u]: { target_days: val(u, 'target_days'), escalate_after_days: val(u, 'escalate_after_days'), [k]: Number(e.target.value) } })} /></td>)}</tr>)}
      </tbody></table></div>}
    </Dialog>
  );
}

// ── The repair record ──
const daysBetween = (from: string, to: string) => { const n = Math.round((Date.parse(to) - Date.parse(from.slice(0, 10))) / 864e5); return n <= 0 ? 'Same day' : `${n} day${n === 1 ? '' : 's'}`; };

export function RepairPage() {
  const { id } = useParams();
  const d = useApi<any>(`/repairs/${id}`);
  const toast = useToast();
  const [move, setMove] = useState<string | null>(null);
  const [mv, setMv] = useState({ note: '', work_description: '', completed_on: londonToday(), cost: '', contractor_attended: '', resident_confirmed: '' });
  const [upd, setUpd] = useState({ body: '', file: null as File | null });
  const [pickerKey, setPickerKey] = useState(0); // remounts the picker to clear it after an update
  const [assign, setAssign] = useState<any>(null);
  const people = useApi<any[]>(assign && d.data ? `/people?company=${d.data.repair.company_id}` : null);
  const agents = useApi<any[]>(assign && d.data ? `/agents?company=${d.data.repair.company_id}` : null);
  const yn = (v: string) => (v === '' ? null : v === 'yes');
  const status = useSubmit(async () => {
    await post(`/repairs/${id}/status`, { status: move, note: mv.note, ...(move === 'completed' ? { work_description: mv.work_description, completed_on: mv.completed_on, cost: mv.cost === '' ? null : Number(mv.cost), contractor_attended: yn(mv.contractor_attended), resident_confirmed: yn(mv.resident_confirmed) } : {}) });
    setMove(null); setMv({ ...mv, note: '', work_description: '' }); toast('Repair updated.'); d.reload();
  });
  const addUpd = useSubmit(async () => { await upload(`/repairs/${id}/updates`, upd.file, upd.file?.name ?? '', undefined, { body: upd.body }); setUpd({ body: '', file: null }); setPickerKey((k) => k + 1); d.reload(); });
  const [photoProgress, setPhotoProgress] = useState<number | null>(null);
  const addPhotos = useSubmit(async (fs: File[], tag: string) => { const failed = await uploadPhotos(`/repairs/${id}/photos`, fs, setPhotoProgress, { tag }); toast(failed ? `${failed} photo${failed === 1 ? '' : 's'} did not upload.` : 'Photos added.'); d.reload(); });
  const saveAssign = useSubmit(async () => {
    const r = d.data.repair;
    const b: any = { assignee_id: assign.assignee_id || null, agent_id: assign.agent_id || null, contractor: assign.contractor || null, due_on: assign.due_on || null, urgency: assign.urgency, category: assign.category || null, location: assign.location || null, notes: assign.notes || null, cost: assign.cost === '' || assign.cost === null ? null : Number(assign.cost) };
    if (assign.urgency !== r.urgency) b.urgency_reason = assign.urgency_reason || null;
    // Only what changed is sent, so the audit trail shows real changes.
    const changed = Object.fromEntries(Object.entries(b).filter(([k, v]) => String(v ?? '') !== String(r[k] ?? '')));
    if (Object.keys(changed).length) await patch(`/repairs/${id}`, changed);
    setAssign(null); toast('Saved.'); d.reload();
  });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { repair: r, updates, files, can } = d.data;
  const locked = ['closed', 'cancelled'].includes(r.status);
  const photosBy = (tag: string) => files.filter((f: any) => f.is_image && (f.tag ?? 'before') === tag);
  return (
    <>
      <PageHead title={r.title} crumbs={[['Repairs', '/estates'], [r.title]]} intro={<>{r.property_name} · <span className="badge co">{r.company_code}</span> · reported by {r.reported_by_name} on {fmtDate(r.reported_on)}</>}
        actions={<><Status s={URGENCY[r.urgency][0]} text={URGENCY[r.urgency][1]} /><Status s={REPAIR_STATUS[r.status][0]} text={REPAIR_STATUS[r.status][1]} /></>} />
      <ErrorSummary error={status.error ?? addUpd.error ?? addPhotos.error} />
      {locked && <div className="notice"><Lock size={16} aria-hidden="true" /> This repair is {r.status}. It cannot be changed{can.manage ? ' unless you reopen it with a reason' : ''}; its history stays on record.</div>}
      <ol className="rp-steps" aria-label="Progress">{['reported', 'under_review', 'assigned', 'in_progress', 'completed', 'verified', 'closed'].map((st, i, all) => {
        const at = all.indexOf(r.status === 'awaiting_parts' ? 'in_progress' : r.status === 'reopened' ? 'reported' : r.status);
        return <li key={st} className={r.status === 'cancelled' ? '' : i < at ? 'done' : i === at ? 'now' : ''}>{REPAIR_STATUS[st][1]}</li>;
      })}</ol>
      <div className="grid-2">
        <section className="card" aria-labelledby="rd-h"><h2 id="rd-h">Details</h2>
          <dl className="facts"><dt>Where</dt><dd>{r.location ?? '—'}</dd><dt>Category</dt><dd>{catLabel(r.category)}</dd><dt>Details</dt><dd>{r.description ?? '—'}</dd><dt>Impact</dt><dd>{r.impact ?? '—'}</dd><dt>Immediate action</dt><dd>{r.immediate_action ?? '—'}</dd>
            {r.suggested_urgency && r.suggested_urgency !== r.urgency && <><dt>Priority</dt><dd>Suggested {URGENCY[r.suggested_urgency][1].toLowerCase()}{r.urgency_reason && ` — set ${URGENCY[r.urgency][1].toLowerCase()} because: ${r.urgency_reason}`}</dd></>}
            <dt>Repairs manager</dt><dd>{r.manager_name ?? 'Not set — choose one in Governance → Leads'}</dd><dt>Assigned</dt><dd>{[r.assignee_name, r.agent_name, r.contractor].filter(Boolean).join(' · ') || 'Not yet'}</dd><dt>Target date</dt><dd>{fmtDate(r.due_on)}{r.escalated_at && <> · <Status s="action" text="Escalated" /></>}</dd>
            {r.notes && <><dt>Notes</dt><dd>{r.notes}</dd></>}
            {r.completed_on && <><dt>Work completed</dt><dd>{fmtDate(r.completed_on)} · {daysBetween(r.reported_on, r.completed_on)} · {r.completed_on <= r.due_on ? <Status s="verified" text="Within target" /> : <Status s="action" text="Late" />}</dd>
              <dt>Work done</dt><dd>{r.work_description ?? '—'}</dd><dt>Cost</dt><dd>{r.cost === null ? 'Not recorded' : money(r.cost)}</dd>
              <dt>Contractor attended</dt><dd>{r.contractor_attended === null ? '—' : r.contractor_attended ? 'Yes' : 'No'}</dd><dt>Resident confirmed</dt><dd>{r.resident_confirmed === null ? '—' : r.resident_confirmed ? 'Yes' : 'No'}</dd></>}
            {r.verified_at && <><dt>Verified</dt><dd>{fmtDateTime(r.verified_at)} by {r.verified_by_name}</dd></>}
            {r.closed_at && <><dt>Closed</dt><dd>{fmtDateTime(r.closed_at)}</dd></>}</dl>
          <h3 style={{ marginTop: 16 }}>What happens next</h3>
          <div className="row">
            {can.manage && !locked && <Button variant="secondary" onClick={() => setAssign({ assignee_id: r.assignee_id ?? '', agent_id: r.agent_id ?? '', contractor: r.contractor ?? '', due_on: r.due_on ?? '', urgency: r.urgency, urgency_reason: '', category: r.category ?? '', location: r.location ?? '', notes: r.notes ?? '', cost: r.cost ?? '' })}>Assign or edit</Button>}
            {can.next.map((s: string) => <Button key={s} variant={['verified', 'closed'].includes(s) ? 'go' : s === 'cancelled' ? 'danger' : s === 'in_progress' && ['completed', 'verified'].includes(r.status) ? 'secondary' : 'primary'} onClick={() => setMove(s)}>
              {s === 'in_progress' && ['completed', 'verified'].includes(r.status) ? 'Send back — not finished' : MOVE_TEXT[s]}</Button>)}
          </div>
        </section>
        <section className="card" aria-labelledby="ru-h"><h2 id="ru-h">History and updates</h2>
          {updates.length === 0 ? <p className="muted">No updates.</p> : <ul className="list">{updates.map((u: any) => <li key={u.id}><div><strong>{u.author_name}</strong> <span className="muted small">{fmtDateTime(u.created_at)}</span>{u.status_to && <span className="small"> · {REPAIR_STATUS[u.status_from]?.[1] ?? label(u.status_from)} → {REPAIR_STATUS[u.status_to]?.[1] ?? label(u.status_to)}</span>}<p style={{ margin: '4px 0 0' }}>{u.body}</p></div></li>)}</ul>}
          {(['before', 'after'] as const).map((tag) => photosBy(tag).length > 0 && <div key={tag}><h3>{tag === 'before' ? 'Before' : 'After'}</h3><PhotoGrid photos={photosBy(tag)} caption={(f) => fmtDateTime(f.uploaded_at)} /></div>)}
          {files.some((f: any) => !f.is_image) && <p>Documents: {files.filter((f: any) => !f.is_image).map((f: any) => <button key={f.id} type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button>)}</p>}
          {(can.work || can.photos) && !locked && <div className="form-grid">
            <FilePicker label="Before photos" accept="image/jpeg,image/png,image/webp" multiple instant busy={photoProgress !== null} progress={photoProgress} onChange={(fs) => addPhotos.run(fs, 'before')} />
            {can.work && <FilePicker label="After photos" hint="Of the finished work." accept="image/jpeg,image/png,image/webp" multiple instant busy={photoProgress !== null} progress={photoProgress} onChange={(fs) => addPhotos.run(fs, 'after')} />}
          </div>}
          {can.work && !locked && <><Field label="Add an update"><textarea name="body" value={upd.body} onChange={(e) => setUpd({ ...upd, body: e.target.value })} /></Field>
            <FilePicker key={pickerKey} label="Photo or document" accept="image/*,application/pdf" onChange={(fs) => setUpd({ ...upd, file: fs[0] ?? null })} />
            <Button variant="secondary" busy={addUpd.busy} disabled={upd.body.trim().length < 2} onClick={() => addUpd.run()}>Add update</Button></>}
        </section>
      </div>
      <Dialog open={!!move} onClose={() => setMove(null)} title={move ? MOVE_TEXT[move] : ''} variant={move === 'completed' ? 'panel' : 'modal'} footer={<Button busy={status.busy} disabled={mv.note.trim().length < 2} onClick={() => status.run()}>Confirm</Button>}>
        {move === 'verified' && <p>Check the work is done. Someone other than the person who marked it completed must verify it.</p>}
        {move === 'closed' && <p>Once closed, the record is locked. It can only be reopened by a repairs manager, with a reason.</p>}
        <ErrorSummary error={status.error} />
        {move === 'completed' && <>
          <Field label="Work done" error={status.error?.fields.work_description}><textarea name="work_description" value={mv.work_description} onChange={(e) => setMv({ ...mv, work_description: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label="Date completed" error={status.error?.fields.completed_on}><input type="date" max={londonToday()} value={mv.completed_on} onChange={(e) => setMv({ ...mv, completed_on: e.target.value })} /></Field>
            <Field label="Cost (£)" optional><input type="number" min={0} step="0.01" inputMode="decimal" value={mv.cost} onChange={(e) => setMv({ ...mv, cost: e.target.value })} /></Field>
            <Field label="Contractor attended?" optional><select value={mv.contractor_attended} onChange={(e) => setMv({ ...mv, contractor_attended: e.target.value })}><option value="">Not recorded</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
            <Field label="Resident confirmed it is fixed?" optional><select value={mv.resident_confirmed} onChange={(e) => setMv({ ...mv, resident_confirmed: e.target.value })}><option value="">Not asked</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
          </div>
          <p className="small muted">Add after photos on the repair so the work can be verified.</p>
        </>}
        <Field label={['cancelled', 'reopened'].includes(move ?? '') ? 'Reason' : move === 'verified' ? 'What did you check?' : 'Note'} error={status.error?.fields.note}><textarea name="note" value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={!!assign} onClose={() => setAssign(null)} title="Assign or edit repair" footer={<Button busy={saveAssign.busy} onClick={() => saveAssign.run()}>Save</Button>}>
        {assign && <><ErrorSummary error={saveAssign.error} />
          <div className="form-grid">
            <Field label="Priority"><select name="urgency" value={assign.urgency} onChange={(e) => setAssign({ ...assign, urgency: e.target.value })}>{Object.entries(URGENCY).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select></Field>
            <Field label="Category" optional><select value={assign.category} onChange={(e) => setAssign({ ...assign, category: e.target.value })}><option value="">Choose…</option>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></Field>
          </div>
          {assign.urgency !== r.urgency && <Field label="Reason for the change" optional><input value={assign.urgency_reason} onChange={(e) => setAssign({ ...assign, urgency_reason: e.target.value })} /></Field>}
          <Field label="Room or communal area" optional><input value={assign.location} onChange={(e) => setAssign({ ...assign, location: e.target.value })} /></Field>
          <Field label="Staff member" optional><select name="assignee_id" value={assign.assignee_id} onChange={(e) => setAssign({ ...assign, assignee_id: e.target.value })}><option value="">None</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Managing agent" optional><select name="agent_id" value={assign.agent_id} onChange={(e) => setAssign({ ...assign, agent_id: e.target.value })}><option value="">None</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <div className="form-grid">
            <Field label="Contractor" optional><input name="contractor" value={assign.contractor} onChange={(e) => setAssign({ ...assign, contractor: e.target.value })} /></Field>
            <Field label="Target date" optional><input name="due_on" type="date" value={assign.due_on} onChange={(e) => setAssign({ ...assign, due_on: e.target.value })} /></Field>
          </div>
          <Field label="Cost (£)" optional><input type="number" min={0} step="0.01" value={assign.cost} onChange={(e) => setAssign({ ...assign, cost: e.target.value })} /></Field>
          <Field label="Notes" optional><textarea value={assign.notes} onChange={(e) => setAssign({ ...assign, notes: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
