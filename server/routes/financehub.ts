// Finance hub API: dashboard figures, forecast, reports, bank and cash, commitments, plan, settings and saved views.
// Reading needs finance.view in the company; every change needs finance.manage and is written to the audit log.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { parseCsv } from '../csv.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import {
  accountBalance, accrual, addDays, CATEGORIES, cash, cashBalance, day, daysBetween, DEPARTMENTS, DIRECT, FINANCING, forecast, INCOME, loadBooks, occurrences, outstanding, p, planTotals,
  type Books, type Filters, type Scenario,
} from '../financehub.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, parse, text, uuid } from '../http.ts';
import { can, companiesWith, need, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const financehub = Router();
const signedMoney = z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 1250.00 (minus for money out)');
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 12.50');
const category = z.enum(CATEGORIES);
const department = z.enum(DEPARTMENTS);
const today = async (db: Db = pool) => (await one<{ d: string }>(`select ${LONDON_TODAY}::text d`, [], db))!.d;
const pounds = (pence: number | null) => (pence == null ? null : (pence / 100).toFixed(2));

function filters(req: any, t: string): Filters & { companies: string[] } {
  const qy = req.query;
  const companies = scope(req.access, 'finance.view', qy.company);
  if (!companies.length) throw forbidden();
  const f = {
    from: qy.from ? parse(isoDate, qy.from) : `${t.slice(0, 7)}-01`, to: qy.to ? parse(isoDate, qy.to) : t,
    department: qy.department ? parse(department, qy.department) : undefined, property: qy.property ? parse(uuid, qy.property) : undefined, account: qy.account ? parse(uuid, qy.account) : undefined,
  };
  if (f.from > f.to) throw bad('The start date is after the end date.');
  return { ...f, companies };
}

// ── KPIs and everything on the dashboard, from one load of the books ──
function kpis(b: Books, f: Filters, t: string) {
  const acc = accrual(b, f), c = cash(b, f), plan = planTotals(b, f);
  const asOf = f.to < t ? f.to : t;
  const bal = cashBalance(b, asOf, f.account);
  const ninety = { ...f, from: addDays(t, -89), to: t };
  const rev90 = accrual(b, ninety);
  const docCost90 = -rev90.rows.filter((r) => r.type === 'document' && r.amount < 0).reduce((s, r) => s + r.amount, 0);
  const open = b.docs.filter((d) => outstanding(d) > 0 && d.kind !== 'credit_note');
  const ar = open.filter((d) => d.direction === 'receivable' && ['issued', 'part_paid'].includes(d.status));
  const ap = open.filter((d) => d.direction === 'payable' && ['approved', 'issued', 'part_paid'].includes(d.status));
  const sum = (xs: any[]) => xs.reduce((s, d) => s + outstanding(d), 0);
  const arT = sum(ar), apT = sum(ap);
  const overdue = ar.filter((d) => d.due_date && day(d.due_date) < t);
  const apSoon = ap.filter((d) => !d.due_date || day(d.due_date) <= addDays(t, 14));
  const commitSoon = b.commitments.filter((x) => x.direction === 'out').flatMap((x) => occurrences(x, t, addDays(t, 14)).map((o) => o.amount)).reduce((s, a) => s + a, 0);
  const minCash = b.settings.reduce((s, x) => s + p(x.min_cash), 0);
  // Burn: average monthly operating cash outflow over the last three full months (financing and transfers left out).
  const m0 = `${t.slice(0, 7)}-01`;
  const threeMonths = { ...f, from: new Date(Date.UTC(+m0.slice(0, 4), +m0.slice(5, 7) - 4, 1)).toISOString().slice(0, 10), to: addDays(m0, -1) };
  const op = cash(b, threeMonths).rows.filter((r) => !(FINANCING as readonly string[]).includes(r.category ?? '')).reduce((s, r) => s + r.amount, 0);
  const hasHistory = b.txns.some((x) => day(x.txn_date) <= threeMonths.to && day(x.txn_date) >= threeMonths.from);
  const burn = hasHistory ? Math.max(0, Math.round(-op / 3)) : null;
  const dso = rev90.revenue > 0 ? Math.round((arT / rev90.revenue) * 90) : null;
  const dpo = docCost90 > 0 ? Math.round((apT / docCost90) * 90) : null;
  return {
    revenue: acc.revenue, direct_costs: acc.direct, gross_profit: acc.gross, gross_margin: acc.revenue ? acc.gross / acc.revenue : null,
    operating_expenses: acc.opex, expenses: acc.expenses, net_profit: acc.net, net_margin: acc.revenue ? acc.net / acc.revenue : null,
    cash_in: c.inflow, cash_out: c.outflow, net_cash: c.net,
    cash_balance: bal, min_cash: minCash, available_cash: bal == null ? null : bal - minCash - apSoon.reduce((s, d) => s + outstanding(d), 0) - commitSoon,
    burn_rate: burn, runway_months: bal != null && burn ? Math.round((bal / burn) * 10) / 10 : null,
    receivables: arT, payables: apT, overdue_receivables: sum(overdue), overdue_count: overdue.length,
    upcoming_payments: apSoon.reduce((s, d) => s + outstanding(d), 0) + commitSoon,
    dso, dpo, ccc: dso != null && dpo != null ? dso - dpo : null, working_capital: bal == null ? null : bal + arT - apT,
    budget_income: plan.income, budget_expenses: plan.expenses, budget_net: plan.net, budget_direct: plan.direct,
    variance_income: acc.revenue - plan.income, variance_expenses: acc.expenses - plan.expenses, variance_net: acc.net - plan.net,
  };
}
const BUCKETS = [['current', 'Not yet due', -Infinity, 0], ['d30', '1–30 days', 1, 30], ['d60', '31–60 days', 31, 60], ['d90', '61–90 days', 61, 90], ['d90p', 'Over 90 days', 91, Infinity]] as const;
function aging(b: Books, t: string, direction: string) {
  const xs = b.docs.filter((d) => d.direction === direction && d.kind !== 'credit_note' && outstanding(d) > 0 && (direction === 'receivable' ? ['issued', 'part_paid'] : ['approved', 'issued', 'part_paid']).includes(d.status));
  return BUCKETS.map(([key, label, lo, hi]) => {
    const ds = xs.filter((d) => { const late = d.due_date ? daysBetween(day(d.due_date), t) : 0; return late >= lo && late <= hi; });
    return { key, label, count: ds.length, amount: ds.reduce((s, d) => s + outstanding(d), 0) };
  });
}
function opsQueues(b: Books) {
  const live = b.txns.filter((t) => !t.transfer_id);
  return {
    uncategorised: live.filter((t) => !t.category),
    missing_docs: live.filter((t) => p(t.amount_gbp) <= -10000 && !t.document_id && !t.files && t.category !== 'transfer'),   // shortcut: £100 threshold for "receipt needed", make it a setting if asked
    unreconciled: b.txns.filter((t) => !t.reconciled),
  };
}
function drillRows(b: Books, f: Filters, metric: string, t: string) {
  const acc = accrual(b, f), c = cash(b, f), ops = opsQueues(b);
  const docRow = (d: any) => ({ type: 'document', id: d.id, date: day(d.due_date ?? d.issue_date ?? d.created_at), description: `${d.number ?? d.kind.replace(/_/g, ' ')} · ${d.direction === 'receivable' ? d.recipient_name : d.issuer_name}`, category: d.category, amount: outstanding(d) * (d.direction === 'receivable' ? 1 : -1), link: `/finance/${d.id}` });
  const txRow = (x: any) => ({ type: 'transaction', id: x.id, date: day(x.txn_date), description: x.description, category: x.category, amount: p(x.amount_gbp) });
  const openDocs = (dir: string) => b.docs.filter((d) => d.direction === dir && d.kind !== 'credit_note' && outstanding(d) > 0 && (dir === 'receivable' ? ['issued', 'part_paid'] : ['approved', 'issued', 'part_paid']).includes(d.status));
  if (metric === 'revenue') return acc.rows.filter((r) => (INCOME as readonly string[]).includes(r.category!));
  if (metric === 'expenses') return acc.rows.filter((r) => !(INCOME as readonly string[]).includes(r.category!));
  if (metric === 'direct_costs') return acc.rows.filter((r) => DIRECT.includes(r.category!));
  if (metric === 'operating_expenses') return acc.rows.filter((r) => !(INCOME as readonly string[]).includes(r.category!) && !DIRECT.includes(r.category!));
  if (metric.startsWith('category:')) return acc.rows.filter((r) => r.category === metric.slice(9));
  if (metric === 'cash_in') return c.rows.filter((r) => r.amount > 0);
  if (metric === 'cash_out') return c.rows.filter((r) => r.amount < 0);
  if (metric === 'receivables') return openDocs('receivable').map(docRow);
  if (metric === 'overdue_receivables') return openDocs('receivable').filter((d) => d.due_date && day(d.due_date) < t).map(docRow);
  if (metric === 'payables') return openDocs('payable').map(docRow);
  if (metric === 'uncategorised' || metric === 'missing_docs' || metric === 'unreconciled') return ops[metric].map(txRow);
  if (metric === 'budget') return planTotals(b, f).lines.map((l) => ({ type: 'plan', id: l.id, date: f.from, description: l.label, category: l.category, amount: Math.round(l.amount) * (l.direction === 'income' ? 1 : -1) }));
  throw bad('Unknown figure.');
}

financehub.get('/finance/hub', async (req, res) => {
  const t = await today();
  const f = filters(req, t);
  const b = await loadBooks(pool, f.companies);
  const len = daysBetween(f.from, f.to);
  const prev = { ...f, from: addDays(f.from, -len - 1), to: addDays(f.from, -1) };
  const cur = kpis(b, f, t), before = kpis(b, prev, t);
  // 12 months of trend to the end of the selected range.
  const end = `${f.to.slice(0, 7)}-01`;
  const trend = Array.from({ length: 12 }, (_, i) => {
    const ms = new Date(Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 12 + i, 1)).toISOString().slice(0, 10);
    const me = addDays(new Date(Date.UTC(+ms.slice(0, 4), +ms.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
    const r = { ...f, from: ms, to: me }, a = accrual(b, r), c = cash(b, r), pl = planTotals(b, r);
    return { month: ms, revenue: a.revenue, expenses: a.expenses, net: a.net, cash_in: c.inflow, cash_out: c.outflow, plan_income: pl.income, plan_expenses: pl.expenses, plan_net: pl.net };
  });
  // Budget v actual by category and by department for the range (accrual actuals).
  const acc = accrual(b, f), plan = planTotals(b, f);
  const byCat = new Map<string, { category: string; budget: number; actual: number }>();
  for (const l of plan.lines) { const k = l.category, x = byCat.get(k) ?? { category: k, budget: 0, actual: 0 }; x.budget += (l.direction === 'income' ? 1 : -1) * l.amount; byCat.set(k, x); }
  for (const r of acc.rows) { const x = byCat.get(r.category!) ?? { category: r.category!, budget: 0, actual: 0 }; x.actual += r.amount; byCat.set(r.category!, x); }
  const budget_by_category = [...byCat.values()].map((x) => ({ ...x, budget: Math.round(x.budget), income: (INCOME as readonly string[]).includes(x.category) }));
  const byDept = new Map<string, { department: string; budget: number; actual: number }>();
  for (const l of plan.lines.filter((x) => x.direction === 'expense')) { const k = l.department ?? 'unassigned', x = byDept.get(k) ?? { department: k, budget: 0, actual: 0 }; x.budget += l.amount; byDept.set(k, x); }
  const deptOf = new Map([...b.docs.map((d) => [d.id, d.department]), ...b.txns.map((x) => [x.id, x.department])] as [string, string][]);
  for (const r of acc.rows.filter((x) => !(INCOME as readonly string[]).includes(x.category!))) {
    const k = deptOf.get(r.id) ?? 'unassigned', x = byDept.get(k) ?? { department: k, budget: 0, actual: 0 }; x.actual -= r.amount; byDept.set(k, x);
  }
  const budget_by_department = [...byDept.values()].map((x) => ({ ...x, budget: Math.round(x.budget) }));
  const ops = opsQueues(b);
  const awaiting = await q(`select f.id, f.kind, f.status, f.total, f.issuer_name, f.recipient_name, f.created_at from finance_documents f where f.company_id = any($1::uuid[]) and f.status in ('submitted','awaiting_approval') order by f.created_at`, [f.companies]);
  // Upcoming 60 days: invoices due, bills due, commitments (payroll, tax, loans, bills).
  const calendar = [
    ...b.docs.filter((d) => outstanding(d) > 0 && d.due_date && d.kind !== 'credit_note' && day(d.due_date) <= addDays(t, 60) && (d.direction === 'receivable' ? ['issued', 'part_paid'] : ['approved', 'issued', 'part_paid']).includes(d.status))
      .map((d) => ({ date: day(d.due_date), kind: d.direction === 'receivable' ? 'invoice_due' : 'bill_due', label: `${d.number ?? d.kind.replace(/_/g, ' ')} · ${d.direction === 'receivable' ? d.recipient_name : d.issuer_name}`, amount: outstanding(d) * (d.direction === 'receivable' ? 1 : -1), overdue: day(d.due_date) < t, link: `/finance/${d.id}` })),
    ...b.commitments.flatMap((c) => occurrences(c, t, addDays(t, 60)).map((o) => ({ date: o.date, kind: c.kind, label: c.label, amount: c.direction === 'in' ? o.amount : -o.amount, overdue: false, certainty: c.certainty }))),
  ].sort((a, z) => a.date.localeCompare(z.date));
  const alerts: { level: 'bad' | 'warn' | 'info'; text: string; metric?: string; tab?: string }[] = [];
  if (!b.accounts.length) alerts.push({ level: 'info', text: 'No bank or cash accounts yet, so cash balance, runway and forecast balances cannot be worked out. Add your accounts and opening balances under Bank & cash.', tab: 'bank' });
  if (cur.overdue_count) alerts.push({ level: 'bad', text: `${cur.overdue_count} overdue invoice${cur.overdue_count === 1 ? '' : 's'}: £${pounds(cur.overdue_receivables)} to collect.`, metric: 'overdue_receivables' });
  // Expense budgets are held as negatives (money out); compare spend with the budget as positive amounts.
  for (const x of budget_by_category.filter((x) => !x.income && -x.budget > 0 && -x.actual > -x.budget * 1.1 && -x.actual + x.budget > 10000))
    alerts.push({ level: 'warn', text: `Over budget: ${x.category.replace(/_/g, ' ')} £${pounds(-x.actual)} against a budget of £${pounds(-x.budget)} for these dates.`, metric: `category:${x.category}` });
  if (ops.uncategorised.length) alerts.push({ level: 'warn', text: `${ops.uncategorised.length} bank item${ops.uncategorised.length === 1 ? '' : 's'} not categorised: they are left out of profit figures until categorised.`, metric: 'uncategorised' });
  if (ops.missing_docs.length) alerts.push({ level: 'info', text: `${ops.missing_docs.length} payment${ops.missing_docs.length === 1 ? '' : 's'} of £100 or more with no bill or receipt attached.`, metric: 'missing_docs' });
  // Unusual spending: a payment over 3× the usual (median) payment in its category over 90 days, and at least £500.
  for (const x of b.txns.filter((x) => p(x.amount_gbp) <= -50000 && x.category && day(x.txn_date) >= addDays(t, -30))) {
    const hist = b.txns.filter((y) => y.id !== x.id && y.category === x.category && p(y.amount_gbp) < 0 && day(y.txn_date) >= addDays(t, -120)).map((y) => -p(y.amount_gbp)).sort((a, z) => a - z);
    if (hist.length >= 5 && -p(x.amount_gbp) > 3 * hist[Math.floor(hist.length / 2)]) alerts.push({ level: 'warn', text: `Unusual payment: £${pounds(-p(x.amount_gbp))} to ${x.counterparty ?? x.description} on ${day(x.txn_date)} is more than 3× the usual ${x.category.replace(/_/g, ' ')} payment.` });
  }
  const fresh = b.accounts.map((a) => {
    const ts = b.txns.filter((x) => x.account_id === a.id);
    const bal = accountBalance(a, b.txns, t);
    return { id: a.id, company_id: a.company_id, company_code: a.company_code, name: a.name, kind: a.kind, currency: a.currency, archived: a.archived, last_four: a.last_four, opening_date: day(a.opening_date), opening_balance: a.opening_balance,
      balance: pounds(bal.own), balance_gbp: pounds(bal.gbp), last_txn: ts.length ? day(ts.at(-1).txn_date) : null,
      last_import: ts.filter((x) => x.source === 'import').map((x) => x.created_at).sort().at(-1) ?? null,
      unreconciled: ts.filter((x) => !x.reconciled).length, reconciled_to: ts.filter((x) => x.reconciled).map((x) => day(x.txn_date)).sort().at(-1) ?? null };
  });
  const collections = b.docs.filter((d) => d.direction === 'receivable' && outstanding(d) > 0 && ['issued', 'part_paid'].includes(d.status) && d.due_date && day(d.due_date) < t)
    .map((d) => ({ id: d.id, number: d.number, who: d.recipient_name, amount: outstanding(d), days_late: daysBetween(day(d.due_date), t), part_paid: d.status === 'part_paid' }))
    .sort((a, z) => z.amount * z.days_late - a.amount * a.days_late);
  res.json({
    today: t, filters: f, kpis: cur, previous: before, previous_range: { from: prev.from, to: prev.to }, trend, budget_by_category, budget_by_department,
    aging: { receivable: aging(b, t, 'receivable'), payable: aging(b, t, 'payable') }, collections, calendar, alerts, accounts: fresh,
    ops: { uncategorised: ops.uncategorised.length, missing_docs: ops.missing_docs.length, unreconciled: ops.unreconciled.length, awaiting_approval: awaiting },
    plans: b.plans.map((x) => ({ id: x.id, company_id: x.company_id, name: x.name, start_date: day(x.start_date), periods: x.periods, period_days: x.period_days, source_note: x.source_note })),
    setup: { accounts: b.accounts.length, transactions: b.txns.length, plan: b.plans.length > 0, commitments: b.commitments.length },
  });
});

financehub.get('/finance/hub/drill', async (req, res) => {
  const t = await today();
  const f = filters(req, t);
  const b = await loadBooks(pool, f.companies);
  const rows = drillRows(b, f, parse(text(60).min(2), req.query.metric), t);
  res.json({ rows, total: rows.reduce((s: number, r: any) => s + r.amount, 0) });
});

// ── Forecast: 13 weeks and 12 months, three scenarios ──
financehub.get('/finance/forecast', async (req, res) => {
  const t = await today();
  const f = filters(req, t);
  const b = await loadBooks(pool, f.companies);
  const opening = cashBalance(b, t);
  const end = addDays(new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) + 11, 1)).toISOString().slice(0, 10), -1);
  const defaults = { collect_delay_days: 0, pay_delay_days: 0, revenue_pct: 0, cost_pct: 0, one_offs: [] };
  // Scenarios come from each company's settings; in a combined view the first company's assumptions apply to all.
  const sc: Record<string, Scenario> = b.settings[0]?.scenarios ?? { base: defaults, optimistic: defaults, pessimistic: defaults };
  const out = Object.fromEntries(Object.entries(sc).map(([k, s]) => {
    const r = forecast(b, t, end, s, opening);
    const min = b.settings.reduce((a, x) => a + p(x.min_cash), 0);
    const low = [...r.weeks, ...r.months].reduce((m, x) => (x.closing < m.closing ? x : m), r.weeks[0]);
    return [k, { ...r, events: k === 'base' ? r.events.filter((e) => e.type !== 'plan') : undefined, lowest: { amount: low.closing, date: low.end }, first_below_min: r.weeks.concat(r.months).find((x) => x.closing < min)?.end ?? null }];
  }));
  // Plan v actual cash by plan period, for periods started so far.
  const plan_vs_actual = b.plans.flatMap((pl) => Array.from({ length: pl.periods }, (_, i) => {
    const ps = addDays(day(pl.start_date), i * pl.period_days), pe = addDays(ps, pl.period_days - 1);
    if (ps > t) return null;
    const r = { from: ps, to: pe < t ? pe : t };
    const plan = planTotals({ ...b, plans: [pl] }, { from: ps, to: pe }), c = cash({ ...b, txns: b.txns.filter((x) => x.company_id === pl.company_id) }, r);
    return { company_id: pl.company_id, period: `P${i + 1}`, start: ps, end: pe, complete: pe < t, plan_in: plan.income, plan_out: plan.expenses, plan_net: plan.net, actual_in: c.inflow, actual_out: c.outflow, actual_net: c.net };
  }).filter(Boolean));
  res.json({ today: t, opening, opening_set: opening != null, min_cash: b.settings.reduce((a, x) => a + p(x.min_cash), 0), scenarios: sc, results: out, plan_vs_actual,
    loans: b.commitments.filter((c) => c.kind === 'loan').map((c) => ({ id: c.id, label: c.label, schedule: occurrences(c, t, addDays(t, 3650)).slice(0, 120) })) });
});

// ── Reports: P&L (accrual), cash flow, balance sheet ──
financehub.get('/finance/reports', async (req, res) => {
  const t = await today();
  const f = filters(req, t);
  const b = await loadBooks(pool, f.companies);
  const acc = accrual(b, f), plan = planTotals(b, f);
  const line = (cat: string) => ({ category: cat, actual: acc.rows.filter((r) => r.category === cat).reduce((s, r) => s + r.amount, 0), budget: Math.round(plan.lines.filter((l) => l.category === cat).reduce((s, l) => s + (l.direction === 'income' ? 1 : -1) * l.amount, 0)) });
  const pnl = { income: INCOME.map(line), direct: DIRECT.map(line), overheads: CATEGORIES.filter((c) => !(INCOME as readonly string[]).includes(c) && !DIRECT.includes(c) && !(FINANCING as readonly string[]).includes(c)).map(line),
    revenue: acc.revenue, gross_profit: acc.gross, net_profit: acc.net, budget_net: plan.net };
  const c = cash(b, f);
  const opening = cashBalance(b, addDays(f.from, -1), f.account), closing = cashBalance(b, f.to, f.account);
  const byCat = (rows: any[]) => Object.entries(rows.reduce((m: any, r) => ({ ...m, [r.category ?? 'uncategorised']: (m[r.category ?? 'uncategorised'] ?? 0) + r.amount }), {})).map(([category, amount]) => ({ category, amount }));
  const fin = c.rows.filter((r) => (FINANCING as readonly string[]).includes(r.category ?? ''));
  const opr = c.rows.filter((r) => !(FINANCING as readonly string[]).includes(r.category ?? ''));
  // Transfers and money moved between group companies are excluded from in/out; a balance check proves the roll-forward.
  const moved = b.txns.filter((x) => (x.transfer_id || x.category === 'transfer' || (b.companies.length > 1 && x.counterparty_company_id && b.companies.includes(x.counterparty_company_id))) && day(x.txn_date) >= f.from && day(x.txn_date) <= f.to && (!f.account || x.account_id === f.account)).reduce((s, x) => s + p(x.amount_gbp), 0);
  // Accounts first opened inside the range bring their opening balance in as a separate line.
  const opened = b.accounts.filter((a) => !a.archived && a.kind !== 'loan' && (!f.account || a.id === f.account) && day(a.opening_date) >= f.from && day(a.opening_date) <= f.to).reduce((s, a) => s + Math.round(p(a.opening_balance) * Number(a.opening_fx_rate)), 0);
  const flow = { operating: byCat(opr), financing: byCat(fin), net_operating: opr.reduce((s, r) => s + r.amount, 0), net_financing: fin.reduce((s, r) => s + r.amount, 0), transfers: moved, opened, opening, closing,
    reconciles: opening == null || closing == null ? null : opening + opened + c.net + moved === closing };
  const asOf = f.to < t ? f.to : t;
  const ar = b.docs.filter((d) => d.direction === 'receivable' && d.kind !== 'credit_note' && ['issued', 'part_paid'].includes(d.status)).reduce((s, d) => s + outstanding(d), 0);
  const ap = b.docs.filter((d) => d.direction === 'payable' && ['approved', 'issued', 'part_paid'].includes(d.status)).reduce((s, d) => s + outstanding(d), 0);
  const loans = b.commitments.filter((x) => x.kind === 'loan' && x.loan_balance != null).reduce((s, x) => s + p(x.loan_balance), 0) - b.accounts.filter((a) => a.kind === 'loan').reduce((s, a) => s + accountBalance(a, b.txns, asOf).gbp, 0);
  const accounts = b.accounts.filter((a) => a.kind !== 'loan').map((a) => ({ name: `${a.company_code} · ${a.name}`, amount: accountBalance(a, b.txns, asOf).gbp }));
  const assets = accounts.reduce((s, a) => s + a.amount, 0) + ar, liabilities = ap + loans;
  res.json({ filters: f, pnl, cashflow: flow, balance_sheet: { as_of: asOf, accounts, receivables: ar, payables: ap, loans, assets, liabilities, net_assets: assets - liabilities } });
});

// ── Bank and cash accounts ──
financehub.get('/finance/accounts', async (req, res) => {
  res.json(await q(`select a.id, a.company_id, a.name, a.kind, a.currency, a.last_four from finance_accounts a where a.company_id = any($1::uuid[]) and not a.archived order by a.name`, [scope(req.access, 'finance.view', req.query.company)]));
});
const accountBody = z.object({ company_id: uuid, name: text(120).min(2), kind: z.enum(['bank', 'savings', 'cash', 'card', 'loan']), currency: z.string().regex(/^[A-Z]{3}$/).default('GBP'),
  opening_balance: signedMoney, opening_fx_rate: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('1'), opening_date: isoDate, last_four: z.string().regex(/^\d{4}$/).nullable().optional() });
financehub.post('/finance/accounts', async (req, res) => {
  const b = parse(accountBody, req.body);
  need(req.access, 'finance.manage', b.company_id);
  if (b.currency === 'GBP' && Number(b.opening_fx_rate) !== 1) throw bad('A GBP account has a rate of 1.');
  const row = await tx(async (db) => {
    const r = await one(`insert into finance_accounts (company_id, name, kind, currency, opening_balance, opening_fx_rate, opening_date, last_four, created_by) values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9) returning *`,
      [b.company_id, b.name, b.kind, b.currency, b.opening_balance, b.opening_fx_rate, b.opening_date, b.last_four ?? null, req.person.id], db);
    await audit(db, req.person.id, b.company_id, 'finance_account', r!.id, 'create', { opening_balance: b.opening_balance, opening_date: b.opening_date });
    return r;
  });
  res.status(201).json(row);
});
financehub.patch('/finance/accounts/:id', async (req, res) => {
  const b = parse(accountBody.omit({ company_id: true }).partial().extend({ archived: z.boolean().optional() }).strict(), req.body);
  const out = await tx(async (db) => {
    const a = await one('select * from finance_accounts where id = $1 for update', [idParam(req.params.id)], db);
    if (!a) throw notFound();
    need(req.access, 'finance.manage', a.company_id);
    if ((b.opening_date || b.opening_balance) && (await one('select 1 from finance_transactions where account_id = $1 and reconciled', [a.id], db))) throw conflict('This account has reconciled transactions, so its opening balance is locked. Unreconcile first if it is wrong.');
    const keys = Object.keys(b);
    if (keys.length) await q(`update finance_accounts set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [a.id, ...keys.map((k) => (b as any)[k])], db);
    await audit(db, req.person.id, a.company_id, 'finance_account', a.id, 'update', Object.fromEntries(keys.map((k) => [k, { from: a[k], to: (b as any)[k] }])));
    return { ok: true };
  });
  res.json(out);
});

// Reconcile: the statement balance on a date must equal the Hub's balance for that date; then everything up to it is ticked.
financehub.post('/finance/accounts/:id/reconcile', async (req, res) => {
  const b = parse(z.object({ statement_date: isoDate, statement_balance: signedMoney }), req.body);
  const out = await tx(async (db) => {
    const a = await one('select * from finance_accounts where id = $1 for update', [idParam(req.params.id)], db);
    if (!a) throw notFound();
    need(req.access, 'finance.manage', a.company_id);
    const ts = await q('select * from finance_transactions where account_id = $1', [a.id], db);
    const hub = accountBalance(a, ts, b.statement_date).own;
    const diff = p(b.statement_balance) - hub;
    if (diff !== 0) throw bad(`The Hub shows £${pounds(hub)} on ${b.statement_date}; the statement shows £${b.statement_balance}. Difference £${pounds(diff)}: look for missing, duplicated or mis-dated items.`, { fields: { statement_balance: `Differs by £${pounds(diff)}` } });
    const n = await q(`update finance_transactions set reconciled = true, reconciled_at = now(), reconciled_by = $3 where account_id = $1 and txn_date <= $2 and not reconciled returning id`, [a.id, b.statement_date, req.person.id], db);
    await audit(db, req.person.id, a.company_id, 'finance_account', a.id, 'reconcile', { statement_date: b.statement_date, statement_balance: b.statement_balance, items: n.length });
    return { reconciled: n.length };
  });
  res.json(out);
});

// ── Transactions ──
financehub.get('/finance/transactions', async (req, res) => {
  const t = await today();
  const f = filters(req, t);
  const status = req.query.status ? parse(z.enum(['uncategorised', 'unreconciled', 'missing_docs']), req.query.status) : null;
  res.json(await q(`select t.*, a.name as account_name, a.currency, pr.name as property_name, d.number as document_number, co.code as company_code,
                           (select count(*)::int from files x where x.entity_type = 'finance_txn' and x.entity_id = t.id) as files
                      from finance_transactions t join finance_accounts a on a.id = t.account_id join companies co on co.id = t.company_id left join properties pr on pr.id = t.property_id left join finance_documents d on d.id = t.document_id
                     where t.company_id = any($1::uuid[]) and t.txn_date between $2 and $3 and ($4::uuid is null or t.account_id = $4) and ($5::text is null or t.department = $5) and ($6::uuid is null or t.property_id = $6)
                       and ($7::text is null or ($7 = 'uncategorised' and t.category is null and t.transfer_id is null) or ($7 = 'unreconciled' and not t.reconciled)
                            or ($7 = 'missing_docs' and t.amount_gbp <= -100 and t.document_id is null and t.transfer_id is null and coalesce(t.category, '') <> 'transfer' and not exists (select 1 from files x where x.entity_type = 'finance_txn' and x.entity_id = t.id)))
                     order by t.txn_date desc, t.created_at desc limit 1000`,
    [f.companies, status ? '1900-01-01' : f.from, status ? '2999-12-31' : f.to, f.account ?? null, f.department ?? null, f.property ?? null, status]));
});
const txnBody = z.object({ account_id: uuid, txn_date: isoDate, amount: signedMoney, fx_rate: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).optional(), description: text(300).min(1), counterparty: text(200).nullable().optional(),
  category: category.nullable().optional(), department: department.nullable().optional(), property_id: uuid.nullable().optional(), counterparty_company_id: uuid.nullable().optional(), note: text(1000).nullable().optional() });
async function accountFor(db: Db, a: any, id: string) {
  const acc = await one('select * from finance_accounts where id = $1', [id], db);
  if (!acc) throw notFound();
  need(a, 'finance.manage', acc.company_id);
  if (acc.archived) throw conflict('This account is archived.');
  return acc;
}
function checkDate(acc: any, d: string) { if (d < day(acc.opening_date)) throw bad(`This account's opening balance is dated ${day(acc.opening_date)}; enter only later transactions, or move the opening date back.`, { fields: { txn_date: 'Before the opening balance' } }); }
financehub.post('/finance/transactions', async (req, res) => {
  const b = parse(txnBody, req.body);
  if (Number(b.amount) === 0) throw bad('Enter an amount.', { fields: { amount: 'Cannot be zero' } });
  const row = await tx(async (db) => {
    const acc = await accountFor(db, req.access, b.account_id);
    checkDate(acc, b.txn_date);
    const rate = acc.currency === 'GBP' ? '1' : b.fx_rate;
    if (!rate) throw bad('Enter the exchange rate to GBP for this foreign-currency account.', { fields: { fx_rate: 'Required' } });
    const r = await one(`insert into finance_transactions (company_id, account_id, txn_date, amount, fx_rate, description, counterparty, category, department, property_id, counterparty_company_id, note, created_by)
                         values ($1,$2,$3,$4::numeric,$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [acc.company_id, acc.id, b.txn_date, b.amount, rate, b.description, b.counterparty ?? null, b.category ?? null, b.department ?? null, b.property_id ?? null, b.counterparty_company_id ?? null, b.note ?? null, req.person.id], db);
    await audit(db, req.person.id, acc.company_id, 'finance_transaction', r!.id, 'create', { amount: b.amount, txn_date: b.txn_date, category: b.category ?? null });
    return r;
  });
  res.status(201).json(row);
});
financehub.patch('/finance/transactions/:id', async (req, res) => {
  const b = parse(txnBody.omit({ account_id: true }).partial().extend({ reconciled: z.boolean().optional() }).strict(), req.body);
  await tx(async (db) => {
    const x = await one('select t.*, a.opening_date from finance_transactions t join finance_accounts a on a.id = t.account_id where t.id = $1 for update', [idParam(req.params.id)], db);
    if (!x) throw notFound();
    need(req.access, 'finance.manage', x.company_id);
    // Reconciled money is fixed: only its coding (category, department, property, note) can change.
    if (x.reconciled && (b.amount || b.txn_date || b.fx_rate)) throw conflict('This item is reconciled to a bank statement, so its date and amount are locked.');
    if (x.transfer_id && (b.amount || b.category)) throw conflict('Change a transfer by deleting it and entering it again.');
    if (b.txn_date) checkDate(x, b.txn_date);
    const keys = Object.keys(b).filter((k) => k !== 'reconciled');
    const sets = keys.map((k, i) => `${k} = $${i + 2}${['amount', 'fx_rate'].includes(k) ? '::numeric' : ''}`);
    const vals = keys.map((k) => (b as any)[k] ?? null);
    if (b.reconciled !== undefined) { vals.push(b.reconciled, req.person.id); sets.push(`reconciled = $${vals.length}`, `reconciled_at = case when $${vals.length} then now() end`, `reconciled_by = case when $${vals.length} then $${vals.length + 1}::uuid end`); }
    if (sets.length) await q(`update finance_transactions set ${sets.join(', ')}, updated_at = now() where id = $1`, [x.id, ...vals], db);
    await audit(db, req.person.id, x.company_id, 'finance_transaction', x.id, 'update', Object.fromEntries(Object.keys(b).map((k) => [k, { from: x[k], to: (b as any)[k] }])));
  });
  res.json({ ok: true });
});
financehub.delete('/finance/transactions/:id', async (req, res) => {
  await tx(async (db) => {
    const x = await one('select * from finance_transactions where id = $1 for update', [idParam(req.params.id)], db);
    if (!x) throw notFound();
    need(req.access, 'finance.manage', x.company_id);
    if (x.reconciled) throw conflict('Reconciled items cannot be deleted.');
    if (x.document_id) throw conflict('This item settles an invoice or bill. Remove the payment from that document first.');
    const ids = x.transfer_id ? (await q('select id from finance_transactions where transfer_id = $1', [x.transfer_id], db)).map((r) => r.id) : [x.id];
    if (x.transfer_id && (await one('select 1 from finance_transactions where transfer_id = $1 and reconciled', [x.transfer_id], db))) throw conflict('One side of this transfer is reconciled.');
    await q(`delete from files where entity_type = 'finance_txn' and entity_id = any($1::uuid[])`, [ids], db);
    await q('delete from finance_transactions where id = any($1::uuid[])', [ids], db);
    await audit(db, req.person.id, x.company_id, 'finance_transaction', x.id, 'delete', { amount: x.amount, txn_date: day(x.txn_date), description: x.description, legs: ids.length });
  });
  res.json({ ok: true });
});
financehub.post('/finance/transactions/:id/files', upload.single('file'), async (req, res) => {
  const x = await one('select * from finance_transactions where id = $1', [idParam(req.params.id)]);
  if (!x) throw notFound();
  need(req.access, 'finance.manage', x.company_id);
  if (!req.file) throw bad('Choose a file.');
  const f = await tx((db) => saveFile(db, { companyId: x.company_id, entityType: 'finance_txn', entityId: x.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id }));
  res.status(201).json({ id: f.id });
});
financehub.get('/finance/transactions/:id/files', async (req, res) => {
  const x = await one('select company_id from finance_transactions where id = $1', [idParam(req.params.id)]);
  if (!x || !can(req.access, 'finance.view', x.company_id)) throw notFound();
  res.json(await q(`select id, original_name, uploaded_at from files where entity_type = 'finance_txn' and entity_id = $1 order by uploaded_at`, [req.params.id]));
});

// Transfer between two of the company's accounts (or two group companies): two linked rows, never income or spending.
financehub.post('/finance/transfers', async (req, res) => {
  const b = parse(z.object({ from_account: uuid, to_account: uuid, txn_date: isoDate, amount: money, description: text(300).min(1), to_amount: money.optional() }), req.body);
  if (b.from_account === b.to_account) throw bad('Choose two different accounts.');
  const out = await tx(async (db) => {
    const a = await accountFor(db, req.access, b.from_account), z2 = await accountFor(db, req.access, b.to_account);
    checkDate(a, b.txn_date); checkDate(z2, b.txn_date);
    if (a.currency !== z2.currency && !b.to_amount) throw bad('These accounts use different currencies: enter the amount received too.', { fields: { to_amount: 'Required' } });
    const id = (await one<{ id: string }>('select gen_random_uuid() id', [], db))!.id;
    const ic = a.company_id !== z2.company_id;
    const toAmt = b.to_amount ?? b.amount;
    const gbp = a.currency === 'GBP' ? Number(b.amount) : z2.currency === 'GBP' ? Number(toAmt) : null;  // the GBP side fixes the rate for the other
    const rate = (acc: any, amt: string) => (acc.currency === 'GBP' ? 1 : gbp != null ? (gbp / Number(amt)).toFixed(6) : acc.opening_fx_rate);
    for (const [acc, amt, other] of [[a, b.amount, z2], [z2, toAmt, a]] as const)
      await q(`insert into finance_transactions (company_id, account_id, txn_date, amount, fx_rate, description, category, transfer_id, counterparty_company_id, created_by)
               values ($1,$2,$3,$4::numeric, $5::numeric, $6, 'transfer', $7, $8, $9)`,
        [acc.company_id, acc.id, b.txn_date, acc === a ? `-${amt}` : amt, rate(acc, amt), b.description, id, ic ? other.company_id : null, req.person.id], db);
    await audit(db, req.person.id, a.company_id, 'finance_transfer', id, 'create', { amount: b.amount, from: a.id, to: z2.id });
    return { transfer_id: id };
  });
  res.status(201).json(out);
});

// Match a bank item to an invoice or bill: records the (part) payment against it, so the bank item is the cash and the
// document is the income or cost. Money in matches receivables, money out matches payables.
financehub.post('/finance/transactions/:id/match', async (req, res) => {
  const b = parse(z.object({ document_id: uuid }), req.body);
  const out = await tx(async (db) => {
    const x = await one('select * from finance_transactions where id = $1 for update', [idParam(req.params.id)], db);
    if (!x) throw notFound();
    need(req.access, 'finance.manage', x.company_id);
    if (x.document_id) throw conflict('This bank item is already matched.');
    if (x.transfer_id) throw conflict('Transfers cannot settle invoices.');
    const d = await one(`select f.*, coalesce((select sum(amount) from finance_payments where document_id = f.id), 0) paid,
                                coalesce((select sum(total) from finance_documents c where c.credits_document_id = f.id and c.status = 'issued'), 0) credited
                           from finance_documents f where f.id = $1 and f.company_id = $2 for update`, [b.document_id, x.company_id], db);
    if (!d) throw notFound();
    const inflow = p(x.amount_gbp) > 0;
    if ((d.direction === 'receivable') !== inflow) throw bad(inflow ? 'Money in can only settle an invoice you issued.' : 'Money out can only settle a bill or claim.');
    const ok = d.direction === 'receivable' ? ['issued', 'part_paid'] : ['approved', 'issued', 'part_paid'];
    if (!ok.includes(d.status)) throw conflict('That document is not open for payment.');
    const amt = Math.abs(p(x.amount_gbp)), left = outstanding(d);
    if (amt > left) throw bad(`This bank item (£${pounds(amt)}) is more than the £${pounds(left)} still owed. Split it, or record the extra separately.`);
    await q(`insert into finance_payments (document_id, amount, paid_on, method, reference, manual, recorded_by, transaction_id) values ($1, $2::numeric, $3, 'bank_transfer', $4, false, $5, $6)`,
      [d.id, pounds(amt), day(x.txn_date), x.description.slice(0, 200), req.person.id, x.id], db);
    await q(`update finance_transactions set document_id = $2, category = coalesce(category, $3), department = coalesce(department, $4), property_id = coalesce(property_id, $5), updated_at = now() where id = $1`,
