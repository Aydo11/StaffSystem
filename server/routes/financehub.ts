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
