// Finance hub: the plan reconciles to the 2.4 model, cash never double counts transfers or matched payments, the
// forecast rolls forward and plan only fills gaps, reconciliation checks the statement, and staff cannot see it.
import { beforeEach, describe, expect, it } from 'vitest';
import { forecast, loadBooks, occurrences } from '../server/financehub.ts';
import { as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(async () => { await resetDb(); await pool.query('select load_valor_plan()'); });  // the seed adds VH after the migrations run
const hub = async (qs: string) => (await (await as('alex')).get(`/api/finance/hub?company=${C.VH}&${qs}`)).body;

describe('finance hub', () => {
  it('loads the 2.4 plan from 1 April 2026 with the model totals', async () => {
    const h = await hub('from=2026-04-01&to=2026-04-28');
    expect(h.kpis.budget_income).toBe(13591942);
    expect(h.kpis.budget_expenses).toBe(12788385);
    expect(h.kpis.budget_net).toBe(803557);
    expect(h.kpis.cash_balance).toBeNull();                       // no accounts: never shown as £0
    expect(h.alerts.some((a: any) => a.tab === 'bank')).toBe(true);
  });

  it('counts cash once: transfers and matched invoices are not double counted, and the cash flow rolls forward', async () => {
    const alex = await as('alex');
    const acc = (await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Current account', kind: 'bank', opening_balance: '1000.00', opening_date: '2026-10-01' })).body;
    const sav = (await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Savings', kind: 'savings', opening_balance: '0', opening_date: '2026-10-01' })).body;
    const add = (b: object) => alex.post('/api/finance/transactions').send({ account_id: acc.id, ...b });
    expect((await add({ txn_date: '2026-10-05', amount: '500.00', description: 'HB remittance', category: 'rent' })).status).toBe(201);
    expect((await add({ txn_date: '2026-10-06', amount: '-200.00', description: 'Card shop' })).status).toBe(201);   // uncategorised
    expect((await add({ txn_date: '2026-09-30', amount: '5.00', description: 'Too early' })).status).toBe(400);
    expect((await alex.post('/api/finance/transfers').send({ from_account: acc.id, to_account: sav.id, txn_date: '2026-10-07', amount: '300.00', description: 'To savings' })).status).toBe(201);
    const inv = (await pool.query(`insert into finance_documents (company_id, kind, direction, number, issuer_name, recipient_name, issue_date, due_date, subtotal, total, status, created_by, category)
                                   values ($1,'sales_invoice','receivable','VH-0001','Valor','Council','2026-10-02','2026-10-09',400,400,'issued',$2,'support_income') returning id`, [C.VH, P.alex])).rows[0].id;
    const t = (await add({ txn_date: '2026-10-10', amount: '400.00', description: 'Council payment' })).body;
    expect((await alex.post(`/api/finance/transactions/${t.id}/match`).send({ document_id: inv })).body.status).toBe('paid');

    const h = await hub('from=2026-10-01&to=2026-10-31');
    expect(h.kpis.cash_balance).toBe(170000);                     // 1000 + 500 − 200 + 400; the transfer moves money, it does not spend it
    expect(h.kpis.cash_in).toBe(90000);
    expect(h.kpis.cash_out).toBe(20000);
    expect(h.kpis.revenue).toBe(90000);                            // invoice 400 + unlinked rent 500; the matched bank item is not counted again
    expect(h.ops.uncategorised).toBe(1);
    const r = (await alex.get(`/api/finance/reports?company=${C.VH}&from=2026-10-01&to=2026-10-31`)).body;
    expect(r.cashflow.reconciles).toBe(true);
    expect(r.cashflow.opening + r.cashflow.opened + r.cashflow.net_operating + r.cashflow.net_financing + r.cashflow.transfers).toBe(r.cashflow.closing);
    const drill = (await alex.get(`/api/finance/hub/drill?company=${C.VH}&from=2026-10-01&to=2026-10-31&metric=revenue`)).body;
    expect(drill.total).toBe(h.kpis.revenue);

    // Reconciliation: the statement must agree to the penny.
    expect((await alex.post(`/api/finance/accounts/${acc.id}/reconcile`).send({ statement_date: '2026-10-10', statement_balance: '1500.00' })).status).toBe(400);
    expect((await alex.post(`/api/finance/accounts/${acc.id}/reconcile`).send({ statement_date: '2026-10-10', statement_balance: '1400.00' })).body.reconciled).toBe(4);
    expect((await alex.patch(`/api/finance/transactions/${t.id}`).send({ amount: '1.00' })).status).toBe(409);
  });

  it('forecast: balances roll forward, and plan only fills the gap left by committed items', async () => {
    const alex = await as('alex');
    await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Current account', kind: 'bank', opening_balance: '2500.00', opening_date: '2026-10-01' });
    const b = await loadBooks(pool, [C.VH]);
    const sc = { collect_delay_days: 0, pay_delay_days: 0, revenue_pct: 0, cost_pct: 0, one_offs: [] };
    const sumIn = (ev: any[], from: string, to: string) => ev.filter((e) => e.date >= from && e.date <= to).reduce((s, e) => s + e.amount, 0);
    const f0 = forecast(b, '2026-11-02', '2027-10-31', sc, 250000);
    expect(f0.weeks[0].opening).toBe(250000);
    for (let i = 1; i < 13; i++) expect(f0.weeks[i].opening).toBe(f0.weeks[i - 1].closing);
    for (const w of f0.weeks) expect(w.closing).toBe(w.opening + w.net);
    expect(sumIn(f0.events, '2026-11-11', '2026-12-08')).toBe(803557);          // P9 (11 Nov–8 Dec) in full = the model's £8,035.57
    await alex.post('/api/finance/commitments').send({ company_id: C.VH, kind: 'payroll', label: 'Payroll', direction: 'out', amount: '500.00', frequency: 'once', next_date: '2026-11-20', certainty: 'committed', category: 'staffing' });
    const f1 = forecast(await loadBooks(pool, [C.VH]), '2026-11-02', '2027-10-31', sc, 250000);
    expect(sumIn(f1.events, '2026-11-11', '2026-12-08')).toBe(803557);          // the payroll replaces part of the planned staffing, not on top of it
    expect(f1.events.filter((e) => e.type === 'committed' && e.category === 'staffing')).toHaveLength(1);
    const pess = forecast(b, '2026-11-02', '2027-10-31', { ...sc, revenue_pct: -5 }, 250000);
    expect(pess.months.at(-1)!.closing).toBeLessThan(f0.months.at(-1)!.closing);
  });

  it('loan repayments split interest and principal and stop when repaid; staff cannot see finance', async () => {
    const s = occurrences({ next_date: '2026-12-01', frequency: 'monthly', amount: '600.00', loan_balance: '1200.00', interest_rate: '12' }, '2026-01-01', '2028-01-01');
    expect(s.map((o) => o.interest)).toEqual([1200, 612, 18]);
    expect(s.at(-1)!.balance_after).toBe(0);
    expect(s.reduce((a, o) => a + (o.principal ?? 0), 0)).toBe(120000);
    expect(occurrences({ next_date: '2027-01-31', frequency: 'monthly', amount: '1.00' }, '2027-01-01', '2027-03-31').map((o) => o.date)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect((await (await as('sam')).get(`/api/finance/hub?company=${C.VH}`)).status).toBe(403);
  });
});
