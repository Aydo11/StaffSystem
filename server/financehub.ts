// Finance hub calculations. Everything is in whole pence (integers) so totals reconcile exactly.
// Sources and how they are kept apart so nothing is counted twice:
//  • Cash (actual): bank/cash transactions only. Transfers between accounts are never income or spending, and money
//    moving between two companies in view is left out of combined totals.
//  • Accrual (actual): issued invoices and approved bills by issue date (net of VAT), plus categorised bank items that
//    have no invoice or bill. A bank payment linked to a bill is cash only, so the bill is not counted twice.
//  • Committed: unpaid invoices and bills, and commitments marked committed. Estimate: commitments marked estimate.
//  • Plan: the active plan, spread evenly over each 4-week period. In the forecast it only fills the gap left by
//    actuals already received in that period and the committed/estimated items in it.
//  • Assumption: one-off amounts typed into a scenario.
import { type Db, one, q } from './db.ts';

export const INCOME = ['rent', 'service_charge', 'support_income', 'grant', 'other_income'] as const;
export const EXPENSE = ['managing_agent_fee', 'provider_costs', 'staffing', 'property_rent', 'repairs_maintenance', 'utilities', 'insurance', 'office_admin', 'it_systems',
  'professional_fees', 'travel', 'training', 'bank_charges', 'interest', 'tax', 'other_expense'] as const;
export const FINANCING = ['loan_received', 'loan_repayment', 'capital_introduced', 'dividends', 'transfer'] as const;
export const CATEGORIES = [...INCOME, ...EXPENSE, ...FINANCING] as const;
export const DIRECT = ['managing_agent_fee', 'provider_costs', 'property_rent'];   // cost of delivering the housing; the rest is overhead
export const DEPARTMENTS = ['housing', 'support', 'property', 'lettings', 'management', 'admin', 'compliance', 'finance'] as const;
const isIncome = (c: string | null) => !!c && (INCOME as readonly string[]).includes(c);
const isExpense = (c: string | null) => !!c && (EXPENSE as readonly string[]).includes(c);
const RECEIVABLE = ['sales_invoice', 'payment_statement'];
// Default category when a document has none set: contractor invoices come from timesheets (support staff).
const DOC_DEFAULT: Record<string, string> = { sales_invoice: 'other_income', payment_statement: 'other_income', contractor_invoice: 'staffing', expense_claim: 'travel', credit_note: 'other_income' };

export const p = (v: unknown) => Math.round(Number(v ?? 0) * 100);           // numeric string → pence
export const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
export const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => { const x = new Date(`${monthStart(d)}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
// Same day n months on; the 31st becomes the last day of a shorter month.
const addMonthsClamp = (d: string, n: number) => { const m = addMonths(d, n), last = addDays(addMonths(d, n + 1), -1); const dd = d.slice(8); return dd > last.slice(8) ? last : `${m.slice(0, 8)}${dd}`; };

export type Filters = { from: string; to: string; department?: string; property?: string; account?: string };
export type Scenario = { collect_delay_days: number; pay_delay_days: number; revenue_pct: number; cost_pct: number; one_offs: { date: string; label: string; amount: string }[] };

export async function loadBooks(db: Db, companies: string[]) {
  const [accounts, txns, docs, commitments, plans, settings] = await Promise.all([
    q(`select a.*, c.code as company_code from finance_accounts a join companies c on c.id = a.company_id where a.company_id = any($1::uuid[]) order by c.code, a.name`, [companies], db),
    q(`select t.*, a.name as account_name, pr.name as property_name, (select count(*)::int from files f where f.entity_type = 'finance_txn' and f.entity_id = t.id) as files
         from finance_transactions t join finance_accounts a on a.id = t.account_id left join properties pr on pr.id = t.property_id
        where t.company_id = any($1::uuid[]) order by t.txn_date, t.created_at`, [companies], db),
    q(`select f.id, f.company_id, f.kind, f.direction, f.number, f.issuer_name, f.recipient_name, f.status, f.subtotal, f.tax_total, f.total, f.issue_date, f.due_date, f.period_end,
              f.created_at, f.category, f.department, f.property_id, f.credits_document_id, f.updated_at,
              coalesce((select sum(amount) from finance_payments x where x.document_id = f.id), 0) as paid,
              coalesce((select sum(total) from finance_documents c where c.credits_document_id = f.id and c.status = 'issued'), 0) as credited
         from finance_documents f where f.company_id = any($1::uuid[]) and f.status not in ('draft','rejected','void')`, [companies], db),
    q(`select * from finance_commitments where company_id = any($1::uuid[]) and active order by next_date`, [companies], db),
    q(`select p.*, (select json_agg(l order by l.period_no, l.direction, l.category) from finance_plan_lines l where l.plan_id = p.id) as lines
         from finance_plans p where p.company_id = any($1::uuid[]) and p.active`, [companies], db),
    q(`select * from finance_hub_settings where company_id = any($1::uuid[])`, [companies], db),
  ]);
  return { companies, accounts, txns, docs, commitments, plans, settings };
}
export type Books = Awaited<ReturnType<typeof loadBooks>>;

// ── Building blocks ──
const counts = (b: Books, t: any) => !(t.transfer_id || t.category === 'transfer') && !(b.companies.length > 1 && t.counterparty_company_id && b.companies.includes(t.counterparty_company_id));
const inRange = (d: string, f: { from: string; to: string }) => d >= f.from && d <= f.to;
const docDate = (d: any) => day(d.issue_date ?? d.period_end ?? d.created_at);
const docCategory = (d: any) => d.category ?? DOC_DEFAULT[d.kind];
export const outstanding = (d: any) => p(d.total) - p(d.paid) - p(d.credited);
const dims = (f: Filters, x: any) => (!f.department || x.department === f.department) && (!f.property || x.property_id === f.property);

export function accountBalance(a: any, txns: any[], asOf: string) {
  let own = p(a.opening_balance), gbp = Math.round(p(a.opening_balance) * Number(a.opening_fx_rate));
  for (const t of txns) if (t.account_id === a.id && day(t.txn_date) >= day(a.opening_date) && day(t.txn_date) <= asOf) { own += p(t.amount); gbp += p(t.amount_gbp); }
  return { own, gbp };
}
export function cashBalance(b: Books, asOf: string, account?: string) {
  const all = b.accounts.filter((a) => !a.archived && a.kind !== 'loan' && (!account || a.id === account));
  if (!all.length) return null;  // no accounts: unknown, never £0
  return all.filter((a) => day(a.opening_date) <= asOf).reduce((s, a) => s + accountBalance(a, b.txns, asOf).gbp, 0);
}

type Row = { type: 'transaction' | 'document' | 'plan' | 'commitment'; id: string; date: string; description: string; category: string | null; amount: number; link?: string };
// Accrual P&L lines for a range, each with the record behind it (for drill-down and reconciliation).
export function accrual(b: Books, f: Filters) {
  const rows: Row[] = [];
  for (const d of b.docs) {
    if (!dims(f, d) || !inRange(docDate(d), f)) continue;
    const sign = d.kind === 'credit_note' ? -1 : 1;
    if (RECEIVABLE.includes(d.kind) || d.kind === 'credit_note') {
      if (!['issued', 'part_paid', 'paid', 'credited'].includes(d.status)) continue;
      rows.push({ type: 'document', id: d.id, date: docDate(d), description: `${d.number ?? d.kind} · ${d.recipient_name}`, category: docCategory(d), amount: sign * p(d.subtotal), link: `/finance/${d.id}` });
    } else if (['approved', 'issued', 'part_paid', 'paid'].includes(d.status)) {
      rows.push({ type: 'document', id: d.id, date: docDate(d), description: `${d.number ?? d.kind} · ${d.issuer_name}`, category: docCategory(d), amount: -p(d.subtotal), link: `/finance/${d.id}` });
    }
  }
  for (const t of b.txns) {
    if (t.document_id || !counts(b, t) || !dims(f, t) || !inRange(day(t.txn_date), f) || (f.account && t.account_id !== f.account)) continue;
    if (isIncome(t.category) || isExpense(t.category)) rows.push({ type: 'transaction', id: t.id, date: day(t.txn_date), description: t.description, category: t.category, amount: p(t.amount_gbp) });
  }
  const sum = (pred: (r: Row) => boolean) => rows.filter(pred).reduce((s, r) => s + r.amount, 0);
  const revenue = sum((r) => isIncome(r.category));
  const direct = -sum((r) => DIRECT.includes(r.category!));
  const expenses = -sum((r) => isExpense(r.category));
  return { rows, revenue, direct, gross: revenue - direct, opex: expenses - direct, expenses, net: revenue - expenses };
}
export function cash(b: Books, f: Filters) {
  const rows: Row[] = [];
  for (const t of b.txns) {
    if (!counts(b, t) || !dims(f, t) || !inRange(day(t.txn_date), f) || (f.account && t.account_id !== f.account)) continue;
    rows.push({ type: 'transaction', id: t.id, date: day(t.txn_date), description: t.description, category: t.category, amount: p(t.amount_gbp) });
  }
  const inflow = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const outflow = -rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
  return { rows, inflow, outflow, net: inflow - outflow };
}

// Plan amounts over a date range, spread evenly over each period's days.
export function planLines(b: Books, f: Filters) {
  const out: { category: string; direction: string; department: string | null; property_id: string | null; amount: number; label: string; id: string }[] = [];
  for (const pl of b.plans) for (const l of pl.lines ?? []) {
    if (!dims(f, l)) continue;
    const ps = addDays(day(pl.start_date), (l.period_no - 1) * pl.period_days), pe = addDays(ps, pl.period_days - 1);
    const a = ps > f.from ? ps : f.from, z = pe < f.to ? pe : f.to;
    if (a > z) continue;
    out.push({ id: l.id, category: l.category, direction: l.direction, department: l.department, property_id: l.property_id, label: l.label, amount: (p(l.amount) * (daysBetween(a, z) + 1)) / pl.period_days });
  }
  return out;
}
export function planTotals(b: Books, f: Filters) {
  const ls = planLines(b, f);
  const income = Math.round(ls.filter((l) => l.direction === 'income').reduce((s, l) => s + l.amount, 0));
  const expenses = Math.round(ls.filter((l) => l.direction === 'expense').reduce((s, l) => s + l.amount, 0));
  const direct = Math.round(ls.filter((l) => l.direction === 'expense' && DIRECT.includes(l.category)).reduce((s, l) => s + l.amount, 0));
  return { income, expenses, direct, net: income - expenses, lines: ls };
}

// Commitments → dated occurrences. Loans split each repayment into interest and principal and stop when repaid.
const STEP: Record<string, [number, number]> = { weekly: [7, 0], four_weekly: [28, 0], monthly: [0, 1], quarterly: [0, 3], annually: [0, 12] };
const PER_YEAR: Record<string, number> = { weekly: 52, four_weekly: 13, monthly: 12, quarterly: 4, annually: 1, once: 1 };
export function occurrences(c: any, from: string, to: string) {
  const out: { date: string; amount: number; interest?: number; principal?: number; balance_after?: number }[] = [];
  let d = day(c.next_date), i = 0, bal = c.loan_balance != null ? p(c.loan_balance) : null;
  const end = c.end_date ? day(c.end_date) : to;
  while (d <= to && d <= end && i < 600) {
    let amount = p(c.amount), interest: number | undefined, principal: number | undefined;
    if (bal != null) {
      if (bal <= 0) break;
      interest = Math.round((bal * Number(c.interest_rate ?? 0)) / 100 / PER_YEAR[c.frequency]);
      principal = Math.min(amount - interest, bal);
      if (principal <= 0) principal = 0;  // repayment does not cover interest: the balance never falls; shown as a warning
      amount = principal + interest; bal -= principal;
    }
    if (d >= from) out.push({ date: d, amount, interest, principal, balance_after: bal ?? undefined });
    if (c.frequency === 'once' || (bal != null && principal === 0)) break;
    const [dd, mm] = STEP[c.frequency];
    i++; d = mm ? addMonthsClamp(day(c.next_date), mm * i) : addDays(day(c.next_date), dd * i);
  }
  return out;
}

// ── Forecast ──
export type FEvent = { company_id: string; date: string; amount: number; type: 'committed' | 'estimate' | 'plan' | 'assumption'; category: string; label: string };
export function forecast(b: Books, today: string, horizonEnd: string, sc: Scenario, opening: number | null) {
  const ev: FEvent[] = [];
  const adj = (amount: number, isIn: boolean) => Math.round(amount * (1 + (isIn ? sc.revenue_pct : sc.cost_pct) / 100));
  for (const d of b.docs) {
    const left = outstanding(d);
    if (left <= 0 || d.kind === 'credit_note') continue;
    const inflow = RECEIVABLE.includes(d.kind);
    if (inflow ? !['issued', 'part_paid'].includes(d.status) : !['approved', 'issued', 'part_paid'].includes(d.status)) continue;
    const due = d.due_date && day(d.due_date) > today ? day(d.due_date) : today;
    ev.push({ company_id: d.company_id, date: addDays(due, inflow ? sc.collect_delay_days : sc.pay_delay_days), amount: inflow ? left : -left, type: 'committed', category: docCategory(d), label: `${inflow ? 'Collect' : 'Pay'} ${d.number ?? d.kind} (${inflow ? d.recipient_name : d.issuer_name})` });
  }
  for (const c of b.commitments) for (const o of occurrences(c, today, horizonEnd)) {
    const isIn = c.direction === 'in';
    const amt = c.certainty === 'estimate' ? adj(o.amount, isIn) : o.amount;
    ev.push({ company_id: c.company_id, date: addDays(o.date, isIn ? sc.collect_delay_days : 0), amount: isIn ? amt : -amt, type: c.certainty, category: c.category, label: c.label });
  }
  for (const x of sc.one_offs ?? []) if (x.date >= today && x.date <= horizonEnd) ev.push({ company_id: '', date: x.date, amount: p(x.amount), type: 'assumption', category: p(x.amount) >= 0 ? 'other_income' : 'other_expense', label: x.label });
  // Plan fills the gap per period and category: plan − actual so far − committed/estimated items in the period.
  for (const pl of b.plans) for (let k = 1; k <= pl.periods; k++) {
    const ps = addDays(day(pl.start_date), (k - 1) * pl.period_days), pe = addDays(ps, pl.period_days - 1);
    if (pe < today || ps > horizonEnd) continue;
    const from = ps > today ? ps : today;
    const byCat = new Map<string, number>();
    for (const l of (pl.lines ?? []).filter((x: any) => x.period_no === k)) byCat.set(l.category, (byCat.get(l.category) ?? 0) + (l.direction === 'income' ? 1 : -1) * p(l.amount));
    for (const [cat, planned] of byCat) {
      const isIn = planned > 0;
      const done = b.txns.filter((t) => t.company_id === pl.company_id && t.category === cat && counts(b, t) && day(t.txn_date) >= ps && day(t.txn_date) < today).reduce((s, t) => s + p(t.amount_gbp), 0);
      const known = ev.filter((e) => e.company_id === pl.company_id && e.category === cat && e.type !== 'plan' && e.date >= from && e.date <= pe).reduce((s, e) => s + e.amount, 0);
      const gap = isIn ? Math.max(0, planned - done - known) : Math.min(0, planned - done - known);
      if (!gap) continue;
      const days = daysBetween(from, pe) + 1, scaled = adj(Math.abs(gap), isIn) * Math.sign(gap);
      for (let i = 0; i < days; i++) {
        const share = Math.round((scaled * (i + 1)) / days) - Math.round((scaled * i) / days);  // pennies add up exactly
        const date = addDays(addDays(from, i), isIn ? sc.collect_delay_days : 0);
        if (share && date <= horizonEnd) ev.push({ company_id: pl.company_id, date, amount: share, type: 'plan', category: cat, label: `Plan: ${cat.replace(/_/g, ' ')}` });
      }
    }
  }
  const bucket = (s: string, e: string) => {
    const xs = ev.filter((x) => x.date >= s && x.date <= e);
    const by = (t: string, sign: 1 | -1) => xs.filter((x) => x.type === t && Math.sign(x.amount) === sign).reduce((a, x) => a + Math.abs(x.amount), 0);
    const types = ['committed', 'estimate', 'plan', 'assumption'] as const;
    return { start: s, end: e, inflow: Object.fromEntries(types.map((t) => [t, by(t, 1)])), outflow: Object.fromEntries(types.map((t) => [t, by(t, -1)])), net: xs.reduce((a, x) => a + x.amount, 0) };
  };
  const roll = <T extends { net: number }>(bs: T[]) => { let bal = opening ?? 0; return bs.map((x) => { const o = bal; bal += x.net; return { ...x, opening: o, closing: bal }; }); };
  const weeks = roll(Array.from({ length: 13 }, (_, i) => bucket(addDays(today, i * 7), addDays(today, i * 7 + 6))));
  const months = roll(Array.from({ length: 12 }, (_, i) => bucket(i === 0 ? today : addMonths(today, i), addDays(addMonths(today, i + 1), -1))));
  return { events: ev, weeks, months };
}

export async function scenarioSettings(db: Db, companyId: string) {
  return one<{ min_cash: string; scenarios: Record<string, Scenario> }>(`select min_cash, scenarios from finance_hub_settings where company_id = $1`, [companyId], db);
}
