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
