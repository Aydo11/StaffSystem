// Phase 3: agent scorecards, monthly reports (Excel and printable PDF), activity history, issue detection,
// bulk repair changes and per-person dashboard tiles. Figures come from recorded activity; gaps are shown as missing data.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, Printer, SlidersHorizontal } from 'lucide-react';
import { get, post, put, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, LoadError, Skeleton, Status, useToast } from '../ui.tsx';
import { save, xlsx } from '../xlsx.ts';
import { CATEGORIES } from '../../server/repairPriority.ts';

const RAG: Record<string, [string, string]> = { green: ['verified', 'Green'], amber: ['review', 'Amber'], red: ['action', 'Red'], none: ['normal', 'No data'] };
const thisMonth = () => londonToday().slice(0, 7);
const monthRange = (m: string) => { const [y, mo] = m.split('-').map(Number); const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); const t = londonToday(); return { from: `${m}-01`, to: end < t ? end : t }; };

// ── Per-person tile layout: which tiles show, saved on the server for this person ──
export function useTiles(key: string, all: string[]) {
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => { get(`/me/preferences/${key}`).then((r) => setHidden(r.value?.hidden ?? [])).catch(() => {}); }, [key]);
  const set = (h: string[]) => { setHidden(h); put(`/me/preferences/${key}`, { value: { hidden: h } }).catch(() => {}); };
  return { shown: (k: string) => !hidden.includes(k), hidden, set, all };
}
export function CustomiseTiles({ tiles, labels }: { tiles: ReturnType<typeof useTiles>; labels: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (<>
    <Button variant="secondary" onClick={() => setOpen(true)} aria-label="Customise figures"><SlidersHorizontal size={18} aria-hidden="true" /><span className="hide-sm">Customise</span></Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Figures to show" footer={<Button onClick={() => setOpen(false)}>Done</Button>}>
      <p className="muted small">Saved for you on every device. Others are not affected.</p>
      <ul className="list">{tiles.all.map((k) => <li key={k}><label className="row"><input type="checkbox" checked={tiles.shown(k)} onChange={(e) => tiles.set(e.target.checked ? tiles.hidden.filter((h) => h !== k) : [...tiles.hidden, k])} /> {labels[k] ?? label(k)}</label></li>)}</ul>
      <Button variant="secondary" onClick={() => tiles.set([])}>Show all</Button>
    </Dialog>
  </>);
}

// ── Managing-agent scorecards ──
export function Scorecards() {
  const hub = useHub();
  const [month, setMonth] = useState(thisMonth());
  const r = monthRange(month);
  const d = useApi<any>(`/scorecards${hub.q({ from: r.from, to: r.to })}`);
  const [edit, setEdit] = useState(false);
  const canEdit = hub.can('safety.manage') || hub.can('agents.manage');
  return (
    <section aria-labelledby="sc-h">
      <div className="rp-head"><div><h2 id="sc-h">Managing-agent scorecards</h2><p className="muted small">One card per managing agent, from the repairs, inspections, risks and actions recorded for their properties. “No data” means nothing was recorded — it is not a pass. Compliance counts monitored properties only.</p></div>
        <div className="rp-head-actions"><input type="month" aria-label="Month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />{canEdit && <Button variant="secondary" onClick={() => setEdit(true)}><SlidersHorizontal size={18} aria-hidden="true" />Thresholds</Button>}</div></div>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton lines={4} /> : d.data.cards.length === 0 ? <Empty>No properties to score.</Empty> : (
        <ul className="sc-grid">{d.data.cards.map((c: any) => <li key={`${c.company_id}${c.agent}`} className="card sc-card">
          <div className="row between"><h3 style={{ margin: 0 }}>{c.agent}</h3><span className="badge co">{c.company_code}</span></div>
          <p className="muted small">{c.properties} propert{c.properties === 1 ? 'y' : 'ies'} · {c.repairs_completed} repair{c.repairs_completed === 1 ? '' : 's'} completed · {fmtDate(d.data.from)} – {fmtDate(d.data.to)}</p>
          <dl className="sc-metrics">{Object.entries(d.data.metrics).map(([k, m]: [string, any]) => { const v = c.metrics[k]; return (
            <div key={k} className={`sc-m ${v.rag}`}><dt>{m.label}</dt><dd><strong>{v.value ?? '—'}</strong> <Status s={RAG[v.rag][0]} text={RAG[v.rag][1]} /></dd></div>); })}</dl>
          {c.monitored === 0 && <p className="muted small">No compliance-monitored properties in this group.</p>}
        </li>)}</ul>)}
      {edit && <ThresholdsDialog onClose={() => { setEdit(false); d.reload(); }} />}
    </section>
  );
}
function ThresholdsDialog({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/scorecards/settings${hub.q()}`);
  const editable = (d.data ?? []).filter((s) => s.can_edit);
  const [company, setCompany] = useState('');
  const cur = editable.find((s) => s.company_id === company) ?? editable[0];
  const [t, setT] = useState<Record<string, { green: number; amber: number }>>({});
  const val = (k: string) => t[k] ?? cur?.thresholds[k];
  const saveIt = useSubmit(async () => {
    await put('/scorecards/settings', { company_id: cur.company_id, thresholds: Object.fromEntries(Object.keys(cur.thresholds).map((k) => [k, { green: Number(val(k).green), amber: Number(val(k).amber) }])) });
    toast('Thresholds saved.'); onClose();
  });
  return (
    <Dialog open onClose={onClose} title="Red, amber and green thresholds" footer={<Button busy={saveIt.busy} disabled={!cur} onClick={() => saveIt.run()}>Save</Button>}>
      <ErrorSummary error={saveIt.error} />
      {!d.data ? <Skeleton /> : !cur ? <Empty>You cannot change thresholds for these companies.</Empty> : <>
        {editable.length > 1 && <Field label="Company"><select value={cur.company_id} onChange={(e) => { setCompany(e.target.value); setT({}); }}>{editable.map((s) => <option key={s.company_id} value={s.company_id}>{hub.co(s.company_id)?.name}</option>)}</select></Field>}
        <div className="table-wrap"><table><thead><tr><th>Measure</th><th>Green</th><th>Amber</th></tr></thead><tbody>
          {Object.entries(cur.thresholds).map(([k, m]: [string, any]) => <tr key={k}><td>{m.label}<div className="muted small">{m.better === 'high' ? 'Green at or above, amber at or above; otherwise red' : 'Green at or below, amber at or below; otherwise red'}</div></td>
            {(['green', 'amber'] as const).map((b) => <td key={b}><input type="number" min={0} aria-label={`${m.label} ${b}`} style={{ width: '6rem' }} value={val(k)[b]} onChange={(e) => setT({ ...t, [k]: { ...val(k), [b]: e.target.value as any } })} /></td>)}</tr>)}
        </tbody></table></div></>}
    </Dialog>
  );
}

// ── Monthly report: on screen, as Excel, and printable (save as PDF), all properties or one ──
const VERIFIED: Record<string, string> = { repairs_completed: 'Repairs completed', repairs_on_time: 'On time', repairs_verified: 'Repairs verified', repair_spend: 'Recorded spend', inspections: 'Inspections', inspection_fails: 'Failed items', risks_new: 'New risks', risks_closed: 'Risks closed', actions_opened: 'Actions opened', actions_verified: 'Actions verified', compliance_records: 'Compliance records', compliance_verified: 'Compliance verified' };
const OPEN: Record<string, string> = { repairs_open: 'Open repairs', repairs_overdue: 'Overdue repairs', risks_open: 'Open risks', actions_overdue: 'Overdue actions', compliance_overdue: 'Compliance overdue' };
const fmtCell = (k: string, v: any) => (k === 'repair_spend' ? money(v) : v);

export function MonthlyReports() {
  const hub = useHub();
  const [month, setMonth] = useState(thisMonth());
  const d = useApi<any>(`/safety/monthly${hub.q({ month })}`);
  const toast = useToast();
  const excel = useSubmit(async () => {
    const r = monthRange(month);
    const [repairs, inspections, actions] = await Promise.all([get<any[]>(`/repairs${hub.q()}`), get<any[]>(`/inspections${hub.q()}`), get<any[]>(`/safety/actions${hub.q()}`)]);
    const inMonth = (v?: string | null) => !!v && v.slice(0, 10) >= r.from && v.slice(0, 10) <= r.to;
    const ps = d.data.properties;
    const vk = Object.keys(ps[0]?.verified ?? {}), ok = Object.keys(ps[0]?.open ?? {});
    save(xlsx([
      { name: 'Summary', rows: [[`Property safety report ${month}`], ['Verified activity is what was recorded in the month. Missing data is listed separately and is not counted as a pass.'], [],
        ['Property', 'Ref', 'Company', 'Managing agent', ...vk.map((k) => VERIFIED[k]), ...ok.map((k) => OPEN[k]), 'Health (0-100)', 'Missing data'],
        ...ps.map((p: any) => [p.name, p.ref, p.company_code, p.agent, ...vk.map((k) => p.verified[k]), ...ok.map((k) => p.open[k]), p.health, p.missing.join('; ')])] },
      { name: 'Repairs', rows: [['Title', 'Property', 'Category', 'Priority', 'Stage', 'Reported', 'Target', 'Completed', 'Cost', 'Assigned'],
        ...repairs.filter((x) => inMonth(x.reported_on) || inMonth(x.completed_on) || !['verified', 'closed', 'cancelled'].includes(x.status)).map((x) => [x.title, x.property_name, x.category, x.urgency, x.status, x.reported_on, x.due_on, x.completed_on, x.cost == null ? null : Number(x.cost), x.assignee_name ?? x.agent_name ?? x.contractor])] },
      { name: 'Inspections', rows: [['Inspection', 'Property', 'When', 'By', 'Passed', 'Failed', 'N/A'], ...inspections.filter((i) => inMonth(i.inspected_at)).map((i) => [i.name, i.property_name, fmtDateTime(i.inspected_at), i.inspector_name, i.passed, i.failed, i.not_applicable])] },
      { name: 'Actions', rows: [['Action', 'Source', 'Property', 'Owner', 'Due', 'Status', 'Overdue'], ...actions.map((a) => [a.action, a.source_type, a.property_name, a.owner_name, a.due_on, a.status, a.overdue ? 'yes' : 'no'])] },
    ]), `property-safety-${month}.xlsx`);
    toast('Excel file saved.');
  });
  return (
    <section aria-labelledby="mr-h">
      <div className="rp-head"><div><h2 id="mr-h">Monthly report</h2><p className="muted small">What was done and verified in the month, what is still open, and — separately — what was not recorded.</p></div>
        <div className="rp-head-actions"><input type="month" aria-label="Month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <Button variant="secondary" busy={excel.busy} busyText="Preparing…" disabled={!d.data} onClick={() => excel.run()}><FileSpreadsheet size={18} aria-hidden="true" />Excel</Button>
          <Link className="btn secondary" to={`/estates/report?month=${month}`}><Printer size={18} aria-hidden="true" />PDF (all)</Link></div></div>
      <ErrorSummary error={excel.error} />
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton lines={5} /> : d.data.properties.length === 0 ? <Empty>No properties.</Empty> : <>
        <ul className="rp-kpis" aria-label="Month totals">
          {Object.entries(d.data.totals.verified).map(([k, v]) => <li key={k}><div className="rp-kpi" style={{ cursor: 'default' }}><span className="rp-kpi-value">{fmtCell(k, v)}</span><span className="rp-kpi-label">{VERIFIED[k]}</span></div></li>)}
          <li><div className={`rp-kpi ${d.data.totals.properties_with_missing_data ? 'warn' : ''}`} style={{ cursor: 'default' }}><span className="rp-kpi-value">{d.data.totals.properties_with_missing_data}</span><span className="rp-kpi-label">Properties with missing data</span><span className="rp-kpi-sub">{d.data.totals.properties_without_inspection} with no inspection</span></div></li>
        </ul>
        <div className="table-wrap"><table><thead><tr><th>Property</th><th>Done and verified</th><th>Still open</th><th>Missing data</th><th><span className="sr-only">PDF</span></th></tr></thead>
          <tbody>{d.data.properties.map((p: any) => <tr key={p.id}>
            <td><Link to={`/properties/${p.id}?tab=activity`}>{p.name}</Link><div className="muted small">{p.ref} · {p.agent}</div></td>
            <td className="small">{Object.entries(p.verified).filter(([, v]) => v).map(([k, v]) => `${VERIFIED[k]}: ${fmtCell(k, v)}`).join(' · ') || <span className="muted">Nothing recorded</span>}</td>
            <td className="small">{Object.entries(p.open).filter(([, v]) => v).map(([k, v]) => `${OPEN[k]}: ${v}`).join(' · ') || '—'}</td>
            <td className="small">{p.missing.length ? <ul className="plain">{p.missing.map((m: string) => <li key={m}>{m}</li>)}</ul> : '—'}</td>
            <td><Link className="btn secondary" to={`/estates/report?month=${month}&property=${p.id}`}>PDF<span className="sr-only"> for {p.name}</span></Link></td>
          </tr>)}</tbody></table></div></>}
    </section>
  );
}

// Printable report page. "Save as PDF" uses the browser's print dialog; each property starts on a new page.
export function PrintReport() {
  const [params] = useSearchParams();
  const month = params.get('month') ?? thisMonth();
  const property = params.get('property');
  const hub = useHub();
  const d = useApi<any>(`/safety/monthly${hub.q({ month, property })}`);
  const one = property && d.data?.properties[0];
  const tl = useApi<any[]>(property ? `/properties/${property}/timeline` : null);
  const r = monthRange(month);
  useEffect(() => { if (d.data) document.title = `Property safety ${month}${one ? ` – ${one.ref}` : ''}`; return () => { document.title = 'Hub'; }; }, [d.data, month, one]);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  return (
    <div className="report">
      <div className="no-print row between"><Link to="/estates?tab=reports">← Back to reports</Link><Button onClick={() => window.print()}><Printer size={18} aria-hidden="true" />Save as PDF</Button></div>
      <header className="report-head"><h1>Property safety report</h1><p>{fmtDate(d.data.from)} – {fmtDate(d.data.to)} · produced {fmtDateTime(new Date().toISOString())}</p>
        <p className="small">Counts come only from records in the Hub. Missing data is listed for each property and is never counted as a pass.</p></header>
      {d.data.properties.map((p: any) => <section key={p.id} className="report-prop">
        <h2>{p.name} <span className="muted">({p.ref} · {p.company_code})</span></h2>
        <p className="small">Managing agent: {p.agent} · Health score {p.health}/100</p>
        <div className="report-cols">
          <div><h3>Done and verified this month</h3><table><tbody>{Object.entries(p.verified).map(([k, v]) => <tr key={k}><th scope="row">{VERIFIED[k]}</th><td>{fmtCell(k, v)}</td></tr>)}</tbody></table></div>
          <div><h3>Still open today</h3><table><tbody>{Object.entries(p.open).map(([k, v]) => <tr key={k}><th scope="row">{OPEN[k]}</th><td>{v as any}</td></tr>)}</tbody></table></div>
        </div>
        <h3>Missing data</h3>{p.missing.length ? <ul>{p.missing.map((m: string) => <li key={m}>{m}</li>)}</ul> : <p>None.</p>}
        {one && tl.data && <><h3>Activity this month</h3>{(() => { const rows = tl.data.filter((t) => t.at.slice(0, 10) >= r.from && t.at.slice(0, 10) <= r.to); return rows.length ? <table><thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead><tbody>{rows.map((t, i) => <tr key={i}><td>{fmtDateTime(t.at)}</td><td>{t.title}</td><td>{t.detail ?? ''}</td></tr>)}</tbody></table> : <p>No activity recorded.</p>; })()}</>}
      </section>)}
    </div>
  );
}

// ── Activity history for one property ──
const KIND_TONE: Record<string, string> = { repair: 'info', inspection: 'verified', risk: 'action', action: 'review', check: 'normal', compliance: 'completed' };
export function Timeline({ propertyId }: { propertyId: string }) {
  const d = useApi<any[]>(`/properties/${propertyId}/timeline`);
  const [kind, setKind] = useState('');
  const rows = (d.data ?? []).filter((t) => !kind || t.kind === kind);
  return (
    <section className="card" aria-labelledby="tl-h">
      <div className="row between"><h2 id="tl-h">Activity history</h2>
        <select aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Everything</option>{Object.keys(KIND_TONE).map((k) => <option key={k} value={k}>{label(k)}s</option>)}</select></div>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton /> : rows.length === 0 ? <Empty>No activity recorded yet.</Empty> : (
        <ol className="tl">{rows.map((t, i) => <li key={i}><time dateTime={t.at}>{fmtDateTime(t.at)}</time><div><Status s={KIND_TONE[t.kind]} text={label(t.kind)} /> {t.link ? <Link to={t.link}>{t.title}</Link> : t.title}{t.detail && <div className="muted small">{label(t.detail)}</div>}</div></li>)}</ol>)}
    </section>
  );
}

// ── Issue detection ──
export function Insights() {
  const hub = useHub();
  const d = useApi<any>(`/safety/insights${hub.q()}`);
  if (d.error || !d.data) return null;
  const { repeat_categories: rep, slow_repairs: slow, recurring_failures: fail } = d.data;
  if (!rep.length && !slow.length && !fail.length) return <p className="notice small">No patterns found: no category repeated 3 times at a property in 90 days, no open repair at twice its target, no inspection question failed twice in 90 days.</p>;
  return (
    <section className="card insights" aria-labelledby="ins-h"><h3 id="ins-h">Issues detected</h3>
      <ul className="list">
        {rep.map((x: any) => <li key={`r${x.property_id}${x.category}`}><span><strong>Repeat repairs:</strong> {x.count} {label(x.category).toLowerCase()} repairs at <Link to={`/properties/${x.property_id}?tab=repairs`}>{x.property_name}</Link> in 90 days</span><Status s="review" text="Pattern" /></li>)}
        {slow.map((x: any) => <li key={`s${x.id}`}><span><strong>Long resolution:</strong> <Link to={`/estates/repairs/${x.id}`}>{x.title}</Link> at {x.property_name} — open {x.age_days} days against a {x.target_days}-day target</span><Status s="action" text="Slow" /></li>)}
        {fail.map((x: any) => <li key={`f${x.property_id}${x.key}`}><span><strong>Recurring failure:</strong> “{x.question}” failed {x.count} times at <Link to={`/properties/${x.property_id}?tab=safety`}>{x.property_name}</Link> in 90 days</span><Status s="action" text="Recurring" /></li>)}
      </ul>
    </section>
  );
}

// ── Bulk changes to selected repairs ──
export function BulkRepairs({ ids, onClose, onSaved }: { ids: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ contractor: '', due_on: '', category: '' });
  const run = useSubmit(async () => {
    const patch = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    const r = await post('/repairs/bulk', { ids, patch });
    toast(`${r.updated} repair${r.updated === 1 ? '' : 's'} updated.${r.skipped.length ? ` ${r.skipped.length} skipped: ${[...new Set(r.skipped.map((s: any) => s.reason))].join(', ')}.` : ''}`);
    onSaved();
  });
  return (
    <Dialog open onClose={onClose} title={`Change ${ids.length} repair${ids.length === 1 ? '' : 's'}`} footer={<Button busy={run.busy} disabled={!Object.values(f).some(Boolean)} onClick={() => run.run()}>Apply</Button>}>
      <ErrorSummary error={run.error} />
      <p className="muted small">Only the fields you fill in change. Closed or cancelled repairs and those you do not manage are skipped. Every change is recorded.</p>
      <Field label="Contractor" optional><input value={f.contractor} onChange={(e) => setF({ ...f, contractor: e.target.value })} /></Field>
      <Field label="Target date" optional><input type="date" value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></Field>
      <Field label="Category" optional><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">No change</option>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
    </Dialog>
  );
}
