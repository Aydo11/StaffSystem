// Remittances and expenses. The AI reads an uploaded file (remittance spreadsheet, receipt photo or PDF, or a list of
// expenses) into suggested lines; a person checks and corrects them, and only then are they saved as bank items.
import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../db.ts';
import { DEPARTMENTS, EXPENSE, INCOME, p } from '../financehub.ts';
import { audit, bad, isoDate, parse, text, uuid } from '../http.ts';
import { need } from '../perm.ts';
import { saveFile, sniff } from '../storage.ts';
import { sheetText } from '../xlsxread.ts';
import { aiRead } from './ai.ts';
import { accountFor, checkDate } from './financehub.ts';
import { upload } from './people.ts';

export const financeimport = Router();
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 12.50');
const pounds = (pence: number) => (pence / 100).toFixed(2);
const properties = (companyId: string) => q(`select id, name, ref, address_line1, postcode from properties where company_id = $1 and status <> 'offboarded' order by name`, [companyId]);
const propertyList = (rows: any[]) => rows.map((r) => `${r.id} | ${r.name} | ${r.ref} | ${r.address_line1}, ${r.postcode}`).join('\n');
const dateOrNull = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const amountStr = (n: number) => pounds(Math.abs(Math.round(n * 100)));

// A file goes to the AI as an image or PDF, or as text when it is a spreadsheet.
function fileInput(file: Express.Multer.File) {
  try { const m = sniff(file.buffer); return { file: { media_type: m, data: file.buffer } }; } catch { /* not an image or PDF */ }
  const s = sheetText(file.buffer, file.originalname);
  return { text: s.text, truncated: s.truncated };
}
function companyOf(req: any) {
  const id = parse(uuid, req.body?.company_id ?? req.query.company);
  need(req.access, 'finance.manage', id);
  return id;
}

// ── Remittances from a managing agent or RSL ──
const remitOut = z.object({
  payer: z.string(), reference: z.string().nullable(), pay_date: z.string().nullable(), net_paid: z.number().nullable(),
  lines: z.array(z.object({ description: z.string(), property_id: z.string().nullable(), kind: z.enum(['income', 'deduction']), category: z.enum([...INCOME, ...EXPENSE]), department: z.enum(DEPARTMENTS).nullable(), amount: z.number() })),
  notes: z.array(z.string()),
});
financeimport.post('/finance/remittances/read', upload.single('file'), async (req, res) => {
  if (!req.file) throw bad('Choose the remittance file.');
  const companyId = companyOf(req);
  const props = await properties(companyId);
  const input = fileInput(req.file);
  const out = await aiRead(companyId, req.person.id, 'remittance_read', `Read this remittance advice sent to us by a managing agent or registered social landlord (for example Dawson).
For each property give the gross rent received as an "income" line (category rent; service_charge for service charges; support_income for support or care funding), and every fee, commission, deduction, recharge, repair or void loss as a "deduction" line with the closest category (managing_agent_fee for management or agent fees and commission; repairs_maintenance for repairs; utilities; other_expense when nothing fits).
Amounts are positive numbers in pounds. Income minus deductions should equal the net amount paid; put net_paid as the total actually paid to us. Use the payment date (YYYY-MM-DD) as pay_date.
Match each line to one of our properties by name, reference, address or postcode and give its id; use null when you are not sure. Our properties (id | name | ref | address):
${propertyList(props)}
Describe lines by property and type only: never include tenant or resident names. Department is housing for rent and fees unless the file says otherwise.
If the file is not a remittance, return no lines and say why in notes. Put anything a person should check (totals that do not add up, lines you could not place) in notes.`, remitOut, input);
  const ids = new Set(props.map((r) => r.id));
  const lines = out.lines.filter((l: any) => l.amount).map((l: any) => ({ ...l, property_id: ids.has(l.property_id) ? l.property_id : null, amount: amountStr(l.amount) }));
  const sum = lines.reduce((s: number, l: any) => s + (l.kind === 'income' ? 1 : -1) * p(l.amount), 0);
  const net = out.net_paid == null ? sum : Math.round(out.net_paid * 100);
  const date = dateOrNull(out.pay_date);
  // Bank items this payment may already be (from a statement import): same amount, within 10 days, not yet explained.
  const matches = await q(`select t.id, t.txn_date, t.amount, t.description, a.name as account_name, t.account_id from finance_transactions t join finance_accounts a on a.id = t.account_id
                            where t.company_id = $1 and t.amount = $2::numeric and t.document_id is null and t.transfer_id is null and t.remittance_id is null and a.currency = 'GBP'
                              and ($3::date is null or t.txn_date between $3::date - 10 and $3::date + 10) order by abs(t.txn_date - coalesce($3::date, t.txn_date)) limit 5`, [companyId, pounds(net), date]);
  const notes = [...out.notes];
  if (sum !== net) notes.unshift(`The lines add up to £${pounds(sum)} but the remittance says £${pounds(net)} was paid. Check the lines before saving.`);
  if ('truncated' in input && input.truncated) notes.unshift('The file is very long, so only the first part was read.');
  res.json({ payer: out.payer, reference: out.reference, pay_date: date, net_paid: pounds(net), lines, notes, matches });
});

const remitBody = z.object({
  company_id: uuid, account_id: uuid, txn_date: isoDate, payer: text(200).min(1), reference: text(200).nullable().optional(), transaction_id: uuid.nullable().optional(),
  lines: z.array(z.object({ description: text(250).min(1), kind: z.enum(['income', 'deduction']), amount: money, category: z.enum([...INCOME, ...EXPENSE]), department: z.enum(DEPARTMENTS).nullable().optional(), property_id: uuid.nullable().optional() })).min(1).max(300),
});
// Saves a checked remittance. With transaction_id the bank item already imported is split into the lines (same total,
// so the balance and any reconciliation stand); otherwise the lines are new bank items, and a later statement import
// recognises the net payment instead of adding it again.
financeimport.post('/finance/remittances', upload.single('file'), async (req, res) => {
  let raw: unknown;
  try { raw = JSON.parse(req.body?.data ?? ''); } catch { throw bad('Send the remittance as data.'); }
  const b = parse(remitBody, raw);
  const out = await tx(async (db) => {
    const acc = await accountFor(db, req.access, b.account_id);
    if (acc.company_id !== b.company_id) throw bad('That account belongs to another company.');
    if (acc.currency !== 'GBP') throw bad('Remittances are recorded in a GBP account.');
    const propIds = [...new Set(b.lines.map((l) => l.property_id).filter(Boolean))];
    if (propIds.length && Number((await one('select count(*) n from properties where id = any($1::uuid[]) and company_id = $2', [propIds, acc.company_id], db))!.n) !== propIds.length) throw bad('A property is not one of this company\'s.');
    const signed = b.lines.map((l) => (l.kind === 'income' ? 1 : -1) * p(l.amount));
    const net = signed.reduce((s, x) => s + x, 0);
    const rid = (await one<{ id: string }>('select gen_random_uuid() id', [], db))!.id;
    let date = b.txn_date, first: any = null;
    if (b.transaction_id) {
      first = await one('select * from finance_transactions where id = $1 and account_id = $2 for update', [b.transaction_id, acc.id], db);
      if (!first) throw bad('That bank item is not in this account.');
      if (first.document_id || first.transfer_id || first.remittance_id) throw bad('That bank item is already explained by an invoice, transfer or remittance.');
      if (p(first.amount) !== net) throw bad(`The lines add up to £${pounds(net)} but the bank item is £${pounds(p(first.amount))}. They must agree before it can be split.`);
      date = String(first.txn_date instanceof Date ? first.txn_date.toISOString() : first.txn_date).slice(0, 10);
    } else checkDate(acc, date);
    const ids: string[] = [];
    for (const [i, l] of b.lines.entries()) {
      const vals = [pounds(signed[i]), `${b.payer}: ${l.description}`, b.payer, l.category, l.department ?? null, l.property_id ?? null, b.reference ?? null, rid];
      if (i === 0 && first) {
        await q(`update finance_transactions set amount = $2::numeric, description = $3, counterparty = $4, category = $5, department = $6, property_id = $7, note = $8, remittance_id = $9, updated_at = now() where id = $1`, [first.id, ...vals], db);
        ids.push(first.id);
      } else {
        const r = await one(`insert into finance_transactions (company_id, account_id, txn_date, amount, fx_rate, description, counterparty, category, department, property_id, note, remittance_id, source, reconciled, reconciled_at, reconciled_by, created_by)
                             values ($1,$2,$3,$4::numeric,1,$5,$6,$7,$8,$9,$10,$11,'remittance',$12,$13,$14,$15) returning id`,
          [acc.company_id, acc.id, date, ...vals, !!first?.reconciled, first?.reconciled_at ?? null, first?.reconciled_by ?? null, req.person.id], db);
        ids.push(r!.id);
      }
    }
    if (req.file) await saveFile(db, { companyId: acc.company_id, entityType: 'finance_txn', entityId: ids[0], name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id, allowSheet: true });
    await audit(db, req.person.id, acc.company_id, 'finance_remittance', rid, 'create', { payer: b.payer, net: pounds(net), lines: b.lines.length, split_transaction: b.transaction_id ?? null });
    return { remittance_id: rid, net: pounds(net), ids };
  });
  res.status(201).json(out);
});

// ── Expenses: a receipt (photo or PDF) or a list (spreadsheet) read into lines to check ──
const expenseOut = z.object({
  items: z.array(z.object({ date: z.string().nullable(), supplier: z.string().nullable(), description: z.string(), amount: z.number(), vat: z.number().nullable(), category: z.enum(EXPENSE), department: z.enum(DEPARTMENTS).nullable(), property_id: z.string().nullable() })),
  notes: z.array(z.string()),
});
financeimport.post('/finance/expenses/read', upload.single('file'), async (req, res) => {
  if (!req.file) throw bad('Choose a receipt or a list of expenses.');
  const companyId = companyOf(req);
  const props = await properties(companyId);
  const input = fileInput(req.file);
  const out = await aiRead(companyId, req.person.id, 'expense_read', `${'file' in input ? 'Read this receipt or invoice as one expense (several only if it is clearly a statement of separate purchases).' : 'Read each expense in this list.'}
For each expense give the date (YYYY-MM-DD), the supplier, a short description of what was bought, the total paid including VAT as a positive number in pounds, the VAT amount if shown (else null), and the closest category: ${EXPENSE.join(', ')}.
Give the property id from this list only when the receipt or list names the property or its address; otherwise null. Our properties (id | name | ref | address):
${propertyList(props)}
Department only when it is obvious (repairs to a house: property; office supplies: admin), else null. Never include tenant or resident names. Put anything unclear in notes.`, expenseOut, input);
  const ids = new Set(props.map((r) => r.id));
  res.json({
    items: out.items.filter((x: any) => x.amount).map((x: any) => ({ txn_date: dateOrNull(x.date), counterparty: x.supplier, description: x.description, amount: amountStr(x.amount), vat: x.vat ? amountStr(x.vat) : null, category: x.category, department: x.department, property_id: ids.has(x.property_id) ? x.property_id : null })),
    notes: [...('truncated' in input && input.truncated ? ['The file is very long, so only the first part was read.'] : []), ...out.notes],
  });
});

const expenseBody = z.object({ account_id: uuid, items: z.array(z.object({ txn_date: isoDate, amount: money, description: text(300).min(1), counterparty: text(200).nullable().optional(),
  category: z.enum(EXPENSE), department: z.enum(DEPARTMENTS).nullable().optional(), property_id: uuid.nullable().optional(), note: text(1000).nullable().optional() })).min(1).max(200) });
// Each expense is money out of the chosen account. If the bank statement already brought in an uncategorised item for
// the same amount within 3 days, that item is coded instead of adding a second one.
financeimport.post('/finance/expenses', async (req, res) => {
  const b = parse(expenseBody, req.body);
  const out = await tx(async (db) => {
    const acc = await accountFor(db, req.access, b.account_id);
    if (acc.currency !== 'GBP') throw bad('Add expenses to a GBP account.');
    const propIds = [...new Set(b.items.map((l) => l.property_id).filter(Boolean))];
    if (propIds.length && Number((await one('select count(*) n from properties where id = any($1::uuid[]) and company_id = $2', [propIds, acc.company_id], db))!.n) !== propIds.length) throw bad('A property is not one of this company\'s.');
    const res2: { id: string; matched: boolean }[] = [];
    for (const it of b.items) {
      checkDate(acc, it.txn_date);
      if (!p(it.amount)) throw bad('An expense has no amount.');
      const hit = await one(`select id from finance_transactions where account_id = $1 and source = 'import' and amount = -$2::numeric and category is null and document_id is null and transfer_id is null and remittance_id is null
                               and txn_date between $3::date - 3 and $3::date + 3 and not (id = any($4::uuid[])) order by abs(txn_date - $3::date) limit 1 for update`, [acc.id, it.amount, it.txn_date, res2.map((r) => r.id)], db);
      if (hit) {
        await q(`update finance_transactions set category = $2, department = $3, property_id = $4, counterparty = coalesce(counterparty, $5), note = coalesce($6, note), updated_at = now() where id = $1`,
          [hit.id, it.category, it.department ?? null, it.property_id ?? null, it.counterparty ?? null, it.note ?? null], db);
        res2.push({ id: hit.id, matched: true });
      } else {
        const r = await one(`insert into finance_transactions (company_id, account_id, txn_date, amount, fx_rate, description, counterparty, category, department, property_id, note, created_by)
                             values ($1,$2,$3,-$4::numeric,1,$5,$6,$7,$8,$9,$10,$11) returning id`,
          [acc.company_id, acc.id, it.txn_date, it.amount, it.description, it.counterparty ?? null, it.category, it.department ?? null, it.property_id ?? null, it.note ?? null, req.person.id], db);
        res2.push({ id: r!.id, matched: false });
      }
    }
    await audit(db, req.person.id, acc.company_id, 'finance_account', acc.id, 'expenses', { added: res2.filter((r) => !r.matched).length, matched: res2.filter((r) => r.matched).length });
    return res2;
  });
  res.status(201).json(out);
});
