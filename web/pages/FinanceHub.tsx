// Finance hub: overview KPIs and alerts, cash forecast with scenarios, daily operations, reports, bank and cash, and
// the plan. Every figure comes from the API in pence and can be opened to show the records behind it.
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, Skeleton, Status, useToast } from '../ui.tsx';
import { csv, save, xlsx } from '../xlsx.ts';

const gbp = (p?: number | null) => (p == null ? '—' : money(p / 100));
const pct = (x?: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
export const CAT: Record<string, string> = {
  rent: 'Rent (housing benefit / tenants)', service_charge: 'Service charges', support_income: 'Support income', grant: 'Grants', other_income: 'Other income',
  managing_agent_fee: 'Managing agent fee (Dawson)', provider_costs: 'Provider / partner costs', staffing: 'Staffing and payroll', property_rent: 'Rent paid to landlords', repairs_maintenance: 'Repairs and maintenance',
  utilities: 'Utilities', insurance: 'Insurance', office_admin: 'Office and admin', it_systems: 'IT and systems', professional_fees: 'Professional fees', travel: 'Travel', training: 'Training',
  bank_charges: 'Bank charges', interest: 'Interest', tax: 'Tax (VAT, PAYE, corporation tax)', other_expense: 'Other costs',
  loan_received: 'Loan received', loan_repayment: 'Loan repayment (principal)', capital_introduced: 'Capital introduced', dividends: 'Dividends', transfer: 'Transfer between accounts',
};
const INCOME = ['rent', 'service_charge', 'support_income', 'grant', 'other_income'];
export const DEPTS = ['housing', 'support', 'property', 'lettings', 'management', 'admin', 'compliance', 'finance'];
const catName = (c?: string | null) => (c ? CAT[c] ?? label(c) : 'Not categorised');
const monthName = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
// Chart colours: validated set (teal, blue, orange) on white; identity is never colour alone (legend + table view).
const C1 = 'var(--chart-1)', C2 = '#2a78d6', C3 = '#eb6834';

// ── Filters live in the URL, so a view can be bookmarked, shared or saved ──
export function useFinanceFilters() {
  const [params, setParams] = useSearchParams();
  const t = londonToday();
  const f = { from: params.get('from') ?? `${t.slice(0, 7)}-01`, to: params.get('to') ?? t, department: params.get('department') ?? '', property: params.get('property') ?? '', account: params.get('account') ?? '' };
  const set = (patchObj: Record<string, string>) => { const n = new URLSearchParams(params); for (const [k, v] of Object.entries(patchObj)) (v ? n.set(k, v) : n.delete(k)); setParams(n, { replace: true }); };
  const qs = (extra: Record<string, string> = {}) => Object.entries({ ...f, ...extra }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return { f, set, qs, params };
}
const PRESETS: [string, (t: string) => [string, string]][] = [
  ['This month', (t) => [`${t.slice(0, 7)}-01`, t]],
  ['Last month', (t) => { const d = new Date(`${t.slice(0, 7)}-01T12:00:00Z`); d.setUTCDate(0); return [`${d.toISOString().slice(0, 7)}-01`, d.toISOString().slice(0, 10)]; }],
  ['Year to date', (t) => [`${t.slice(0, 4)}-01-01`, t]],
  ['Plan year (from 1 Apr 2026)', () => ['2026-04-01', '2027-03-30']],
  ['Last 12 months', (t) => { const d = new Date(`${t}T12:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - 1); d.setUTCDate(d.getUTCDate() + 1); return [d.toISOString().slice(0, 10), t]; }],
];
export function FilterBar({ accounts, showAccount }: { accounts?: any[]; showAccount?: boolean }) {
  const hub = useHub();
  const toast = useToast();
  const { f, set, params } = useFinanceFilters();
  const props = useApi<any[]>(`/properties${hub.q()}`);
  const views = useApi<any[]>('/finance/views');
  const [naming, setNaming] = useState<string | null>(null);
  const saveView = useSubmit(async () => { await post('/finance/views', { name: naming, filters: Object.fromEntries([...params.entries()]) }); setNaming(null); toast('View saved.'); views.reload(); });
  return (
    <form className="card fh-filters" role="search" aria-label="Finance filters" onSubmit={(e) => e.preventDefault()}>
      <Field label="Period"><select name="preset" value="" onChange={(e) => { const p = PRESETS.find(([n]) => n === e.target.value); if (p) { const [from, to] = p[1](londonToday()); set({ from, to }); } }}>
        <option value="">Choose a period…</option>{PRESETS.map(([n]) => <option key={n}>{n}</option>)}</select></Field>
      <Field label="From"><input type="date" name="from" value={f.from} onChange={(e) => set({ from: e.target.value })} /></Field>
      <Field label="To"><input type="date" name="to" value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
      <details className="fh-more" open={!!(f.department || f.property || f.account) || undefined}><summary>More filters and saved views{(f.department || f.property || f.account) && ' (on)'}</summary><div className="fh-more-inner">
      <Field label="Department"><select name="department" value={f.department} onChange={(e) => set({ department: e.target.value })}><option value="">All</option>{DEPTS.map((d) => <option key={d} value={d}>{label(d)}</option>)}</select></Field>
      <Field label="Property (project)"><select name="property" value={f.property} onChange={(e) => set({ property: e.target.value })}><option value="">All</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      {showAccount && <Field label="Account"><select name="account" value={f.account} onChange={(e) => set({ account: e.target.value })}><option value="">All accounts</option>{accounts?.map((a) => <option key={a.id} value={a.id}>{a.company_code} · {a.name}</option>)}</select></Field>}
      <Field label="Currency" hint="Reported in GBP; foreign items use the rate recorded on the day."><select name="currency" value="GBP" disabled><option>GBP</option></select></Field>
      <div className="fh-views">
        <Field label="Saved views"><select name="view" value="" onChange={(e) => { const v = views.data?.find((x) => x.id === e.target.value); if (v) set({ ...Object.fromEntries(['from', 'to', 'department', 'property', 'account'].map((k) => [k, ''])), ...v.filters }); }}>
          <option value="">{views.data?.length ? 'Open a saved view…' : 'No saved views yet'}</option>{views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
        <Button variant="ghost" onClick={() => setNaming('')}>Save this view</Button>
      </div>
      </div></details>
      <Dialog open={naming !== null} onClose={() => setNaming(null)} title="Save this view" variant="modal" footer={<Button busy={saveView.busy} disabled={!naming?.trim()} onClick={() => saveView.run()}>Save</Button>}>
        <Field label="Name"><input name="view-name" value={naming ?? ''} onChange={(e) => setNaming(e.target.value)} placeholder="e.g. Plan year, housing" /></Field>
        {views.data && views.data.length > 0 && <ul className="list">{views.data.map((v) => <li key={v.id}><span>{v.name}</span><Button variant="ghost" onClick={async () => { await api('DELETE', `/finance/views/${v.id}`); views.reload(); }}>Delete</Button></li>)}</ul>}
      </Dialog>
    </form>
  );
}

// ── Drill-down: the records behind any figure; the total always equals the figure ──
export function Drill({ metric, title, onClose }: { metric: string | null; title: string; onClose: () => void }) {
  const hub = useHub();
  const { qs } = useFinanceFilters();
  const d = useApi<any>(metric ? `/finance/hub/drill?${qs({ metric, company: hub.company !== 'all' ? hub.company : '' })}` : null);
  const rows = d.data?.rows ?? [];
  const sheet = () => [['Date', 'Type', 'Description', 'Category', 'Amount (£)'], ...rows.map((r: any) => [r.date, r.type, r.description, catName(r.category), r.amount / 100]), ['', '', 'Total', '', (d.data?.total ?? 0) / 100]];
  return (
    <Dialog open={!!metric} onClose={onClose} title={title}>
      {d.error ? <LoadError error={d.error} /> : !d.data ? <Skeleton /> : rows.length === 0 ? <Empty>No records behind this figure for the period and filters chosen.</Empty> : (
        <>
          <div className="row between"><p className="small" role="status">{rows.length} record{rows.length === 1 ? '' : 's'} · total <strong>{gbp(d.data.total)}</strong></p>
            <span className="row"><Button variant="secondary" onClick={() => save(xlsx([{ name: title, rows: sheet() }]), `${title}.xlsx`)}>Excel</Button><Button variant="ghost" onClick={() => save(csv(sheet()), `${title}.csv`)}>CSV</Button></span></div>
          <div className="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Record</th><th scope="col">Category</th><th scope="col" className="num">Amount</th></tr></thead>
            <tbody>{rows.map((r: any) => <tr key={`${r.type}-${r.id}`}><td>{fmtDate(r.date)}</td><td>{r.link ? <Link to={r.link}>{r.description}</Link> : r.description}<br /><span className="small muted">{r.type === 'transaction' ? 'Bank / cash item' : r.type === 'document' ? 'Invoice or bill' : r.type === 'plan' ? 'Plan line (forecast)' : r.type}</span></td><td className="small">{catName(r.category)}</td><td className="num">{gbp(r.amount)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row" colSpan={3}>Total</th><td className="num"><strong>{gbp(d.data.total)}</strong></td></tr></tfoot></table></div>
        </>
      )}
    </Dialog>
  );
}

// ── KPI card ──
const DEF: Record<string, [string, string]> = {
  revenue: ['Revenue', 'Accrual basis: invoices and payment statements issued in the period (excluding VAT), less credit notes, plus categorised income received with no invoice.'],
  gross_profit: ['Gross profit', 'Revenue less direct delivery costs: Dawson fee, provider/partner costs and rent paid to landlords.'],
  net_profit: ['Net profit', 'Revenue less all costs in the period (accrual). Loans, transfers and dividends are not costs. Uncategorised bank items are left out until categorised.'],
  operating_expenses: ['Operating expenses', 'Costs other than direct delivery costs: staffing, office, insurance, IT, travel and so on.'],
  variance_net: ['Profit v budget', 'Net profit less the plan for the same dates. The plan is spread evenly across each 4-week period.'],
  cash_balance: ['Cash balance', 'Sum of bank, savings, cash and card accounts: opening balance plus every transaction up to the end date.'],
  available_cash: ['Available cash', 'Cash balance less your minimum cash buffer, bills due in the next 14 days and committed payments in the next 14 days.'],
  burn_rate: ['Burn rate', 'Average monthly operating cash outflow over the last three full months (zero when more came in than went out).'],
  runway_months: ['Cash runway', 'Months the cash balance would last at the burn rate.'],
  receivables: ['Owed to you', 'Unpaid balance on issued invoices and payment statements (after part payments and credit notes).'],
  payables: ['You owe', 'Unpaid balance on approved bills, contractor invoices and expense claims.'],
  overdue_receivables: ['Overdue invoices', 'Owed to you and past the due date.'],
  upcoming_payments: ['Due in 14 days', 'Bills due in the next 14 days plus committed payments (payroll, tax, loans, bills).'],
  dso: ['Collection time', 'Days sales outstanding: owed to you ÷ revenue in the last 90 days × 90.'],
  dpo: ['Payment time', 'Days payables outstanding: you owe ÷ bills in the last 90 days × 90.'],
  working_capital: ['Working capital', 'Cash + owed to you − you owe.'],
  ccc: ['Cash conversion cycle', 'Collection time − payment time (no stock is held).'],
};
function Kpi({ k, value, prev, budget, kind = 'money', better = 'up', onOpen, extra }: { k: string; value: number | null; prev?: number | null; budget?: number | null; kind?: 'money' | 'pct' | 'days' | 'months'; better?: 'up' | 'down'; onOpen?: () => void; extra?: ReactNode }) {
  const [name, def] = DEF[k] ?? [label(k), ''];
  const fmt = (v: number | null | undefined) => (v == null ? '—' : kind === 'money' ? gbp(v) : kind === 'pct' ? pct(v) : kind === 'days' ? `${v} days` : `${v} months`);
  const delta = value != null && prev != null && prev !== 0 ? (value - prev) / Math.abs(prev) : null;
  const good = delta == null ? null : better === 'up' ? delta >= 0 : delta <= 0;
  const body = (
    <>
      <span className="fh-kpi-label">{name}</span>
      <strong className="fh-kpi-value">{fmt(value)}</strong>
      {delta != null && <span className={`fh-delta ${good ? 'up' : 'down'}`}><span aria-hidden="true">{delta >= 0 ? '▲' : '▼'}</span> {Math.abs(delta * 100).toFixed(0)}% <span className="sr-only">{delta >= 0 ? 'up' : 'down'}</span> v previous ({fmt(prev)})</span>}
      {budget != null && <span className="fh-vs">Budget {fmt(budget)}</span>}
      {extra}
    </>
  );
  return (
    <li className="fh-kpi">
      {onOpen ? <button type="button" onClick={onOpen} aria-describedby={`def-${k}`}>{body}</button> : <div aria-describedby={`def-${k}`}>{body}</div>}
      <details className="fh-def"><summary aria-label={`How ${name.toLowerCase()} is worked out`}>?</summary><p id={`def-${k}`}>{def}</p></details>
    </li>
  );
}

// ── Charts (SVG): one £ axis, thin bars, hover tooltip, legend, and a table view for every chart ──
type Series = { name: string; color: string; values: (number | null)[]; dashed?: boolean };
function niceMax(v: number) { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / e) * e; }
function ChartFrame({ title, labels, series, children, note }: { title: string; labels: string[]; series: Series[]; children: ReactNode; note?: ReactNode }) {
  return (
    <figure className="fh-chart">
      <figcaption><strong>{title}</strong></figcaption>
      {series.length > 1 && <ul className="fh-legend">{series.map((s) => <li key={s.name}><span className={`fh-swatch ${s.dashed ? 'dashed' : ''}`} style={{ background: s.dashed ? 'none' : s.color, borderColor: s.color }} aria-hidden="true" />{s.name}</li>)}</ul>}
      {children}
      {note && <p className="small muted">{note}</p>}
      <details className="fh-table-view"><summary>Show as a table</summary><div className="table-wrap"><table><thead><tr><th scope="col">Period</th>{series.map((s) => <th key={s.name} scope="col" className="num">{s.name}</th>)}</tr></thead>
        <tbody>{labels.map((l, i) => <tr key={l + i}><th scope="row">{l}</th>{series.map((s) => <td key={s.name} className="num">{gbp(s.values[i])}</td>)}</tr>)}</tbody></table></div></details>
    </figure>
  );
}
export function Bars({ title, labels, series, onPick, note }: { title: string; labels: string[]; series: Series[]; onPick?: (i: number) => void; note?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 220, L = 64, B = 28, all = series.flatMap((s) => s.values.map((v) => v ?? 0));
  const max = niceMax(Math.max(0, ...all)), min = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
  const y = (v: number) => 8 + ((max - v) / (max - min || 1)) * (H - B - 8);
  const gw = (W - L) / Math.max(labels.length, 1), bw = Math.max(3, Math.min(18, (gw - 8) / series.length - 2));
  return (
    <ChartFrame title={title} labels={labels} series={series} note={note}>
      <div className="fh-svg-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. Use “Show as a table” for the figures.`}>
          {[max, (max + min) / 2, min].map((v) => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="fh-grid" /><text x={L - 6} y={y(v) + 4} className="fh-axis" textAnchor="end">{gbp(v).replace('.00', '')}</text></g>)}
          {labels.map((l, i) => (
            <g key={l + i}>
              {series.map((s, j) => { const v = s.values[i] ?? 0, x = L + i * gw + (gw - series.length * (bw + 2)) / 2 + j * (bw + 2); return <rect key={s.name} x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={2} fill={s.color} />; })}
              {(i % Math.ceil(labels.length / 12) === 0) && <text x={L + i * gw + gw / 2} y={H - 8} className="fh-axis" textAnchor="middle">{l}</text>}
              <rect x={L + i * gw} y={0} width={gw} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => onPick?.(i)} style={{ cursor: onPick ? 'pointer' : undefined }} />
            </g>
          ))}
          <line x1={L} x2={W} y1={y(0)} y2={y(0)} className="fh-zero" />
        </svg>
        {hover != null && <div className="fh-tip" style={{ left: `${((L + hover * gw + gw / 2) / W) * 100}%` }}><strong>{labels[hover]}</strong>{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}: {gbp(s.values[hover])}</span>)}{onPick && <em>Click to see the records</em>}</div>}
      </div>
    </ChartFrame>
  );
}
export function Lines({ title, labels, series, threshold, note }: { title: string; labels: string[]; series: Series[]; threshold?: number; note?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 240, L = 72, B = 28, all = [...series.flatMap((s) => s.values.filter((v): v is number => v != null)), threshold ?? 0, 0];
  const max = niceMax(Math.max(...all)), min = Math.min(...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
  const y = (v: number) => 8 + ((max - v) / (max - min || 1)) * (H - B - 8);
  const x = (i: number) => L + (labels.length < 2 ? 0 : (i / (labels.length - 1)) * (W - L - 12));
  const withT = threshold != null ? [...series, { name: 'Minimum cash', color: 'var(--text-2)', values: labels.map(() => threshold), dashed: true }] : series;
  return (
    <ChartFrame title={title} labels={labels} series={withT} note={note}>
      <div className="fh-svg-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. Use “Show as a table” for the figures.`}>
          {[max, (max + min) / 2, min].map((v) => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="fh-grid" /><text x={L - 6} y={y(v) + 4} className="fh-axis" textAnchor="end">{gbp(v).replace('.00', '')}</text></g>)}
          {min < 0 && <line x1={L} x2={W} y1={y(0)} y2={y(0)} className="fh-zero" />}
          {threshold != null && <line x1={L} x2={W} y1={y(threshold)} y2={y(threshold)} className="fh-threshold" />}
          {series.map((s) => <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '6 4' : undefined} points={s.values.map((v, i) => (v == null ? '' : `${x(i)},${y(v)}`)).join(' ')} />)}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={8} y2={H - B} className="fh-cross" />}
          {hover != null && series.map((s) => s.values[hover] != null && <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />)}
          {labels.map((l, i) => <g key={l + i}>{(i % Math.ceil(labels.length / 7) === 0) && <text x={x(i)} y={H - 8} className="fh-axis" textAnchor="middle">{l}</text>}<rect x={x(i) - (W - L) / labels.length / 2} y={0} width={(W - L) / labels.length} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} /></g>)}
        </svg>
        {hover != null && <div className="fh-tip" style={{ left: `${(x(hover) / W) * 100}%` }}><strong>{labels[hover]}</strong>{withT.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}: {gbp(s.values[hover])}</span>)}</div>}
      </div>
    </ChartFrame>
  );
}
function HBars({ rows, onPick }: { rows: { key: string; name: string; value: number; sub?: string }[]; onPick?: (k: string) => void }) {
  if (!rows.length) return <Empty>Nothing to show for this period.</Empty>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return <ul className="fh-hbars">{rows.map((r) => (
    <li key={r.key}><button type="button" onClick={() => onPick?.(r.key)} disabled={!onPick}>
      <span className="fh-hb-label">{r.name}</span><span className="fh-hb-track" aria-hidden="true"><span style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} /></span><span className="fh-hb-val">{gbp(r.value)}{r.sub && <small> {r.sub}</small>}</span>
    </button></li>))}</ul>;
}

// ── Overview: urgent first, then KPIs, then trends, then detail ──
export function Overview({ go }: { go: (tab: string, extra?: Record<string, string>) => void }) {
  const hub = useHub();
  const { qs, f } = useFinanceFilters();
  const d = useApi<any>(`/finance/hub?${qs({ company: hub.company !== 'all' ? hub.company : '' })}`);
  const [drill, setDrill] = useState<[string, string] | null>(null);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  const h = d.data;
  const k = h?.kpis, pv = h?.previous;
  const open = (m: string, t: string) => () => setDrill([m, t]);
  const months = h?.trend.map((x: any) => monthName(x.month)) ?? [];
  const exportAll = () => save(xlsx([
    { name: 'KPIs', rows: [['Figure', 'This period', 'Previous period', 'Budget'], ...Object.keys(DEF).map((key) => [DEF[key][0], k[key] ?? null, pv[key] ?? null, key === 'net_profit' ? k.budget_net : null].map((v, i) => (i && typeof v === 'number' && !['dso', 'dpo', 'ccc', 'runway_months'].includes(key) ? v / 100 : v)))] },
    { name: 'Trend', rows: [['Month', 'Revenue', 'Costs', 'Net profit', 'Cash in', 'Cash out', 'Plan net'], ...h.trend.map((x: any) => [x.month, x.revenue / 100, x.expenses / 100, x.net / 100, x.cash_in / 100, x.cash_out / 100, x.plan_net / 100])] },
    { name: 'Budget v actual', rows: [['Category', 'Budget', 'Actual', 'Variance'], ...h.budget_by_category.map((x: any) => [catName(x.category), x.budget / 100, x.actual / 100, (x.actual - x.budget) / 100])] },
  ]), `finance-overview-${f.from}-to-${f.to}.xlsx`);
  return (
    <>
      <FilterBar />
      {!h ? <Skeleton lines={8} /> : (
        <>
          <p className="small muted fh-basis">{fmtDate(f.from)} to {fmtDate(f.to)} · compared with {fmtDate(h.previous_range.from)} to {fmtDate(h.previous_range.to)} · profit on an <strong>accrual</strong> basis, cash on a <strong>cash</strong> basis · GBP
            {h.accounts.length > 0 && <> · bank data to {fmtDate(h.accounts.map((a: any) => a.last_txn).filter(Boolean).sort().at(-1) ?? null)}</>}
            <span className="row" style={{ display: 'inline-flex', marginLeft: 8 }}><Button variant="ghost" onClick={exportAll}>Excel</Button><Button variant="ghost" onClick={() => window.print()}>PDF</Button></span></p>
          {h.alerts.length > 0 && (
            <section aria-labelledby="fh-alerts" className="fh-alerts"><h2 id="fh-alerts" className="sr-only">Needs attention</h2>
              <ul>{h.alerts.map((a: any, i: number) => <li key={i} className={`notice ${a.level === 'bad' ? 'bad' : a.level === 'warn' ? 'warn' : ''}`}>{a.text}{' '}
                {a.metric && <Button variant="ghost" onClick={open(a.metric, a.text)}>Show</Button>}{a.tab && <Button variant="ghost" onClick={() => go(a.tab)}>Set up</Button>}</li>)}</ul>
            </section>
          )}
          <h2 className="fh-group">Profit</h2>
          <ul className="fh-kpis">
            <Kpi k="revenue" value={k.revenue} prev={pv.revenue} budget={k.budget_income} onOpen={open('revenue', 'Revenue')} />
            <Kpi k="gross_profit" value={k.gross_profit} prev={pv.gross_profit} budget={k.budget_income - k.budget_direct} onOpen={open('direct_costs', 'Direct costs')} extra={<span className="fh-vs">Margin {pct(k.gross_margin)}</span>} />
            <Kpi k="operating_expenses" value={k.operating_expenses} prev={pv.operating_expenses} budget={k.budget_expenses - k.budget_direct} better="down" onOpen={open('operating_expenses', 'Operating expenses')} />
            <Kpi k="net_profit" value={k.net_profit} prev={pv.net_profit} budget={k.budget_net} onOpen={open('expenses', 'All costs')} extra={<span className="fh-vs">Margin {pct(k.net_margin)}</span>} />
            <Kpi k="variance_net" value={k.variance_net} onOpen={open('budget', 'Plan lines for these dates')} />
          </ul>
          <h2 className="fh-group">Cash</h2>
          <ul className="fh-kpis">
            <Kpi k="cash_balance" value={k.cash_balance} onOpen={open('cash_in', 'Money in')} extra={k.cash_balance == null && <span className="fh-vs">No accounts set up</span>} />
            <Kpi k="available_cash" value={k.available_cash} extra={<span className="fh-vs">Minimum buffer {gbp(k.min_cash)}</span>} />
            <Kpi k="burn_rate" value={k.burn_rate} prev={pv.burn_rate} better="down" onOpen={open('cash_out', 'Money out')} extra={k.burn_rate == null && <span className="fh-vs">Needs 3 months of bank data</span>} />
            <Kpi k="runway_months" value={k.runway_months} kind="months" extra={k.burn_rate === 0 && <span className="fh-vs">Cash is not falling</span>} />
          </ul>
          <h2 className="fh-group">Owed and owing</h2>
          <ul className="fh-kpis">
            <Kpi k="receivables" value={k.receivables} onOpen={open('receivables', 'Owed to you')} />
            <Kpi k="overdue_receivables" value={k.overdue_receivables} better="down" onOpen={open('overdue_receivables', 'Overdue invoices')} extra={<span className="fh-vs">{k.overdue_count} invoice{k.overdue_count === 1 ? '' : 's'}</span>} />
            <Kpi k="payables" value={k.payables} onOpen={open('payables', 'You owe')} />
            <Kpi k="upcoming_payments" value={k.upcoming_payments} onOpen={() => go('daily')} />
            <Kpi k="working_capital" value={k.working_capital} />
            <Kpi k="dso" value={k.dso} kind="days" better="down" />
            <Kpi k="dpo" value={k.dpo} kind="days" />
            <Kpi k="ccc" value={k.ccc} kind="days" better="down" />
          </ul>
          <div className="grid-2">
            <section className="card"><Bars title="Revenue, costs and net profit by month (accrual)" labels={months} onPick={(i) => setDrill(['revenue', `Revenue in ${months[i]}`])}
              series={[{ name: 'Revenue', color: C1, values: h.trend.map((x: any) => x.revenue) }, { name: 'Costs', color: C3, values: h.trend.map((x: any) => x.expenses) }, { name: 'Net profit', color: C2, values: h.trend.map((x: any) => x.net) }]}
              note="Bars before any invoices or bank data was recorded are empty, not zero results." /></section>
            <section className="card"><Bars title="Cash in and cash out by month" labels={months}
              series={[{ name: 'Cash in', color: C1, values: h.trend.map((x: any) => x.cash_in) }, { name: 'Cash out', color: C3, values: h.trend.map((x: any) => x.cash_out) }]} note="Transfers between your own accounts are left out." /></section>
            <section className="card"><Bars title="Profit against plan by month" labels={months}
              series={[{ name: 'Actual net', color: C1, values: h.trend.map((x: any) => x.net) }, { name: 'Plan net', color: C2, values: h.trend.map((x: any) => x.plan_net) }]} note={h.plans[0] && `Plan: ${h.plans[0].name}.`} /></section>
            <section className="card"><h3 className="fh-h3">Costs by category</h3>
              <HBars rows={h.budget_by_category.filter((x: any) => !x.income && x.actual).map((x: any) => ({ key: x.category, name: catName(x.category), value: -x.actual })).sort((a: any, z: any) => z.value - a.value)} onPick={(c) => setDrill([`category:${c}`, catName(c)])} /></section>
          </div>
          <section className="card"><h2>Budget against actual</h2>
            <p className="small muted">For the dates chosen. Budget is the plan spread over each 4-week period; actual is on the accrual basis. Click a row for its records.</p>
            <BudgetTable rows={h.budget_by_category} onPick={(c) => setDrill([`category:${c}`, catName(c)])} />
            <h3 className="fh-h3">Spending by department</h3>
            <div className="table-wrap"><table><thead><tr><th scope="col">Department</th><th scope="col" className="num">Budget</th><th scope="col" className="num">Actual</th><th scope="col" className="num">Variance</th></tr></thead>
              <tbody>{h.budget_by_department.map((x: any) => { const over = x.budget > 0 && x.actual > x.budget * 1.1 && x.actual - x.budget > 10000; return <tr key={x.department}><td>{label(x.department)}</td><td className="num">{gbp(x.budget)}</td><td className="num">{gbp(x.actual)}</td><td className="num">{over ? <strong className="fh-bad">{gbp(x.actual - x.budget)} over</strong> : <span className={x.actual > x.budget ? 'fh-bad' : undefined}>{gbp(x.budget - x.actual)}</span>}</td></tr>; })}</tbody></table></div>
          </section>
          <div className="grid-2">
            <section className="card"><Aging title="Owed to you by age" rows={h.aging.receivable} /></section>
            <section className="card"><Aging title="You owe by age" rows={h.aging.payable} /></section>
          </div>
        </>
      )}
      <Drill metric={drill?.[0] ?? null} title={drill?.[1] ?? ''} onClose={() => setDrill(null)} />
    </>
  );
}
function BudgetTable({ rows, onPick }: { rows: any[]; onPick: (c: string) => void }) {
  const sorted = [...rows].sort((a, z) => Number(z.income) - Number(a.income) || a.category.localeCompare(z.category));
  if (!sorted.length) return <Empty>No plan or actuals for these dates.</Empty>;
  return <div className="table-wrap"><table><thead><tr><th scope="col">Category</th><th scope="col" className="num">Budget</th><th scope="col" className="num">Actual</th><th scope="col" className="num">Variance</th><th scope="col" className="num">% of budget</th></tr></thead>
    <tbody>{sorted.map((x) => { const b = x.income ? x.budget : -x.budget, a = x.income ? x.actual : -x.actual, v = x.income ? a - b : b - a, over = !x.income && a > b * 1.1 && a - b > 10000;
      return <tr key={x.category}><td><button type="button" className="linkish" onClick={() => onPick(x.category)}>{catName(x.category)}</button>{x.income ? <span className="sr-only"> (income)</span> : null}</td><td className="num">{gbp(b)}</td><td className="num">{gbp(a)}</td>
        <td className="num">{over ? <strong className="fh-bad">{gbp(v)} <span aria-hidden="true">▲</span> over</strong> : <span className={v < 0 ? 'fh-bad' : undefined}>{gbp(v)}</span>}</td><td className="num">{b ? `${Math.round((a / b) * 100)}%` : '—'}</td></tr>; })}</tbody></table></div>;
}
function Aging({ title, rows }: { title: string; rows: any[] }) {
  return <><h3 className="fh-h3">{title}</h3><HBars rows={rows.map((r) => ({ key: r.key, name: r.label, value: r.amount, sub: `(${r.count})` }))} /></>;
}

// ── Cash and forecast ──
const SC: [string, string, string][] = [['base', 'Base', C1], ['optimistic', 'Optimistic', C2], ['pessimistic', 'Pessimistic', C3]];
const TYPES: [string, string][] = [['committed', 'Committed'], ['estimate', 'Estimate'], ['plan', 'Plan'], ['assumption', 'Assumption']];
export function Forecast({ go }: { go: (tab: string) => void }) {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.view'));
  const company = hub.company !== 'all' && hub.can('finance.view', hub.company) ? hub.company : cos.find((c) => c.code === 'VH')?.id ?? cos[0]?.id;
  const d = useApi<any>(company ? `/finance/forecast?company=${company}` : null);
  const [view, setView] = useState<'weeks' | 'months'>('weeks');
  const [scn, setScn] = useState('base');
  const [edit, setEdit] = useState<any>(null);
  const manage = hub.can('finance.manage', company);
  const saveSet = useSubmit(async () => { await api('PUT', '/finance/hub/settings', { company_id: company, ...edit }); setEdit(null); toast('Forecast assumptions saved.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const r = d.data.results, rows = r[scn][view];
  const labels = r.base[view].map((x: any) => (view === 'weeks' ? fmtDate(x.start).replace(/ \d{4}$/, '') : monthName(x.start)));
  const sheet = (k: string) => [['From', 'To', 'Opening', ...TYPES.map(([, t]) => `In: ${t}`), ...TYPES.map(([, t]) => `Out: ${t}`), 'Net', 'Closing'], ...r[k][view].map((x: any) => [x.start, x.end, x.opening / 100, ...TYPES.map(([t]) => x.inflow[t] / 100), ...TYPES.map(([t]) => -x.outflow[t] / 100), x.net / 100, x.closing / 100])];
  return (
    <>
      <div className="row between fh-toolbar">
        <div className="row"><span className="small">{cos.find((c) => c.id === company)?.name}</span>
          <div role="group" aria-label="Forecast length" className="fh-seg">{[['weeks', '13 weeks'], ['months', '12 months']].map(([k, t]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k as any)}>{t}</button>)}</div></div>
        <span className="row">{manage && <Button variant="secondary" onClick={() => setEdit({ min_cash: (d.data.min_cash / 100).toFixed(2), scenarios: JSON.parse(JSON.stringify(d.data.scenarios)) })}>Edit assumptions</Button>}
          <Button variant="ghost" onClick={() => save(xlsx(SC.map(([k, n]) => ({ name: `${n} ${view}`, rows: sheet(k) }))), `cash-forecast-${view}.xlsx`)}>Excel</Button><Button variant="ghost" onClick={() => window.print()}>PDF</Button></span>
      </div>
      {!d.data.opening_set && <p className="notice warn"><strong>Opening cash not set.</strong> Balances below start from £0 and show movement only. <Button variant="ghost" onClick={() => go('bank')}>Add your bank accounts</Button></p>}
      <ul className="fh-kpis">
        {SC.map(([k, n]) => { const x = r[k]; return <li key={k} className="fh-kpi"><div><span className="fh-kpi-label">{n}: lowest balance</span><strong className="fh-kpi-value">{gbp(x.lowest.amount)}</strong><span className="fh-vs">by {fmtDate(x.lowest.date)}</span>
          {x.first_below_min ? <span className="fh-delta down">Below the minimum by {fmtDate(x.first_below_min)}</span> : <span className="fh-delta up">Stays above the minimum</span>}</div></li>; })}
      </ul>
      <section className="card"><Lines title={`Projected closing cash, ${view === 'weeks' ? 'next 13 weeks' : 'next 12 months'}`} labels={labels} threshold={d.data.min_cash}
        series={SC.map(([k, n, c]) => ({ name: n, color: c, values: r[k][view].map((x: any) => x.closing) }))}
        note={<>Opening {gbp(d.data.opening ?? 0)}{d.data.opening_set ? ' from your accounts today' : ' (not set)'}. Committed: unpaid invoices, bills and committed commitments. Estimate: commitments marked estimate. Plan: the 2.4 plan, only for the part not already received or covered by committed items. Assumption: one-offs you typed in.</>} /></section>
      <section className="card">
        <div className="row between"><h2>{view === 'weeks' ? '13-week' : '12-month'} cash forecast</h2>
          <div role="group" aria-label="Scenario" className="fh-seg">{SC.map(([k, n]) => <button key={k} type="button" aria-pressed={scn === k} onClick={() => setScn(k)}>{n}</button>)}</div></div>
        <p className="small muted">Scenario assumptions: collections {d.data.scenarios[scn].collect_delay_days} days late, revenue {d.data.scenarios[scn].revenue_pct}% , costs {d.data.scenarios[scn].cost_pct}%{d.data.scenarios[scn].one_offs.length ? `, ${d.data.scenarios[scn].one_offs.length} one-off item(s)` : ''}. Percentages apply to plan and estimate figures only, never to committed amounts.</p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Cash forecast table"><table className="fh-forecast"><thead><tr><th scope="col">Period</th><th scope="col" className="num">Opening</th>{TYPES.map(([, t]) => <th key={t} scope="col" className="num">In · {t}</th>)}{TYPES.map(([, t]) => <th key={t} scope="col" className="num">Out · {t}</th>)}<th scope="col" className="num">Net</th><th scope="col" className="num">Closing</th></tr></thead>
          <tbody>{rows.map((x: any) => <tr key={x.start} className={x.closing < d.data.min_cash ? 'fh-short' : undefined}><th scope="row">{fmtDate(x.start)} – {fmtDate(x.end)}</th><td className="num">{gbp(x.opening)}</td>
            {TYPES.map(([t]) => <td key={`i${t}`} className="num">{x.inflow[t] ? gbp(x.inflow[t]) : '–'}</td>)}{TYPES.map(([t]) => <td key={`o${t}`} className="num">{x.outflow[t] ? gbp(-x.outflow[t]) : '–'}</td>)}
            <td className="num">{gbp(x.net)}</td><td className="num"><strong>{gbp(x.closing)}</strong>{x.closing < d.data.min_cash && <span className="fh-bad"> below minimum</span>}</td></tr>)}</tbody></table></div>
      </section>
      <div className="grid-2">
        <section className="card"><h2>Plan against actual, by plan period</h2>
          <p className="small muted">Cash basis. Actual is what went through your bank and cash accounts.</p>
          {d.data.plan_vs_actual.length === 0 ? <Empty>No plan periods have started.</Empty> : (
            <div className="table-wrap"><table><thead><tr><th scope="col">Period</th><th scope="col" className="num">Plan net</th><th scope="col" className="num">Actual net</th><th scope="col" className="num">Difference</th></tr></thead>
              <tbody>{d.data.plan_vs_actual.map((x: any) => <tr key={x.company_id + x.period}><th scope="row">{x.period} <span className="small muted">{fmtDate(x.start)}{!x.complete && ' (so far)'}</span></th><td className="num">{gbp(x.plan_net)}</td><td className="num">{d.data.opening_set ? gbp(x.actual_net) : '—'}</td><td className="num">{d.data.opening_set ? gbp(x.actual_net - x.plan_net) : 'No bank data'}</td></tr>)}</tbody></table></div>
          )}
        </section>
        <section className="card"><h2>Known items in the base forecast</h2>
          {(r.base.events ?? []).length === 0 ? <Empty>No invoices, bills or commitments ahead. The forecast is the plan only.</Empty> : (
            <ul className="list">{r.base.events.slice(0, 40).map((e: any, i: number) => <li key={i}><span>{fmtDate(e.date)} · {e.label}<br /><span className="small muted">{catName(e.category)}</span></span><span className="row"><Status s={e.type === 'committed' ? 'info' : 'review'} text={label(e.type)} /><strong>{gbp(e.amount)}</strong></span></li>)}</ul>
          )}
        </section>
      </div>
      {d.data.loans.length > 0 && <section className="card"><h2>Loan repayment schedules</h2>{d.data.loans.map((l: any) => <details key={l.id}><summary>{l.label}</summary>
        <div className="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col" className="num">Payment</th><th scope="col" className="num">Interest</th><th scope="col" className="num">Principal</th><th scope="col" className="num">Balance after</th></tr></thead>
          <tbody>{l.schedule.map((o: any) => <tr key={o.date}><td>{fmtDate(o.date)}</td><td className="num">{gbp(o.amount)}</td><td className="num">{gbp(o.interest)}</td><td className="num">{gbp(o.principal)}</td><td className="num">{gbp(o.balance_after)}</td></tr>)}</tbody></table></div></details>)}</section>}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="Forecast assumptions" footer={<Button busy={saveSet.busy} onClick={() => saveSet.run()}>Save</Button>}>
        {edit && <><ErrorSummary error={saveSet.error} />
          <Field label="Minimum cash buffer (£)" hint="The forecast flags any period that closes below this."><input name="min_cash" inputMode="decimal" value={edit.min_cash} onChange={(e) => setEdit({ ...edit, min_cash: e.target.value })} /></Field>
          {SC.map(([k, n]) => { const s = edit.scenarios[k], setS = (x: any) => setEdit({ ...edit, scenarios: { ...edit.scenarios, [k]: { ...s, ...x } } }); return (
            <fieldset key={k} className="fh-fieldset"><legend>{n}</legend>
              <div className="form-grid"><Field label="Collections late by (days)"><input type="number" min={0} max={180} value={s.collect_delay_days} onChange={(e) => setS({ collect_delay_days: Number(e.target.value) })} /></Field>
                <Field label="Bills paid late by (days)"><input type="number" min={0} max={180} value={s.pay_delay_days} onChange={(e) => setS({ pay_delay_days: Number(e.target.value) })} /></Field></div>
              <div className="form-grid"><Field label="Revenue change (%)"><input type="number" step="0.5" value={s.revenue_pct} onChange={(e) => setS({ revenue_pct: Number(e.target.value) })} /></Field>
                <Field label="Cost change (%)"><input type="number" step="0.5" value={s.cost_pct} onChange={(e) => setS({ cost_pct: Number(e.target.value) })} /></Field></div>
              {s.one_offs.map((o: any, i: number) => <div key={i} className="form-grid"><Field label="Date"><input type="date" value={o.date} onChange={(e) => setS({ one_offs: s.one_offs.map((y: any, j: number) => (j === i ? { ...y, date: e.target.value } : y)) })} /></Field>
                <Field label="What"><input value={o.label} onChange={(e) => setS({ one_offs: s.one_offs.map((y: any, j: number) => (j === i ? { ...y, label: e.target.value } : y)) })} /></Field>
                <Field label="Amount (£, minus for money out)"><input inputMode="decimal" value={o.amount} onChange={(e) => setS({ one_offs: s.one_offs.map((y: any, j: number) => (j === i ? { ...y, amount: e.target.value } : y)) })} /></Field></div>)}
              <Button variant="ghost" onClick={() => setS({ one_offs: [...s.one_offs, { date: londonToday(), label: '', amount: '' }] })}>Add a one-off</Button>
            </fieldset>); })}</>}
      </Dialog>
    </>
  );
}

// ── Daily operations ──
const KIND_LABEL: Record<string, string> = { invoice_due: 'Invoice due', bill_due: 'Bill due', payroll: 'Payroll', tax: 'Tax', loan: 'Loan', rent: 'Rent', supplier: 'Supplier', subscription: 'Subscription', insurance: 'Insurance', income: 'Income', other: 'Other' };
export function Daily({ go }: { go: (tab: string, extra?: Record<string, string>) => void }) {
  const hub = useHub();
  const d = useApi<any>(`/finance/hub${hub.q()}`);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const h = d.data;
  const weeks = new Map<string, any[]>();
  for (const e of h.calendar) { const k = e.date.slice(0, 10); const wk = (() => { const x = new Date(`${k}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); })(); weeks.set(wk, [...(weeks.get(wk) ?? []), e]); }
  return (
    <>
      <ul className="fh-kpis fh-queues">
        {[['Waiting for approval', h.ops.awaiting_approval.length, () => go('documents')], ['Not categorised', h.ops.uncategorised, () => go('bank', { status: 'uncategorised' })],
          ['Receipt or bill missing', h.ops.missing_docs, () => go('bank', { status: 'missing_docs' })], ['Not reconciled', h.ops.unreconciled, () => go('bank', { status: 'unreconciled' })]].map(([t, n, fn]: any) => (
          <li key={t} className={`fh-kpi ${n ? 'tone-warn' : ''}`}><button type="button" onClick={fn}><span className="fh-kpi-label">{t}</span><strong className="fh-kpi-value">{n}</strong><span className="fh-vs">Open the list</span></button></li>))}
      </ul>
      <div className="grid-2">
        <section className="card"><h2>Collect first</h2><p className="small muted">Overdue invoices, largest and oldest first.</p>
          {h.collections.length === 0 ? <Empty>Nothing overdue.</Empty> : <ul className="list">{h.collections.map((c: any) => <li key={c.id}><span><Link to={`/finance/${c.id}`}>{c.number ?? 'Invoice'}</Link> · {c.who}<br /><span className="small fh-bad">{c.days_late} days late{c.part_paid && ' · part paid'}</span></span><strong>{gbp(c.amount)}</strong></li>)}</ul>}
        </section>
        <section className="card"><h2>Bank and reconciliation</h2>
          {h.accounts.length === 0 ? <Empty>No accounts yet. <Button variant="ghost" onClick={() => go('bank')}>Add one</Button></Empty> : <ul className="list">{h.accounts.map((a: any) => <li key={a.id}><span><strong>{a.company_code} · {a.name}</strong><br /><span className="small muted">Bank data to {a.last_txn ? fmtDate(a.last_txn) : 'none yet'} · reconciled to {a.reconciled_to ? fmtDate(a.reconciled_to) : 'never'} · {a.unreconciled} not reconciled</span></span><strong>{a.currency === 'GBP' ? gbp(Number(a.balance) * 100) : `${a.balance} ${a.currency}`}</strong></li>)}</ul>}
        </section>
      </div>
      <section className="card"><h2>Finance calendar, next 60 days</h2>
        <p className="small muted">Invoices due in, bills due out, payroll, tax, loan repayments and recurring bills. Add payroll, tax and loans under Commitments below.</p>
        {h.calendar.length === 0 ? <Empty>Nothing scheduled. Add payroll, tax deadlines, loans and regular bills as commitments.</Empty> : [...weeks].map(([wk, es]) => (
          <div key={wk} className="fh-cal-week"><h3 className="fh-h3">Week of {fmtDate(wk)}</h3><ul className="list">{es.map((e: any, i: number) => <li key={i}><span>{fmtDate(e.date)} · <Status s={e.amount > 0 ? 'info' : e.overdue ? 'action' : 'review'} text={KIND_LABEL[e.kind] ?? label(e.kind)} /> {e.link ? <Link to={e.link}>{e.label}</Link> : e.label}{e.certainty === 'estimate' && <span className="small muted"> (estimate)</span>}{e.overdue && <span className="fh-bad"> overdue</span>}</span><strong>{gbp(e.amount)}</strong></li>)}</ul></div>))}
      </section>
      <Commitments />
    </>
  );
}
const COMMIT_KINDS: [string, string, string, string][] = [['payroll', 'Payroll', 'out', 'staffing'], ['tax', 'Tax (VAT, PAYE, corporation tax)', 'out', 'tax'], ['loan', 'Loan repayment', 'out', 'loan_repayment'], ['rent', 'Rent to a landlord', 'out', 'property_rent'],
  ['supplier', 'Supplier / provider', 'out', 'provider_costs'], ['subscription', 'Subscription', 'out', 'it_systems'], ['insurance', 'Insurance', 'out', 'insurance'], ['income', 'Regular income', 'in', 'rent'], ['other', 'Other', 'out', 'other_expense']];
function Commitments() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/finance/commitments${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.manage'));
  const saveC = useSubmit(async () => {
    const body = { ...f, end_date: f.end_date || null, department: f.department || null, counterparty: f.counterparty || null, loan_balance: f.kind === 'loan' && f.loan_balance ? f.loan_balance : null, interest_rate: f.kind === 'loan' && f.interest_rate ? f.interest_rate : null, note: f.note || null };
    if (f.id) { const { id, company_id, ...rest } = body; await patch(`/finance/commitments/${id}`, rest); } else await post('/finance/commitments', body);
    setF(null); toast('Commitment saved.'); d.reload();
  });
  const stop = useSubmit(async (id: string) => { await patch(`/finance/commitments/${id}`, { active: false }); toast('Stopped. It stays on record.'); d.reload(); });
  const blank = () => ({ company_id: hub.company !== 'all' && cos.some((c) => c.id === hub.company) ? hub.company : cos[0]?.id, kind: 'payroll', label: '', direction: 'out', amount: '', frequency: 'monthly', next_date: londonToday(), end_date: '', certainty: 'committed', category: 'staffing', department: '', counterparty: '', loan_balance: '', interest_rate: '', note: '' });
  return (
    <section className="card"><div className="row between"><h2>Commitments: payroll, tax, loans and regular bills</h2>{cos.length > 0 && <Button variant="secondary" onClick={() => setF(blank())}><Icon name="plus" size={18} />Add</Button>}</div>
      <p className="small muted">Committed items are counted in the forecast as they are. Estimates are flexed by the scenario. Either one replaces the matching part of the plan, so nothing is counted twice.</p>
      {!d.data ? <Skeleton /> : d.data.length === 0 ? <Empty>No commitments yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th scope="col">What</th><th scope="col">How often</th><th scope="col">Next</th><th scope="col" className="num">Amount</th><th scope="col">Certainty</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{d.data.map((c) => <tr key={c.id} className={c.active ? undefined : 'muted'}><td><strong>{c.label}</strong><br /><span className="small muted">{c.company_code} · {COMMIT_KINDS.find((k) => k[0] === c.kind)?.[1]} · {catName(c.category)}{c.loan_balance && ` · £${c.loan_balance} owed at ${c.interest_rate ?? 0}%`}</span></td>
            <td>{label(c.frequency)}{c.end_date && <><br /><span className="small muted">until {fmtDate(c.end_date)}</span></>}</td><td>{c.upcoming[0] ? fmtDate(c.upcoming[0].date) : '—'}</td><td className="num">{c.direction === 'in' ? '' : '−'}{money(c.amount)}</td>
            <td><Status s={c.certainty === 'committed' ? 'info' : 'review'} text={label(c.certainty)} /></td>
            <td>{c.active && hub.can('finance.manage', c.company_id) && <span className="row"><Button variant="ghost" onClick={() => setF({ ...blank(), ...c, end_date: c.end_date ?? '', department: c.department ?? '', counterparty: c.counterparty ?? '', loan_balance: c.loan_balance ?? '', interest_rate: c.interest_rate ?? '', note: c.note ?? '', next_date: String(c.next_date).slice(0, 10) })}>Edit</Button><Button variant="ghost" disabled={stop.busy} onClick={() => stop.run(c.id)}>Stop</Button></span>}</td></tr>)}</tbody></table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit commitment' : 'Add a commitment'} footer={<Button busy={saveC.busy} onClick={() => saveC.run()}>Save</Button>}>
        {f && <><ErrorSummary error={saveC.error} />
          {!f.id && cos.length > 1 && <Field label="Company"><select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <Field label="Type"><select value={f.kind} onChange={(e) => { const k = COMMIT_KINDS.find((x) => x[0] === e.target.value)!; setF({ ...f, kind: k[0], direction: k[2], category: k[3] }); }}>{COMMIT_KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Name" error={saveC.error?.fields.label}><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Monthly payroll, PAYE to HMRC, Bounce Back loan" /></Field>
          <div className="form-grid"><Field label="Amount each time (£)" error={saveC.error?.fields.amount}><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Money"><select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} disabled={f.kind === 'loan'}><option value="out">Going out</option><option value="in">Coming in</option></select></Field></div>
          <div className="form-grid"><Field label="How often"><select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{['once', 'weekly', 'four_weekly', 'monthly', 'quarterly', 'annually'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Next date" error={saveC.error?.fields.next_date}><input type="date" value={f.next_date} onChange={(e) => setF({ ...f, next_date: e.target.value })} /></Field></div>
          <Field label="Ends" optional error={saveC.error?.fields.end_date}><input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
          {f.kind === 'loan' && <div className="form-grid"><Field label="Still owed (£)" optional hint="Splits each repayment into interest and principal and stops when repaid."><input inputMode="decimal" value={f.loan_balance} onChange={(e) => setF({ ...f, loan_balance: e.target.value })} /></Field>
            <Field label="Interest rate (% a year)" optional><input inputMode="decimal" value={f.interest_rate} onChange={(e) => setF({ ...f, interest_rate: e.target.value })} /></Field></div>}
          <Field label="How certain"><select value={f.certainty} onChange={(e) => setF({ ...f, certainty: e.target.value })}><option value="committed">Committed (contracted or agreed)</option><option value="estimate">Estimate (expected, not agreed)</option></select></Field>
          <div className="form-grid"><Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CAT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
            <Field label="Department" optional><select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}><option value="">None</option>{DEPTS.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field></div>
          <Field label="Paid to / from" optional><input value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></Field></>}
      </Dialog>
    </section>
  );
}

// ── Reports: P&L, cash flow statement, balance sheet ──
export function Reports() {
  const hub = useHub();
  const { qs, f } = useFinanceFilters();
  const d = useApi<any>(`/finance/reports?${qs({ company: hub.company !== 'all' ? hub.company : '' })}`);
  const [drill, setDrill] = useState<[string, string] | null>(null);
  if (d.error) return <><FilterBar /><LoadError error={d.error} retry={d.reload} /></>;
  const r = d.data;
  const line = (x: any) => <tr key={x.category}><td><button type="button" className="linkish" onClick={() => setDrill([`category:${x.category}`, catName(x.category)])}>{catName(x.category)}</button></td><td className="num">{gbp(Math.abs(x.actual))}</td><td className="num">{gbp(Math.abs(x.budget))}</td><td className="num">{gbp(Math.abs(x.actual) - Math.abs(x.budget))}</td></tr>;
  const nonzero = (xs: any[]) => xs.filter((x) => x.actual || x.budget);
  const pnlRows = () => r && [['Profit and loss (accrual)', `${f.from} to ${f.to}`], ['Line', 'Actual', 'Budget'], ...['income', 'direct', 'overheads'].flatMap((g) => [[g === 'income' ? 'Income' : g === 'direct' ? 'Direct costs' : 'Overheads'], ...nonzero(r.pnl[g]).map((x: any) => [catName(x.category), Math.abs(x.actual) / 100, Math.abs(x.budget) / 100])]),
    ['Revenue', r.pnl.revenue / 100], ['Gross profit', r.pnl.gross_profit / 100], ['Net profit', r.pnl.net_profit / 100, r.pnl.budget_net / 100]];
  const cfRows = () => r && [['Cash flow (cash basis)', `${f.from} to ${f.to}`], ['Opening cash', r.cashflow.opening == null ? '' : r.cashflow.opening / 100], ['Accounts opened in the period', r.cashflow.opened / 100], ['Operating'], ...r.cashflow.operating.map((x: any) => [catName(x.category), x.amount / 100]),
    ['Financing'], ...r.cashflow.financing.map((x: any) => [catName(x.category), x.amount / 100]), ['Transfers and money between group companies', r.cashflow.transfers / 100], ['Closing cash', r.cashflow.closing == null ? '' : r.cashflow.closing / 100]];
  const bsRows = () => r && [['Balance sheet (management)', `as at ${r.balance_sheet.as_of}`], ...r.balance_sheet.accounts.map((a: any) => [a.name, a.amount / 100]), ['Owed to you', r.balance_sheet.receivables / 100], ['Total assets', r.balance_sheet.assets / 100], ['You owe', r.balance_sheet.payables / 100], ['Loans', r.balance_sheet.loans / 100], ['Total liabilities', r.balance_sheet.liabilities / 100], ['Net assets', r.balance_sheet.net_assets / 100]];
  return (
    <>
      <FilterBar />
      {!r ? <Skeleton lines={8} /> : (
        <>
          <div className="row between fh-toolbar"><p className="small muted">Management reports from Hub records. Not statutory accounts: fixed assets, VAT control, prepayments and accruals other than invoices and bills are not tracked here.</p>
            <span className="row"><Button variant="secondary" onClick={() => save(xlsx([{ name: 'Profit and loss', rows: pnlRows() }, { name: 'Cash flow', rows: cfRows() }, { name: 'Balance sheet', rows: bsRows() }]), `finance-reports-${f.from}-to-${f.to}.xlsx`)}>Excel</Button>
              <Button variant="ghost" onClick={() => save(csv(pnlRows()), `profit-and-loss-${f.from}-to-${f.to}.csv`)}>CSV</Button><Button variant="ghost" onClick={() => window.print()}>PDF</Button></span></div>
          <section className="card"><h2>Profit and loss <span className="small muted">(accrual)</span></h2>
            <div className="table-wrap"><table><thead><tr><th scope="col">Line</th><th scope="col" className="num">Actual</th><th scope="col" className="num">Budget</th><th scope="col" className="num">Difference</th></tr></thead>
              <tbody><tr className="fh-sec"><th colSpan={4} scope="rowgroup">Income</th></tr>{nonzero(r.pnl.income).map(line)}
                <tr className="fh-total"><th scope="row">Revenue</th><td className="num">{gbp(r.pnl.revenue)}</td><td colSpan={2} /></tr>
                <tr className="fh-sec"><th colSpan={4} scope="rowgroup">Direct costs</th></tr>{nonzero(r.pnl.direct).map(line)}
                <tr className="fh-total"><th scope="row">Gross profit</th><td className="num">{gbp(r.pnl.gross_profit)}</td><td colSpan={2} /></tr>
                <tr className="fh-sec"><th colSpan={4} scope="rowgroup">Overheads</th></tr>{nonzero(r.pnl.overheads).map(line)}
                <tr className="fh-total"><th scope="row">Net profit</th><td className="num">{gbp(r.pnl.net_profit)}</td><td className="num">{gbp(r.pnl.budget_net)}</td><td className="num">{gbp(r.pnl.net_profit - r.pnl.budget_net)}</td></tr></tbody></table></div>
          </section>
          <div className="grid-2">
            <section className="card"><h2>Cash flow <span className="small muted">(cash)</span></h2>
              <div className="table-wrap"><table><tbody>
                <tr className="fh-total"><th scope="row">Opening cash</th><td className="num">{r.cashflow.opening == null ? 'No accounts' : gbp(r.cashflow.opening)}</td></tr>
                {r.cashflow.opened !== 0 && <tr><th scope="row">Accounts opened in the period</th><td className="num">{gbp(r.cashflow.opened)}</td></tr>}
                <tr className="fh-sec"><th colSpan={2} scope="rowgroup">Operating</th></tr>{r.cashflow.operating.map((x: any) => <tr key={x.category}><td>{catName(x.category)}</td><td className="num">{gbp(x.amount)}</td></tr>)}
                <tr className="fh-sec"><th colSpan={2} scope="rowgroup">Financing</th></tr>{r.cashflow.financing.map((x: any) => <tr key={x.category}><td>{catName(x.category)}</td><td className="num">{gbp(x.amount)}</td></tr>)}
                {r.cashflow.transfers !== 0 && <tr><td>Transfers and money between group companies</td><td className="num">{gbp(r.cashflow.transfers)}</td></tr>}
                <tr className="fh-total"><th scope="row">Closing cash</th><td className="num">{r.cashflow.closing == null ? 'No accounts' : gbp(r.cashflow.closing)}</td></tr></tbody></table></div>
              {r.cashflow.reconciles != null && <p className={`small ${r.cashflow.reconciles ? '' : 'fh-bad'}`}>{r.cashflow.reconciles ? '✓ Opening plus movements equals closing.' : 'Opening plus movements does not equal closing: check for transactions dated before an account opened.'}</p>}
            </section>
            <section className="card"><h2>Balance sheet <span className="small muted">(as at {fmtDate(r.balance_sheet.as_of)})</span></h2>
              <div className="table-wrap"><table><tbody>
                <tr className="fh-sec"><th colSpan={2} scope="rowgroup">Assets</th></tr>{r.balance_sheet.accounts.map((a: any) => <tr key={a.name}><td>{a.name}</td><td className="num">{gbp(a.amount)}</td></tr>)}
                <tr><td>Owed to you</td><td className="num">{gbp(r.balance_sheet.receivables)}</td></tr><tr className="fh-total"><th scope="row">Total assets</th><td className="num">{gbp(r.balance_sheet.assets)}</td></tr>
                <tr className="fh-sec"><th colSpan={2} scope="rowgroup">Liabilities</th></tr><tr><td>You owe</td><td className="num">{gbp(r.balance_sheet.payables)}</td></tr><tr><td>Loans</td><td className="num">{gbp(r.balance_sheet.loans)}</td></tr>
                <tr className="fh-total"><th scope="row">Total liabilities</th><td className="num">{gbp(r.balance_sheet.liabilities)}</td></tr>
                <tr className="fh-total"><th scope="row">Net assets</th><td className="num">{gbp(r.balance_sheet.net_assets)}</td></tr></tbody></table></div>
            </section>
          </div>
        </>
      )}
      <Drill metric={drill?.[0] ?? null} title={drill?.[1] ?? ''} onClose={() => setDrill(null)} />
    </>
  );
}

// ── Bank and cash ──
export function Bank() {
  const hub = useHub();
  const toast = useToast();
  const { qs, params, set } = useFinanceFilters();
  const status = params.get('status') ?? '';
  const h = useApi<any>(`/finance/hub${hub.q()}`);
  const tx = useApi<any[]>(`/finance/transactions?${qs({ company: hub.company !== 'all' ? hub.company : '', status })}`);
  const docs = useApi<any[]>('/finance/documents');
  const [acc, setAcc] = useState<any>(null);
  const [t, setT] = useState<any>(null);
  const [tr, setTr] = useState<any>(null);
  const [rec, setRec] = useState<any>(null);
  const [match, setMatch] = useState<any>(null);
  const [imp, setImp] = useState<string | null>(null);
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.manage'));
  const accounts = h.data?.accounts ?? [];
  const reload = () => { h.reload(); tx.reload(); docs.reload(); };
  const saveAcc = useSubmit(async () => { await post('/finance/accounts', { ...acc, last_four: acc.last_four || null }); setAcc(null); toast('Account added.'); reload(); });
  const saveT = useSubmit(async () => { const b = { ...t, category: t.category || null, department: t.department || null, property_id: t.property_id || null, counterparty: t.counterparty || null, note: t.note || null };
    if (t.id) { const { id, account_id, ...rest } = b; await patch(`/finance/transactions/${id}`, rest); } else await post('/finance/transactions', b); setT(null); toast('Saved.'); reload(); });
  const code = useSubmit(async (id: string, body: any) => { await patch(`/finance/transactions/${id}`, body); reload(); });
  const del = useSubmit(async (id: string) => { await api('DELETE', `/finance/transactions/${id}`); toast('Deleted.'); reload(); });
  const saveTr = useSubmit(async () => { await post('/finance/transfers', { ...tr, to_amount: tr.to_amount || undefined }); setTr(null); toast('Transfer recorded.'); reload(); });
  const saveRec = useSubmit(async () => { const r = await post(`/finance/accounts/${rec.id}/reconcile`, { statement_date: rec.statement_date, statement_balance: rec.statement_balance }); setRec(null); toast(`${r.reconciled} item(s) reconciled.`); reload(); });
  const saveMatch = useSubmit(async () => { await post(`/finance/transactions/${match.id}/match`, { document_id: match.document_id }); setMatch(null); toast('Matched and payment recorded.'); reload(); });
  const doImport = useSubmit(async (file: File) => { const r = await upload(`/finance/accounts/${imp}/import`, file, file.name); setImp(null); toast(`Imported ${r.imported}, skipped ${r.duplicates} already there${r.matched ? `, linked ${r.matched} to items entered by hand` : ''}${r.skipped_before_opening ? `, ${r.skipped_before_opening} before the opening date` : ''}${r.errors.length ? `, ${r.errors.length} rows not read` : ''}.`); reload(); });
  const attach = useSubmit(async (id: string, file: File) => { await upload(`/finance/transactions/${id}/files`, file, file.name); toast('Receipt attached.'); reload(); });
  const openDocs = (x: any) => (docs.data ?? []).filter((d) => d.company_id === x.company_id && (Number(x.amount) > 0 ? d.direction === 'receivable' && ['issued', 'part_paid'].includes(d.status) : d.direction === 'payable' && ['approved', 'issued', 'part_paid'].includes(d.status)));
  const sheet = () => [['Date', 'Account', 'Description', 'Counterparty', 'Category', 'Department', 'Amount', 'Currency', 'GBP', 'Reconciled', 'Matched to'], ...(tx.data ?? []).map((x) => [String(x.txn_date).slice(0, 10), x.account_name, x.description, x.counterparty, catName(x.category), x.department, Number(x.amount), x.currency, Number(x.amount_gbp), x.reconciled ? 'Yes' : 'No', x.document_number])];
  return (
    <>
      <section className="card"><div className="row between"><h2>Accounts</h2>{cos.length > 0 && <Button onClick={() => setAcc({ company_id: hub.company !== 'all' && cos.some((c) => c.id === hub.company) ? hub.company : cos.find((c) => c.code === 'VH')?.id ?? cos[0].id, name: '', kind: 'bank', currency: 'GBP', opening_balance: '', opening_fx_rate: '1', opening_date: londonToday(), last_four: '' })}><Icon name="plus" size={18} />Add an account</Button>}</div>
        <p className="small muted">The opening balance is the balance on the morning of the opening date (from your bank statement). Everything on and after that date comes from transactions, imported or typed in. Only the last four digits of an account are stored.</p>
        {!h.data ? <Skeleton /> : accounts.length === 0 ? <Empty>No accounts yet. Add your bank account with today's balance (or the balance on the date your statement starts), then import the statement.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th scope="col">Account</th><th scope="col" className="num">Balance</th><th scope="col">Data to</th><th scope="col">Reconciled to</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{accounts.map((a: any) => <tr key={a.id}><td><strong>{a.company_code} · {a.name}</strong>{a.last_four && <span className="small muted"> ··{a.last_four}</span>}<br /><span className="small muted">{label(a.kind)} · opened {fmtDate(a.opening_date)} with {money(a.opening_balance)}{a.currency !== 'GBP' && ` ${a.currency}`}</span></td>
              <td className="num">{a.currency === 'GBP' ? money(a.balance) : `${a.balance} ${a.currency} (${money(a.balance_gbp)})`}</td><td>{a.last_txn ? fmtDate(a.last_txn) : '—'}{a.last_import && <><br /><span className="small muted">imported {fmtDate(a.last_import)}</span></>}</td>
              <td>{a.reconciled_to ? fmtDate(a.reconciled_to) : 'Never'}{a.unreconciled > 0 && <><br /><span className="small muted">{a.unreconciled} to reconcile</span></>}</td>
              <td>{hub.can('finance.manage', a.company_id) && <span className="row"><Button variant="secondary" onClick={() => setImp(a.id)}>Import statement</Button><Button variant="ghost" onClick={() => setRec({ id: a.id, statement_date: a.last_txn ?? londonToday(), statement_balance: '' })}>Reconcile</Button></span>}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <section className="card">
        <div className="row between"><h2>Transactions</h2>
          <span className="row">{accounts.length > 0 && cos.length > 0 && <><Button variant="secondary" onClick={() => setT({ account_id: accounts[0].id, txn_date: londonToday(), amount: '', description: '', counterparty: '', category: '', department: '', property_id: '', note: '' })}>Add a transaction</Button>
            {accounts.length > 1 && <Button variant="ghost" onClick={() => setTr({ from_account: accounts[0].id, to_account: accounts[1].id, txn_date: londonToday(), amount: '', to_amount: '', description: 'Transfer' })}>Transfer</Button>}</>}
            <Button variant="ghost" onClick={() => save(xlsx([{ name: 'Transactions', rows: sheet() }]), 'transactions.xlsx')}>Excel</Button><Button variant="ghost" onClick={() => save(csv(sheet()), 'transactions.csv')}>CSV</Button></span></div>
        <div role="group" aria-label="Show" className="fh-seg">{[['', 'In the period'], ['uncategorised', 'Not categorised'], ['missing_docs', 'Receipt missing'], ['unreconciled', 'Not reconciled']].map(([k, n]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => set({ status: k })}>{n}</button>)}</div>
        {!status && <FilterBar accounts={accounts} showAccount />}
        <ErrorSummary error={code.error ?? del.error ?? attach.error} />
        {!tx.data ? <Skeleton /> : tx.data.length === 0 ? <Empty>No transactions here.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Category</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{tx.data.map((x) => { const m = hub.can('finance.manage', x.company_id); return <tr key={x.id}><td>{fmtDate(x.txn_date)}</td>
              <td>{x.description}<br /><span className="small muted">{x.company_code} · {x.account_name}{x.counterparty && ` · ${x.counterparty}`}{x.property_name && ` · ${x.property_name}`}</span></td>
              <td>{x.transfer_id ? 'Transfer' : m && !x.document_id ? <select aria-label={`Category for ${x.description}`} value={x.category ?? ''} onChange={(e) => code.run(x.id, { category: e.target.value || null })}><option value="">Not categorised</option>{Object.entries(CAT).filter(([k]) => k !== 'transfer').map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select> : catName(x.category)}</td>
              <td className="num">{Number(x.amount) < 0 ? <span>{money(x.amount)}</span> : <strong>{money(x.amount)}</strong>}{x.currency !== 'GBP' && <><br /><span className="small muted">{x.currency} → {money(x.amount_gbp)}</span></>}</td>
              <td className="small">{x.reconciled ? <Status s="verified" text="Reconciled" /> : <Status s="planned" text="Not reconciled" />}{x.document_number && <><br />Matched to <Link to={`/finance/${x.document_id}`}>{x.document_number}</Link></>}{x.files > 0 && <><br />{x.files} receipt{x.files === 1 ? '' : 's'}</>}</td>
              <td>{m && <span className="row">{!x.document_id && !x.transfer_id && openDocs(x).length > 0 && <Button variant="ghost" onClick={() => setMatch({ id: x.id, x, document_id: '' })}>Match</Button>}
                {!x.transfer_id && <FilePicker label="Attach receipt" compact instant accept="application/pdf,image/*" busy={attach.busy} onChange={(fs) => fs[0] && attach.run(x.id, fs[0])} />}
                {!x.reconciled && !x.transfer_id && !x.document_id && <Button variant="ghost" onClick={() => setT({ ...x, txn_date: String(x.txn_date).slice(0, 10), amount: String(x.amount), category: x.category ?? '', department: x.department ?? '', property_id: x.property_id ?? '', counterparty: x.counterparty ?? '', note: x.note ?? '' })}>Edit</Button>}
                {!x.reconciled && !x.document_id && <Button variant="ghost" disabled={del.busy} onClick={() => del.run(x.id)}>Delete</Button>}</span>}</td></tr>; })}</tbody></table></div>
        )}
      </section>
      <Dialog open={!!acc} onClose={() => setAcc(null)} title="Add an account" footer={<Button busy={saveAcc.busy} onClick={() => saveAcc.run()}>Add</Button>}>
        {acc && <><ErrorSummary error={saveAcc.error} />
          {cos.length > 1 && <Field label="Company"><select value={acc.company_id} onChange={(e) => setAcc({ ...acc, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <Field label="Name" error={saveAcc.error?.fields.name}><input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} placeholder="e.g. Business current account" /></Field>
          <div className="form-grid"><Field label="Type"><select value={acc.kind} onChange={(e) => setAcc({ ...acc, kind: e.target.value })}>{[['bank', 'Bank current account'], ['savings', 'Savings'], ['cash', 'Petty cash'], ['card', 'Credit card'], ['loan', 'Loan account']].map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
            <Field label="Last 4 digits" optional><input inputMode="numeric" maxLength={4} value={acc.last_four} onChange={(e) => setAcc({ ...acc, last_four: e.target.value })} /></Field></div>
          <div className="form-grid"><Field label="Opening date" hint="The date your balance is from." error={saveAcc.error?.fields.opening_date}><input type="date" value={acc.opening_date} onChange={(e) => setAcc({ ...acc, opening_date: e.target.value })} /></Field>
            <Field label="Opening balance" hint="Minus if overdrawn or owed." error={saveAcc.error?.fields.opening_balance}><input inputMode="decimal" value={acc.opening_balance} onChange={(e) => setAcc({ ...acc, opening_balance: e.target.value })} /></Field></div>
          <div className="form-grid"><Field label="Currency"><input maxLength={3} value={acc.currency} onChange={(e) => setAcc({ ...acc, currency: e.target.value.toUpperCase(), opening_fx_rate: e.target.value.toUpperCase() === 'GBP' ? '1' : acc.opening_fx_rate })} /></Field>
            {acc.currency !== 'GBP' && <Field label="Rate to GBP on the opening date"><input inputMode="decimal" value={acc.opening_fx_rate} onChange={(e) => setAcc({ ...acc, opening_fx_rate: e.target.value })} /></Field>}</div></>}
      </Dialog>
      <Dialog open={!!t} onClose={() => setT(null)} title={t?.id ? 'Edit transaction' : 'Add a transaction'} footer={<Button busy={saveT.busy} onClick={() => saveT.run()}>Save</Button>}>
        {t && <><ErrorSummary error={saveT.error} />
          {!t.id && <Field label="Account"><select value={t.account_id} onChange={(e) => setT({ ...t, account_id: e.target.value })}>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.company_code} · {a.name}</option>)}</select></Field>}
          <div className="form-grid"><Field label="Date" error={saveT.error?.fields.txn_date}><input type="date" value={t.txn_date} onChange={(e) => setT({ ...t, txn_date: e.target.value })} /></Field>
            <Field label="Amount" hint="Minus for money out, e.g. -120.00. A refund you receive is plus, in the original category." error={saveT.error?.fields.amount}><input inputMode="decimal" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} /></Field></div>
          {accounts.find((a: any) => a.id === t.account_id)?.currency !== 'GBP' && <Field label="Rate to GBP" error={saveT.error?.fields.fx_rate}><input inputMode="decimal" value={t.fx_rate ?? ''} onChange={(e) => setT({ ...t, fx_rate: e.target.value })} /></Field>}
          <Field label="Description" error={saveT.error?.fields.description}><input value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
          <Field label="Paid to / from" optional><input value={t.counterparty} onChange={(e) => setT({ ...t, counterparty: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Category" optional><select value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })}><option value="">Not categorised</option>{Object.entries(CAT).filter(([k]) => k !== 'transfer').map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Field>
            <Field label="Department" optional><select value={t.department} onChange={(e) => setT({ ...t, department: e.target.value })}><option value="">None</option>{DEPTS.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field></div>
          <Field label="Note" optional><input value={t.note} onChange={(e) => setT({ ...t, note: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={!!tr} onClose={() => setTr(null)} title="Transfer between accounts" footer={<Button busy={saveTr.busy} onClick={() => saveTr.run()}>Record transfer</Button>}>
        {tr && <><ErrorSummary error={saveTr.error} /><p className="small muted">Recorded on both accounts and never counted as income or spending.</p>
          <div className="form-grid"><Field label="From"><select value={tr.from_account} onChange={(e) => setTr({ ...tr, from_account: e.target.value })}>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.company_code} · {a.name}</option>)}</select></Field>
            <Field label="To"><select value={tr.to_account} onChange={(e) => setTr({ ...tr, to_account: e.target.value })}>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.company_code} · {a.name}</option>)}</select></Field></div>
          <div className="form-grid"><Field label="Date"><input type="date" value={tr.txn_date} onChange={(e) => setTr({ ...tr, txn_date: e.target.value })} /></Field><Field label="Amount (£)" error={saveTr.error?.fields.amount}><input inputMode="decimal" value={tr.amount} onChange={(e) => setTr({ ...tr, amount: e.target.value })} /></Field></div>
          <Field label="Amount received" optional hint="Only if the accounts use different currencies." error={saveTr.error?.fields.to_amount}><input inputMode="decimal" value={tr.to_amount} onChange={(e) => setTr({ ...tr, to_amount: e.target.value })} /></Field>
          <Field label="Description"><input value={tr.description} onChange={(e) => setTr({ ...tr, description: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={!!rec} onClose={() => setRec(null)} title="Reconcile to a bank statement" variant="modal" footer={<Button busy={saveRec.busy} onClick={() => saveRec.run()}>Reconcile</Button>}>
        {rec && <><ErrorSummary error={saveRec.error} /><p className="small muted">Enter the closing balance shown on your statement for a date. If the Hub agrees to the penny, everything up to that date is marked reconciled and locked.</p>
          <div className="form-grid"><Field label="Statement date"><input type="date" value={rec.statement_date} onChange={(e) => setRec({ ...rec, statement_date: e.target.value })} /></Field>
            <Field label="Statement balance (£)" error={saveRec.error?.fields.statement_balance}><input inputMode="decimal" value={rec.statement_balance} onChange={(e) => setRec({ ...rec, statement_balance: e.target.value })} /></Field></div></>}
      </Dialog>
      <Dialog open={!!match} onClose={() => setMatch(null)} title="Match to an invoice or bill" variant="modal" footer={<Button busy={saveMatch.busy} disabled={!match?.document_id} onClick={() => saveMatch.run()}>Match</Button>}>
        {match && <><ErrorSummary error={saveMatch.error} /><p className="small">{match.x.description}: <strong>{money(match.x.amount)}</strong>. A part payment is fine; the rest stays owed.</p>
          <Field label="Document"><select value={match.document_id} onChange={(e) => setMatch({ ...match, document_id: e.target.value })}><option value="">Choose…</option>{openDocs(match.x).map((d) => <option key={d.id} value={d.id}>{d.number ?? label(d.kind)} · {d.direction === 'receivable' ? d.recipient_name : d.issuer_name} · {money(d.total)}</option>)}</select></Field></>}
      </Dialog>
      <Dialog open={!!imp} onClose={() => setImp(null)} title="Import a bank statement" variant="modal">
        <ErrorSummary error={doImport.error} />
        <p className="small">Download a CSV statement from online banking. The Hub finds the Date, Description and Amount (or Paid in / Paid out) columns. Rows already imported are skipped, so overlapping statements are safe. Rows dated before the account's opening date are skipped.</p>
        <FilePicker label="CSV statement" accept=".csv,text/csv" instant busy={doImport.busy} onChange={(fs) => fs[0] && doImport.run(fs[0])} />
      </Dialog>
    </>
  );
}

// ── Plan and budgets ──
export function Plan() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any>(`/finance/plan${hub.q()}`);
  const [edit, setEdit] = useState<any>(null);
  const saveL = useSubmit(async () => { await patch(`/finance/plan-lines/${edit.id}`, { amount: edit.amount, all_periods: edit.all }); setEdit(null); toast('Plan updated.'); d.reload(); });
  const grid = useMemo(() => {
    if (!d.data) return [];
    const m = new Map<string, any>();
    for (const l of d.data.lines) { const k = `${l.plan_id}|${l.direction}|${l.category}|${l.label}`; const x = m.get(k) ?? { ...l, periods: {} }; x.periods[l.period_no] = l; m.set(k, x); }
    return [...m.values()];
  }, [d.data]);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  if (!d.data.plans.length) return <Empty>No plan loaded for this company.</Empty>;
  const plan = d.data.plans[0];
  const periods = Array.from({ length: plan.periods }, (_, i) => i + 1);
  const start = (n: number) => { const x = new Date(`${String(plan.start_date).slice(0, 10)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + (n - 1) * plan.period_days); return x.toISOString().slice(0, 10); };
  const tot = (pred: (l: any) => boolean, n: number) => d.data.lines.filter((l: any) => l.period_no === n && pred(l)).reduce((s: number, l: any) => s + Math.round(Number(l.amount) * 100) * (l.direction === 'income' ? 1 : -1), 0);
  const sheet = () => [['Line', 'Category', 'Department', ...periods.map((n) => `P${n} ${start(n)}`)], ...grid.map((g) => [g.label, catName(g.category), g.department, ...periods.map((n) => (g.direction === 'income' ? 1 : -1) * Number(g.periods[n]?.amount ?? 0))]), ['Net', '', '', ...periods.map((n) => tot(() => true, n) / 100)]];
  return (
    <>
      <section className="card"><h2>{plan.name}</h2><p className="small">{plan.source_note}</p>
        <p className="small muted">{plan.periods} periods of {plan.period_days} days from {fmtDate(plan.start_date)}. This is the budget and the base of the forecast. It is never shown as actual results.</p>
        <span className="row"><Button variant="secondary" onClick={() => save(xlsx([{ name: 'Plan', rows: sheet() }]), 'plan.xlsx')}>Excel</Button><Button variant="ghost" onClick={() => save(csv(sheet()), 'plan.csv')}>CSV</Button></span></section>
      <section className="card"><h2>Plan by line and period</h2>
        <div className="table-wrap fh-plan"><table><thead><tr><th scope="col">Line</th>{periods.map((n) => <th key={n} scope="col" className="num">P{n}<br /><span className="small muted">{fmtDate(start(n)).replace(/ \d{4}$/, '')}</span></th>)}</tr></thead>
          <tbody>
            {['income', 'expense'].map((dir) => [<tr key={dir} className="fh-sec"><th colSpan={periods.length + 1} scope="rowgroup">{dir === 'income' ? 'Income' : 'Costs'}</th></tr>,
              ...grid.filter((g) => g.direction === dir).map((g) => <tr key={g.label + g.category}><th scope="row" className="fh-plan-line">{g.label}<br /><span className="small muted">{catName(g.category)}{g.department && ` · ${label(g.department)}`}</span></th>
                {periods.map((n) => { const l = g.periods[n]; return <td key={n} className="num">{l ? (hub.can('finance.manage', plan.company_id) ? <button type="button" className="linkish" onClick={() => setEdit({ id: l.id, label: g.label, period: n, amount: l.amount, all: false })}>{money(l.amount)}</button> : money(l.amount)) : '—'}</td>; })}</tr>)])}
            <tr className="fh-total"><th scope="row">Income</th>{periods.map((n) => <td key={n} className="num">{gbp(tot((l) => l.direction === 'income', n))}</td>)}</tr>
            <tr className="fh-total"><th scope="row">Costs</th>{periods.map((n) => <td key={n} className="num">{gbp(-tot((l) => l.direction === 'expense', n))}</td>)}</tr>
            <tr className="fh-total"><th scope="row">Retained</th>{periods.map((n) => <td key={n} className="num"><strong>{gbp(tot(() => true, n))}</strong></td>)}</tr>
          </tbody></table></div>
      </section>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="Change a plan line" variant="modal" footer={<Button busy={saveL.busy} onClick={() => saveL.run()}>Save</Button>}>
        {edit && <><ErrorSummary error={saveL.error} /><p className="small">{edit.label}, P{edit.period}. Changes are recorded in the audit log.</p>
          <Field label="Amount per period (£)" error={saveL.error?.fields.amount}><input inputMode="decimal" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={edit.all} onChange={(e) => setEdit({ ...edit, all: e.target.checked })} /> Apply to every period</label></>}
      </Dialog>
    </>
  );
}
