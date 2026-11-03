// Remittances and expenses: the AI's reading is checked by a person, a remittance splits the bank item it explains (or is
// recognised when the statement arrives later), and expenses code an imported bank item instead of adding a second one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAiCaller } from '../server/routes/ai.ts';
import { sheetText } from '../server/xlsxread.ts';
import { xlsx } from '../web/xlsx.ts';
import { as, C, pool, resetDb } from './helpers.ts';

let reply: any = null, lastPrompt: any = null;
beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-not-used'; setAiCaller(async ({ prompt }) => { lastPrompt = prompt; return { output: reply, input_tokens: 100, output_tokens: 50 }; }); });
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });
beforeEach(async () => { await resetDb(); await pool.query('update ai_settings set enabled = true where company_id = $1', [C.VH]); });

const sheet = async () => Buffer.from(await xlsx([{ name: 'Remittance', rows: [['Property', 'Rent', 'Fee'], ['Grove Lane', 1000, 120]] }]).arrayBuffer());
const csv = (rows: string[]) => Buffer.from(['Date,Description,Amount', ...rows].join('\n'));

describe('remittances and expenses', () => {
  it('reads a spreadsheet into text, keeping numbers and dates', async () => {
    const t = sheetText(await sheet(), 'r.xlsx').text;
    expect(t).toContain('## Sheet: Remittance');
    expect(t).toContain('Grove Lane\t1000\t120');
    expect(() => sheetText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'old.xls')).toThrow(/xlsx/);
  });

  it('reads a remittance, splits the imported bank payment into income and fees, and keeps the total', async () => {
    const alex = await as('alex');
    const prop = (await pool.query('select id from properties where company_id = $1 order by ref limit 1', [C.VH])).rows[0].id;
    const acc = (await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Current', kind: 'bank', opening_balance: '0', opening_date: '2026-10-01' })).body;
    await alex.post(`/api/finance/accounts/${acc.id}/import`).attach('file', csv(['2026-10-20,DAWSON REMIT,880.00']), 's.csv');
    const bank = (await pool.query('select id from finance_transactions where account_id = $1', [acc.id])).rows[0].id;

    reply = { payer: 'Dawson', reference: 'R-77', pay_date: '2026-10-18', net_paid: 880, notes: [],
      lines: [{ description: 'Rent', property_id: prop, kind: 'income', category: 'rent', department: 'housing', amount: 1000 },
        { description: 'Management fee 12%', property_id: 'not-ours', kind: 'deduction', category: 'managing_agent_fee', department: 'housing', amount: 120 }] };
    const r = await alex.post('/api/finance/remittances/read').field('company_id', C.VH).attach('file', await sheet(), 'remit.xlsx');
    expect(r.status).toBe(200);
    expect(JSON.stringify(lastPrompt)).toContain('Grove Lane');           // the sheet went to the AI as text
    expect(r.body.lines[1].property_id).toBeNull();                       // an id that is not ours is dropped
    expect(r.body.notes).toEqual([]);
    expect(r.body.matches.map((m: any) => m.id)).toEqual([bank]);

    const data = { company_id: C.VH, account_id: acc.id, txn_date: '2026-10-18', payer: 'Dawson', reference: 'R-77', transaction_id: bank,
      lines: r.body.lines.map((l: any) => ({ ...l, amount: l.kind === 'income' ? '1000.00' : '125.00' })) };
    expect((await alex.post('/api/finance/remittances').field('data', JSON.stringify(data))).status).toBe(400);   // does not add up to the bank item
    data.lines[1].amount = '120.00';
    const s = await alex.post('/api/finance/remittances').field('data', JSON.stringify(data)).attach('file', await sheet(), 'remit.xlsx');
    expect(s.status).toBe(201);
    const rows = (await pool.query('select amount::text, category, txn_date::text, remittance_id from finance_transactions where account_id = $1 order by amount desc', [acc.id])).rows;
    expect(rows.map((x) => [x.amount, x.category, x.txn_date])).toEqual([['1000.00', 'rent', '2026-10-20'], ['-120.00', 'managing_agent_fee', '2026-10-20']]);
    const h = (await alex.get(`/api/finance/hub?company=${C.VH}&from=2026-10-01&to=2026-10-31`)).body;
    expect(h.kpis.cash_balance).toBe(88000);
    expect(h.kpis.revenue).toBe(100000);
    expect((await pool.query(`select count(*)::int n from files where entity_type = 'finance_txn' and entity_id = $1`, [bank])).rows[0].n).toBe(1);
    // Re-importing the same statement adds nothing.
    expect((await alex.post(`/api/finance/accounts/${acc.id}/import`).attach('file', csv(['2026-10-20,DAWSON REMIT,880.00']), 's.csv')).body.duplicates).toBe(1);
  });

  it('a remittance saved before the statement is recognised when the statement is imported', async () => {
    const alex = await as('alex');
    const acc = (await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Current', kind: 'bank', opening_balance: '0', opening_date: '2026-10-01' })).body;
    const data = { company_id: C.VH, account_id: acc.id, txn_date: '2026-10-18', payer: 'Dawson', lines: [{ description: 'Rent', kind: 'income', amount: '500.00', category: 'rent' }, { description: 'Fee', kind: 'deduction', amount: '60.00', category: 'managing_agent_fee' }] };
    expect((await alex.post('/api/finance/remittances').field('data', JSON.stringify(data))).status).toBe(201);
    const imp = (await alex.post(`/api/finance/accounts/${acc.id}/import`).attach('file', csv(['2026-10-19,DAWSON,440.00', '2026-10-19,Shop,-9.99']), 's.csv')).body;
    expect([imp.imported, imp.matched]).toEqual([1, 1]);
    expect((await alex.get(`/api/finance/hub?company=${C.VH}&from=2026-10-01&to=2026-10-31`)).body.kpis.cash_balance).toBe(44000 - 999);
  });

  it('expenses: a receipt is read, an imported bank item is coded rather than doubled, and staff cannot use it', async () => {
    const alex = await as('alex');
    const acc = (await alex.post('/api/finance/accounts').send({ company_id: C.VH, name: 'Current', kind: 'bank', opening_balance: '100.00', opening_date: '2026-10-01' })).body;
    await alex.post(`/api/finance/accounts/${acc.id}/import`).attach('file', csv(['2026-10-10,B&Q 1234,-42.50']), 's.csv');
    reply = { items: [{ date: '2026-10-09', supplier: 'B&Q', description: 'Paint', amount: 42.5, vat: 7.08, category: 'repairs_maintenance', department: 'property', property_id: null }], notes: [] };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await alex.post('/api/finance/expenses/read').field('company_id', C.VH).attach('file', png, 'receipt.png');
    expect(r.status).toBe(200);
    expect(lastPrompt[0].type).toBe('image');                              // the photo went to the AI as an image
    expect(r.body.items[0]).toMatchObject({ txn_date: '2026-10-09', amount: '42.50', vat: '7.08', category: 'repairs_maintenance' });
    const s = (await alex.post('/api/finance/expenses').send({ account_id: acc.id, items: [r.body.items[0], { ...r.body.items[0], description: 'Brushes', amount: '5.00' }] })).body;
    expect(s.map((x: any) => x.matched)).toEqual([true, false]);
    const rows = (await pool.query('select amount::text, category from finance_transactions where account_id = $1 order by amount', [acc.id])).rows;
    expect(rows).toEqual([{ amount: '-42.50', category: 'repairs_maintenance' }, { amount: '-5.00', category: 'repairs_maintenance' }]);
    await pool.query('update ai_settings set enabled = false where company_id = $1', [C.VH]);
    expect((await alex.post('/api/finance/expenses/read').field('company_id', C.VH).attach('file', png, 'receipt.png')).body.error).toBe('ai_disabled');
    expect((await (await as('sam')).post('/api/finance/expenses').send({ account_id: acc.id, items: [r.body.items[0]] })).status).toBe(403);
  });
});
