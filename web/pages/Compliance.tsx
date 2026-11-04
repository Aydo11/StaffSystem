// Selective property compliance. Only properties where an administrator has turned monitoring on are counted or warned about.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, Building2, CalendarClock, ClipboardList, FileQuestion, Gauge, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';
import { download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

export const CLASSIFICATION: Record<string, string> = { windrush: 'Windrush', other_rsl: 'Other RSL', standard: 'Standard management' };
const STATE: Record<string, [string, string]> = { never_done: ['not_started', 'Not yet recorded'], failed: ['action', 'Failed'], overdue: ['action', 'Overdue'], due_soon: ['review', 'Due soon'], in_date: ['verified', 'In date'], not_applicable: ['not_required', 'Not applicable'] };

function Tile({ icon: I, value, label: text, sub, tone }: { icon: LucideIcon; value: React.ReactNode; label: string; sub?: string | null; tone?: string }) {
  return <li><div className={`rp-kpi ${tone ?? ''}`} style={{ cursor: 'default' }}><span className="rp-kpi-icon"><I size={20} aria-hidden="true" /></span><span className="rp-kpi-value">{value}</span><span className="rp-kpi-label">{text}</span>{sub && <span className="rp-kpi-sub">{sub}</span>}</div></li>;
}
const Meter = ({ v }: { v: number | null }) => (v === null ? <span className="muted">—</span> : <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><span className="cp-meter" role="img" aria-label={`${v}%`}><span style={{ width: `${v}%` }} /></span><strong>{v}%</strong></span>);

export function Compliance() {
  const hub = useHub();
  const toast = useToast();
  const [agent, setAgent] = useState('');
  const [cls, setCls] = useState('');
  const qs = hub.q({ agent: agent || null, classification: cls || null });
  const dash = useApi<any>(`/compliance/dashboard${qs}`);
  const list = useApi<any[]>(`/compliance/properties${qs}`);
  const fw = useApi<any>(`/compliance/frameworks${hub.q()}`);
  const manage = hub.can('compliance.manage');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState({ classification: '', framework_id: '' });
  const [newFw, setNewFw] = useState(false);
  const agents = useMemo(() => [...new Set((list.data ?? []).map((p) => p.agent))].sort(), [list.data]);
  const reload = () => { dash.reload(); list.reload(); };
  const apply = useSubmit(async (enabled?: boolean) => {
    const body: any = { property_ids: [...sel] };
    if (enabled !== undefined) body.enabled = enabled;
    if (bulk.classification) body.classification = bulk.classification;
    if (bulk.framework_id) body.framework_id = bulk.framework_id;
    const r = await post('/compliance/properties/bulk', body);
    toast(`${r.updated} propert${r.updated === 1 ? 'y' : 'ies'} updated.`); setSel(new Set()); reload();
  });
  const toggle = useSubmit(async (p: any) => { await patch(`/compliance/properties/${p.id}`, { enabled: !p.compliance_enabled }); toast(p.compliance_enabled ? `Monitoring off for ${p.name}. Its records are kept.` : `Monitoring on for ${p.name}.`); reload(); });
  const d = dash.data;
  const rows = list.data ?? [];
  return (
    <>
      <PageHead title="Property compliance" intro="Compliance monitoring for the properties an administrator has chosen, such as Windrush contracts. Properties where it is off are not counted and show no compliance warnings." />
      <div className="rp-toolbar">
        <select aria-label="Managing agent" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All managing agents</option>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <select aria-label="Classification" value={cls} onChange={(e) => setCls(e.target.value)}><option value="">All classifications</option>{Object.entries(CLASSIFICATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}<option value="none">Not classified</option></select>
      </div>
      {dash.error ? <LoadError error={dash.error} retry={dash.reload} /> : !d ? <Skeleton lines={3} /> : d.properties === 0 ? (
        <div className="notice">No properties have compliance monitoring turned on{agent || cls ? ' for this filter' : ''}.{manage ? ' Turn it on for the properties that need it below.' : ' An administrator turns it on per property.'}</div>
      ) : <>
        <ul className="rp-kpis" aria-label="Compliance figures">
          <Tile icon={Building2} value={d.properties} label="Properties monitored" />
          <Tile icon={ShieldCheck} value={d.compliant_properties} label="Fully compliant" tone="ok" sub={`of ${d.properties} monitored`} />
          <Tile icon={Gauge} value={d.score === null ? '—' : `${d.score}%`} label="Overall compliance" sub={`${d.compliant} of ${d.applicable} applicable items in date`} />
          <Tile icon={AlarmClock} value={d.overdue} label="Overdue items" tone={d.overdue ? 'bad' : ''} />
          <Tile icon={ShieldX} value={d.failed} label="Failed items" tone={d.failed ? 'bad' : ''} />
          <Tile icon={CalendarClock} value={d.expiring_30} label="Expiring in 30 days" tone={d.expiring_30 ? 'warn' : ''} sub={`${d.expiring_60} in 60 · ${d.expiring_90} in 90`} />
          <Tile icon={ClipboardList} value={d.outstanding_actions} label="Outstanding actions" />
          <Tile icon={FileQuestion} value={d.never_done} label="Not yet recorded" sub={`Missing data, not a pass or fail. ${d.unverified} record${d.unverified === 1 ? '' : 's'} awaiting verification.`} />
        </ul>
        <section className="card" aria-labelledby="ag-h"><h2 id="ag-h">By managing agent</h2>
          <div className="table-wrap"><table><thead><tr><th>Managing agent</th><th className="num">Properties</th><th className="num">Fully compliant</th><th>Compliance</th><th className="num">Overdue</th><th className="num">Failed</th></tr></thead>
            <tbody>{d.by_agent.map((g: any) => <tr key={g.agent}><td>{g.agent}</td><td className="num">{g.properties}</td><td className="num">{g.compliant_properties}</td><td><Meter v={g.score} /></td><td className="num">{g.overdue}</td><td className="num">{g.failed}</td></tr>)}</tbody></table></div>
        </section>
      </>}
      <section className="card" aria-labelledby="cp-h" style={{ marginTop: 16 }}>
        <div className="row between"><h2 id="cp-h">Properties</h2>{manage && <Button variant="secondary" onClick={() => setNewFw(true)}>New framework</Button>}</div>
        {manage && <p className="small muted">Monitoring is off until you turn it on. Turning it off hides the property from compliance figures but keeps every record and its history.</p>}
        {list.error ? <LoadError error={list.error} retry={list.reload} /> : !list.data ? <Skeleton /> : rows.length === 0 ? <Empty>No properties.</Empty> : (
          <div className="table-wrap"><table><thead><tr>
            {manage && <th><input type="checkbox" aria-label="Select all" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((p) => p.id)) : new Set())} /></th>}
            <th>Property</th><th>Classification</th><th>Monitoring</th><th>Compliance</th><th className="num">Overdue</th><th className="num">Failed</th><th className="num">Not recorded</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>{rows.map((p) => <tr key={p.id}>
              {manage && <td><input type="checkbox" aria-label={`Select ${p.name}`} checked={sel.has(p.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(p.id) : s.delete(p.id); setSel(s); }} /></td>}
              <td><span className="cp-nowrap">{p.compliance_enabled ? <Link to={`/properties/${p.id}?tab=compliance`}>{p.name}</Link> : p.name}</span><div className="muted small">{p.ref} · {p.agent}</div></td><td>{p.classification ? CLASSIFICATION[p.classification] : <span className="muted">Not classified</span>}{p.framework_name && <div className="muted small">{p.framework_name}</div>}</td>
              <td>{p.compliance_enabled ? <Status s="active" text="On" /> : <span className="cp-off">Off</span>}</td>
              {p.compliance_enabled ? <><td><Meter v={p.score} /></td><td className="num">{p.overdue}</td><td className="num">{p.failed}</td><td className="num">{p.never_done}</td></> : <td colSpan={4} className="cp-off">Not monitored</td>}
              {manage && <td className="cp-nowrap"><Button variant="ghost" busy={toggle.busy} onClick={() => toggle.run(p)}>{p.compliance_enabled ? 'Turn off' : 'Turn on'}<span className="sr-only"> for {p.name}</span></Button></td>}
            </tr>)}</tbody></table></div>
        )}
        <ErrorSummary error={apply.error ?? toggle.error} />
        {manage && sel.size > 0 && <div className="cp-bulk" role="region" aria-label="Bulk changes">
          <strong>{sel.size} selected</strong>
          <select aria-label="Set classification" value={bulk.classification} onChange={(e) => setBulk({ ...bulk, classification: e.target.value })}><option value="">Keep classification</option>{Object.entries(CLASSIFICATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
          <select aria-label="Set framework" value={bulk.framework_id} onChange={(e) => setBulk({ ...bulk, framework_id: e.target.value })}><option value="">Keep framework (standard checklist if none)</option>{fw.data?.frameworks.map((f: any) => <option key={f.id} value={f.id}>{f.name} ({f.company_code})</option>)}</select>
          <Button variant="go" busy={apply.busy} onClick={() => apply.run(true)}>Turn on</Button>
          <Button variant="secondary" busy={apply.busy} onClick={() => apply.run(false)}>Turn off</Button>
          {(bulk.classification || bulk.framework_id) && <Button variant="secondary" busy={apply.busy} onClick={() => apply.run(undefined)}>Apply settings only</Button>}
        </div>}
      </section>
      {newFw && fw.data && <FrameworkDialog defaults={fw.data.defaults} onClose={() => setNewFw(false)} onSaved={() => { setNewFw(false); fw.reload(); }} />}
    </>
  );
}

function FrameworkDialog({ defaults, onClose, onSaved }: { defaults: any[]; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const companies = hub.me.companies.filter((c) => c.perms.includes('compliance.manage'));
  const [f, setF] = useState({ company_id: hub.company !== 'all' ? hub.company : companies[0]?.id ?? '', name: '', description: '' });
  const [items, setItems] = useState(defaults.map((d) => ({ ...d, on: true })));
  const [extra, setExtra] = useState({ name: '', interval_days: 365 });
  const save = useSubmit(async () => {
    await post('/compliance/frameworks', { ...f, description: f.description || null, items: items.filter((i) => i.on).map(({ key, name, interval_days }) => ({ key, name, interval_days: Number(interval_days) })) });
    onSaved();
  });
  const addExtra = () => { const key = extra.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60); if (key.length >= 2 && !items.some((i) => i.key === key)) { setItems([...items, { key, name: extra.name, interval_days: extra.interval_days, on: true }]); setExtra({ name: '', interval_days: 365 }); } };
  return (
    <Dialog open onClose={onClose} title="New compliance framework" footer={<Button busy={save.busy} onClick={() => save.run()}>Save framework</Button>}>
      <p className="muted">A checklist you can assign to properties. Check each interval against your contract and legal obligations.</p>
      <ErrorSummary error={save.error} />
      {companies.length > 1 && <Field label="Company"><select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <Field label="Name" error={save.error?.fields.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Windrush contract" /></Field>
      <Field label="Description" optional><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <fieldset className="card"><legend style={{ fontWeight: 600 }}>Requirements</legend>
        {items.map((it, i) => <div key={it.key} className="row" style={{ flexWrap: 'nowrap' }}>
          <label className="check" style={{ flex: 1 }}><input type="checkbox" checked={it.on} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /> {it.name}</label>
          <input type="number" min={1} max={3660} aria-label={`${it.name}: every how many days`} style={{ maxWidth: 90 }} value={it.interval_days} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, interval_days: e.target.value } : x)))} /><span className="small muted">days</span>
        </div>)}
        <div className="row" style={{ marginTop: 8 }}><input aria-label="Custom requirement" placeholder="Add a custom requirement" value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} style={{ flex: 1 }} />
          <input type="number" aria-label="Every how many days" min={1} max={3660} style={{ maxWidth: 90 }} value={extra.interval_days} onChange={(e) => setExtra({ ...extra, interval_days: Number(e.target.value) })} /><Button variant="secondary" onClick={addExtra} disabled={extra.name.trim().length < 2}>Add</Button></div>
      </fieldset>
    </Dialog>
  );
}

// ── The property's Compliance tab (only shown when monitoring is on, or to administrators) ──
export function ComplianceTab({ propertyId }: { propertyId: string }) {
  const d = useApi<any>(`/compliance/properties/${propertyId}`);
  const toast = useToast();
  const [rec, setRec] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [custom, setCustom] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const people = useApi<any[]>(edit && d.data ? `/people?company=${d.data.property.company_id}` : null);
  const fw = useApi<any>(d.data?.can.manage ? `/compliance/frameworks?company=${d.data.property.company_id}` : null);
  const settings = useSubmit(async (b: any) => { await patch(`/compliance/properties/${propertyId}`, b); toast('Saved.'); d.reload(); });
  const saveRec = useSubmit(async () => {
    const r = await upload(`/compliance/requirements/${rec.req.id}/records`, rec.file, rec.file?.name ?? '', undefined,
      Object.fromEntries(Object.entries({ completed_on: rec.completed_on, next_due_on: rec.next_due_on, outcome: rec.outcome, done_by_text: rec.done_by_text, findings: rec.findings, corrective_action: rec.corrective_action }).filter(([, v]) => v)) as Record<string, string>);
    toast(r.action ? 'Recorded. A corrective action was opened because it failed.' : 'Recorded.'); setRec(null); d.reload();
  });
  const saveEdit = useSubmit(async () => {
    const { id, ...b } = edit;
    await patch(`/compliance/requirements/${id}`, b); setEdit(null); toast('Saved.'); d.reload();
  });
  const addCustom = useSubmit(async () => { await post(`/compliance/properties/${propertyId}/requirements`, { ...custom, interval_days: Number(custom.interval_days) }); setCustom(null); d.reload(); });
  const verify = useSubmit(async (id: string) => { await post(`/compliance/records/${id}/verify`); toast('Verified.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={6} />;
  const { property: p, requirements, records, actions, history, can } = d.data;
  const applicable = requirements.filter((r: any) => r.state !== 'not_applicable');
  const ok = applicable.filter((r: any) => ['in_date', 'due_soon'].includes(r.state)).length;
  return (
    <>
      {can.manage && <section className="card" aria-labelledby="cs-h"><h2 id="cs-h">Compliance settings</h2>
        <div className="form-grid">
          <Field label="Monitoring"><select value={p.compliance_enabled ? 'on' : 'off'} onChange={(e) => settings.run({ enabled: e.target.value === 'on' })}><option value="off">Off</option><option value="on">On</option></select></Field>
          <Field label="Classification"><select value={p.classification ?? ''} onChange={(e) => settings.run({ classification: e.target.value || null })}><option value="">Not classified</option>{Object.entries(CLASSIFICATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Framework"><select value={p.compliance_framework_id ?? ''} onChange={(e) => settings.run({ framework_id: e.target.value || null })}><option value="">Standard checklist</option>{fw.data?.frameworks.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
        </div>
        <ErrorSummary error={settings.error} />
        <p className="small muted">Only administrators can change these. Turning monitoring off keeps every record; it just stops counting and warning.</p>
      </section>}
      {!p.compliance_enabled ? <div className="notice">Compliance monitoring is off for this property.{requirements.length ? ' Its earlier records are kept.' : ''}</div> : <>
        <section className="card" aria-labelledby="cr-h">
          <div className="row between"><h2 id="cr-h">Compliance checklist</h2><span className="row"><span className="cp-score">{applicable.length ? `${Math.round((100 * ok) / applicable.length)}%` : '—'}</span><span className="small muted">{ok} of {applicable.length} in date</span></span></div>
          <div className="table-wrap"><table><thead><tr><th>Requirement</th><th>Responsible</th><th>Last done</th><th>Next due</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{requirements.map((r: any) => <tr key={r.id}>
              <td><button type="button" className="linkish" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{r.name}</button><div className="muted small">Every {r.interval_days} days{r.custom && ' · custom'}{r.not_applicable && ` · ${r.na_reason}`}</div>
                {open === r.id && <ul className="list small">{records.filter((x: any) => x.requirement_id === r.id).map((x: any) => <li key={x.id}><span>{fmtDate(x.completed_on)} · {label(x.outcome)} · by {x.done_by_text ?? x.recorded_by_name}{x.findings && ` — ${x.findings}`}<br /><span className="muted">Recorded by {x.recorded_by_name} {fmtDateTime(x.created_at)}{x.verified_at ? ` · verified by ${x.verified_by_name}` : ' · not verified'}</span></span>
                  <span className="row">{x.evidence_file_id && <button type="button" className="btn ghost" onClick={() => download(`/files/${x.evidence_file_id}`, x.evidence_name)}>Evidence</button>}{can.manage && !x.verified_at && <Button variant="secondary" busy={verify.busy} onClick={() => verify.run(x.id)}>Verify</Button>}</span></li>)}
                  {!records.some((x: any) => x.requirement_id === r.id) && <li className="muted">No records yet.</li>}{r.notes && <li>Notes: {r.notes}</li>}</ul>}</td>
              <td>{r.responsible_name ?? r.responsible_text ?? <span className="muted">Not set</span>}</td>
              <td>{r.last_done ? fmtDate(r.last_done) : '—'}</td><td>{fmtDate(r.next_due_on)}</td>
              <td><Status s={STATE[r.state][0]} text={STATE[r.state][1]} /></td>
              <td className="row" style={{ flexWrap: 'nowrap' }}>{can.record && !r.not_applicable && <Button variant="secondary" onClick={() => setRec({ req: r, completed_on: londonToday(), next_due_on: '', outcome: 'pass', done_by_text: '', findings: '', corrective_action: '', file: null })}>Record<span className="sr-only"> {r.name}</span></Button>}
                {(can.record || can.manage) && <Button variant="ghost" onClick={() => setEdit({ id: r.id, responsible_id: r.responsible_id, responsible_text: r.responsible_text, notes: r.notes, ...(can.manage ? { interval_days: r.interval_days, reminder_days: r.reminder_days, not_applicable: r.not_applicable, na_reason: r.na_reason } : {}) })}>Edit<span className="sr-only"> {r.name}</span></Button>}</td>
            </tr>)}</tbody></table></div>
          {can.manage && <Button variant="secondary" onClick={() => setCustom({ name: '', interval_days: 365, notes: '' })}>Add a custom requirement</Button>}
        </section>
        <section className="card" aria-labelledby="ca-h"><h2 id="ca-h">Corrective actions</h2>
          {actions.length === 0 ? <p className="muted">None.</p> : <ul className="list">{actions.map((x: any) => <li key={x.id}><Link to={`/governance/actions/${x.id}`}>{x.action}</Link><span className="small">{label(x.status)} · due {fmtDate(x.due_on)}</span></li>)}</ul>}
        </section>
      </>}
      <section className="card" aria-labelledby="ch-h"><h2 id="ch-h">Compliance history</h2>
        {history.length === 0 ? <p className="muted">No changes yet.</p> : <ul className="list small">{history.map((h: any, i: number) => <li key={i}><span><strong>{h.actor_name ?? 'System'}</strong> {({ enable: 'turned monitoring on', disable: 'turned monitoring off', update: 'changed settings', record: `recorded ${h.detail.requirement ?? 'a check'} (${h.detail.outcome})`, verify: 'verified a record', create: `added ${h.detail.name ?? 'a requirement'}`, retire: 'removed a requirement' } as Record<string, string>)[h.action] ?? label(h.action)}</span><span className="muted">{fmtDateTime(h.at)}</span></li>)}</ul>}
      </section>
      {rec && <Dialog open onClose={() => setRec(null)} title={`Record: ${rec.req.name}`} footer={<Button busy={saveRec.busy} onClick={() => saveRec.run()}>Save</Button>}>
        <ErrorSummary error={saveRec.error} />
        <div className="form-grid">
          <Field label="Date completed" error={saveRec.error?.fields.completed_on}><input type="date" max={londonToday()} value={rec.completed_on} onChange={(e) => setRec({ ...rec, completed_on: e.target.value })} /></Field>
          <Field label="Next due" optional hint={`Blank: ${rec.req.interval_days} days later.`} error={saveRec.error?.fields.next_due_on}><input type="date" value={rec.next_due_on} onChange={(e) => setRec({ ...rec, next_due_on: e.target.value })} /></Field>
        </div>
        <Field label="Outcome"><select value={rec.outcome} onChange={(e) => setRec({ ...rec, outcome: e.target.value })}><option value="pass">Pass</option><option value="advisory">Pass with advice</option><option value="fail">Fail</option></select></Field>
        <Field label="Done by" optional hint="Company or engineer."><input value={rec.done_by_text} onChange={(e) => setRec({ ...rec, done_by_text: e.target.value })} /></Field>
        <Field label="Findings" optional={rec.outcome === 'pass'} error={saveRec.error?.fields.findings}><textarea value={rec.findings} onChange={(e) => setRec({ ...rec, findings: e.target.value })} /></Field>
        {rec.outcome === 'fail' && <Field label="Corrective action needed" error={saveRec.error?.fields.corrective_action}><textarea value={rec.corrective_action} onChange={(e) => setRec({ ...rec, corrective_action: e.target.value })} /></Field>}
        <FilePicker label="Certificate or evidence" accept="application/pdf,image/*" onChange={(fs) => setRec({ ...rec, file: fs[0] ?? null })} />
      </Dialog>}
      {edit && <Dialog open onClose={() => setEdit(null)} title="Edit requirement" footer={<Button busy={saveEdit.busy} onClick={() => saveEdit.run()}>Save</Button>}>
        <ErrorSummary error={saveEdit.error} />
        <Field label="Responsible person" optional><select value={edit.responsible_id ?? ''} onChange={(e) => setEdit({ ...edit, responsible_id: e.target.value || null })}><option value="">None</option>{people.data?.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></Field>
        <Field label="Or responsible organisation" optional><input value={edit.responsible_text ?? ''} onChange={(e) => setEdit({ ...edit, responsible_text: e.target.value || null })} /></Field>
        <Field label="Notes" optional><textarea value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value || null })} /></Field>
        {'interval_days' in edit && <>
          <div className="form-grid">
            <Field label="Every (days)"><input type="number" min={1} max={3660} value={edit.interval_days} onChange={(e) => setEdit({ ...edit, interval_days: Number(e.target.value) })} /></Field>
            <Field label="Remind (days before due)"><input type="number" min={0} max={365} value={edit.reminder_days} onChange={(e) => setEdit({ ...edit, reminder_days: Number(e.target.value) })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={edit.not_applicable} onChange={(e) => setEdit({ ...edit, not_applicable: e.target.checked })} /> Not applicable to this property</label>
          {edit.not_applicable && <Field label="Why it does not apply" error={saveEdit.error?.fields.na_reason}><input value={edit.na_reason ?? ''} onChange={(e) => setEdit({ ...edit, na_reason: e.target.value || null })} /></Field>}
        </>}
      </Dialog>}
      {custom && <Dialog open onClose={() => setCustom(null)} title="Add a custom requirement" variant="modal" footer={<Button busy={addCustom.busy} onClick={() => addCustom.run()}>Add</Button>}>
        <ErrorSummary error={addCustom.error} />
        <Field label="Requirement"><input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Field>
        <Field label="Every (days)"><input type="number" min={1} max={3660} value={custom.interval_days} onChange={(e) => setCustom({ ...custom, interval_days: e.target.value })} /></Field>
      </Dialog>}
    </>
  );
}
