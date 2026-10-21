import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need, scope } from '../perm.ts';
import { enqueue } from '../outbox.ts';
import { saveFile } from '../storage.ts';
import { timesheetCalc } from './visits.ts';
import { upload } from './people.ts';

export const finance = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 12.50');
const qty = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Use a number like 1 or 2.5');
const TAX_RATE: Record<string, number> = { no_vat: 0, outside_scope: 0, exempt: 0, zero_rated: 0, standard_20: 20, reduced_5: 5 };
const lineSchema = z.object({ description: text(500).min(2), quantity: qty, unit: text(30).default('item'), rate: money });
const LABEL: Record<string, string> = { sales_invoice: 'Invoice', contractor_invoice: 'Contractor invoice', payment_statement: 'Payment statement', expense_claim: 'Expense claim', credit_note: 'Credit note' };

// Who may see a document: finance in its company; the named recipient once issued; the person who submitted it; expense approvers for claims.
function roleFor(a: Access, d: any) {
  if (can(a, 'finance.view', d.company_id)) return 'finance';
  if (d.kind === 'expense_claim' && can(a, 'expenses.approve', d.company_id) && d.submitted_by !== a.personId) return 'approver';
  if (d.submitted_by === a.personId) return 'submitter';
  if (d.recipient_person_id === a.personId && ['issued', 'part_paid', 'paid', 'credited', 'approved'].includes(d.status)) return 'recipient';
  return null;
}
async function loadDoc(a: Access, id: string, db: Db = pool) {
  const d = await one(`select f.*, c.code as company_code, c.name as company_name, ${name('cb')} as created_by_name, ${name('ab')} as approved_by_name, p.name as property_name
                         from finance_documents f join companies c on c.id = f.company_id join people cb on cb.id = f.created_by left join people ab on ab.id = f.approved_by left join properties p on p.id = f.property_id
                        where f.id = $1`, [id], db);
  const role = d && roleFor(a, d);
  if (!role) throw notFound();
  return { d, role };
}
// Totals are worked out in SQL numeric so pennies are exact: each line rounds to pence, VAT rounds once per document.
async function writeLines(db: Db, docId: string, treatment: string, lines: z.infer<typeof lineSchema>[]) {
  await q('delete from finance_lines where document_id = $1', [docId], db);
  let i = 0;
  for (const l of lines) await q(`insert into finance_lines (document_id, position, description, quantity, unit, rate, tax_rate, amount) values ($1,$2,$3,$4::numeric,$5,$6::numeric,$7, round($4::numeric * $6::numeric, 2))`, [docId, i++, l.description, l.quantity, l.unit, l.rate, TAX_RATE[treatment]], db);
  await q(`update finance_documents f set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax, updated_at = now()
             from (select coalesce(sum(amount), 0) sub, round(coalesce(sum(amount * tax_rate / 100), 0), 2) tax from finance_lines where document_id = $1) t where f.id = $1`, [docId], db);
}
async function checkTax(db: Db, companyId: string, treatment: string) {
  const s = await one('select vat_registered from company_finance_settings where company_id = $1', [companyId], db);
  if (TAX_RATE[treatment] > 0 && !s?.vat_registered) throw bad('This company is not set up as VAT registered, so VAT cannot be charged. Change the finance settings first if that is wrong.', { fields: { tax_treatment: 'Not VAT registered' } });
}
async function balance(db: Db, id: string) {
  return (await one<{ b: string }>(`select (f.total - coalesce((select sum(amount) from finance_payments where document_id = f.id), 0)
                                             - coalesce((select sum(total) from finance_documents c where c.credits_document_id = f.id and c.status = 'issued'), 0))::text b
                                       from finance_documents f where f.id = $1`, [id], db))!.b;
}

finance.get('/finance/documents', async (req, res) => {
  const a = req.access;
  const rows = await q(`select f.id, f.company_id, f.kind, f.direction, f.number, f.issuer_name, f.recipient_name, f.recipient_person_id, f.submitted_by, f.created_by, f.issue_date, f.due_date, f.total, f.status, f.reference,
                               c.code as company_code, c.name as company_name, (f.status in ('issued','part_paid') and f.due_date < ${LONDON_TODAY}) as overdue
                          from finance_documents f join companies c on c.id = f.company_id
                         where (f.company_id = any($1::uuid[]) or f.submitted_by = $2 or f.recipient_person_id = $2 or (f.kind = 'expense_claim' and f.company_id = any($3::uuid[])))
                           and ($4::uuid is null or f.company_id = $4) order by f.created_at desc limit 500`,
    [companiesWith(a, 'finance.view'), a.personId, companiesWith(a, 'expenses.approve'), req.query.company ? parse(uuid, req.query.company) : null]);
  res.json(rows.filter((d) => roleFor(a, d)).map((d) => ({ ...d, role: roleFor(a, d) })));
});

finance.get('/finance/documents/:id', async (req, res) => {
  const a = req.access;
  const { d, role } = await loadDoc(a, idParam(req.params.id));
  const [lines, payments, queries, credits, settings, files] = await Promise.all([
    q('select * from finance_lines where document_id = $1 order by position', [d.id]),
    q(`select p.*, ${name('r')} as recorded_by_name from finance_payments p join people r on r.id = p.recorded_by where p.document_id = $1 order by p.paid_on`, [d.id]),
    q(`select x.*, ${name('r')} as raised_by_name, ${name('an')} as answered_by_name from finance_queries x join people r on r.id = x.raised_by left join people an on an.id = x.answered_by where x.document_id = $1 order by x.created_at`, [d.id]),
    q(`select id, number, total, status from finance_documents where credits_document_id = $1`, [d.id]),
    one('select payment_instructions, vat_registered, vat_number from company_finance_settings where company_id = $1', [d.company_id]),
    q(`select id, original_name from files where entity_type = 'finance' and entity_id = $1`, [d.id]),
  ]);
  const own = d.created_by === a.personId || d.submitted_by === a.personId;
  const approvePerm = d.kind === 'expense_claim' ? 'expenses.approve' : 'finance.approve';
  res.json({
    document: d, lines, payments, queries, credits, files, balance: await balance(pool, d.id),
    company: { ...(await one('select legal_name, company_number, registered_address, details_verified from companies where id = $1', [d.company_id])), ...settings },
    role,
    can: {
      edit: role === 'finance' && d.status === 'draft',
      requestApproval: role === 'finance' && d.status === 'draft',
      approve: !own && can(a, approvePerm, d.company_id) && ['awaiting_approval', 'submitted'].includes(d.status),
      issue: role === 'finance' && d.status === 'approved' && d.direction === 'receivable' || (role === 'finance' && d.status === 'approved' && d.kind === 'payment_statement'),
      pay: role === 'finance' && ['issued', 'part_paid', 'approved'].includes(d.status) && !(d.direction === 'receivable' && d.status === 'approved'),
      credit: role === 'finance' && d.direction === 'receivable' && d.kind === 'sales_invoice' && ['issued', 'part_paid'].includes(d.status),
      void: role === 'finance' && ['draft', 'awaiting_approval', 'approved', 'submitted'].includes(d.status),
      query: true,
    },
  });
});

// Company-issued documents: sales invoices, payment statements, credit notes. Drafted by finance; issuer is the company itself.
finance.post('/finance/documents', async (req, res) => {
  const b = parse(z.object({
    company_id: uuid, kind: z.enum(['sales_invoice', 'payment_statement', 'credit_note']), recipient_name: text(200).min(2), recipient_person_id: uuid.nullable().optional(),
    recipient_email: z.email().nullable().optional(), recipient_address: text(500).nullable().optional(), period_start: isoDate.nullable().optional(), period_end: isoDate.nullable().optional(),
    reference: text(200).nullable().optional(), property_id: uuid.nullable().optional(), tax_treatment: z.enum(['no_vat', 'outside_scope', 'exempt', 'zero_rated', 'standard_20', 'reduced_5']).default('no_vat'),
    terms: text(2000).nullable().optional(), notes: text(2000).nullable().optional(), credits_document_id: uuid.nullable().optional(), lines: z.array(lineSchema).min(1).max(100),
  }), req.body);
  need(req.access, 'finance.manage', b.company_id);
  const d = await tx(async (db) => {
    await checkTax(db, b.company_id, b.tax_treatment);
    if (b.kind === 'credit_note') {
      const orig = await one('select * from finance_documents where id = $1 and company_id = $2', [b.credits_document_id, b.company_id], db);
      if (!orig || !['issued', 'part_paid'].includes(orig.status) || orig.kind !== 'sales_invoice') throw bad('A credit note must correct an issued invoice of this company.');
    }
    const co = await one<{ legal_name: string | null; name: string }>('select legal_name, name from companies where id = $1', [b.company_id], db);
    const row = await one(`insert into finance_documents (company_id, kind, direction, issuer_name, recipient_name, recipient_person_id, recipient_email, recipient_address, period_start, period_end, reference, property_id, tax_treatment, terms, notes, credits_document_id, created_by)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [b.company_id, b.kind, b.kind === 'payment_statement' ? 'payable' : 'receivable', co!.legal_name ?? co!.name, b.recipient_name, b.recipient_person_id ?? null, b.recipient_email ?? null, b.recipient_address ?? null,
        b.period_start ?? null, b.period_end ?? null, b.reference ?? null, b.property_id ?? null, b.tax_treatment, b.terms ?? null, b.notes ?? null, b.credits_document_id ?? null, req.person.id], db);
    await writeLines(db, row.id, b.tax_treatment, b.lines);
    await audit(db, req.person.id, b.company_id, 'finance_document', row.id, 'create', { kind: b.kind });
    return row;
  });
  res.status(201).json(d);
});

// Submitted to a company by a person: contractor invoices (from the contractor) and expense claims (from staff).
finance.post('/finance/submissions', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, kind: z.enum(['contractor_invoice', 'expense_claim']), reference: text(200).nullable().optional(), period_start: isoDate.nullable().optional(), period_end: isoDate.nullable().optional(),
    property_id: uuid.nullable().optional(), notes: text(2000).nullable().optional(), lines: z.array(lineSchema).min(1).max(50) }), req.body);
  const ap = await one(`select a.*, c.legal_name, c.name as company_name from appointments a join companies c on c.id = a.company_id where a.person_id = $1 and a.company_id = $2 and ${ACTIVE_APPT('a')} order by a.relationship = 'contractor' desc limit 1`, [req.person.id, b.company_id]);
  if (!ap) throw bad('You need a current role with this company.');
  if (b.kind === 'contractor_invoice' && ap.relationship !== 'contractor') throw bad('Only contractors submit invoices. For costs you paid yourself, make an expense claim.');
  const d = await tx(async (db) => {
    const row = await one(`insert into finance_documents (company_id, kind, direction, issuer_name, recipient_name, submitted_by, reference, period_start, period_end, property_id, notes, status, created_by)
                           values ($1,$2,'payable',$3,$4,$5,$6,$7,$8,$9,$10,'submitted',$5) returning id`,
      [b.company_id, b.kind, b.kind === 'contractor_invoice' ? ap.legal_employer_name ?? req.person.full_name : req.person.full_name, ap.legal_name ?? ap.company_name, req.person.id, b.reference ?? null, b.period_start ?? null, b.period_end ?? null, b.property_id ?? null, b.notes ?? null], db);
    await writeLines(db, row.id, 'no_vat', b.lines);
    await audit(db, req.person.id, b.company_id, 'finance_document', row.id, 'submit', { kind: b.kind });
    return row;
  });
  res.status(201).json(d);
});
finance.post('/finance/documents/:id/files', upload.single('file'), async (req, res) => {
  const { d, role } = await loadDoc(req.access, idParam(req.params.id));
  if (!['finance', 'submitter'].includes(role) || !['draft', 'submitted'].includes(d.status)) throw forbidden();
  if (!req.file) throw bad('Choose a receipt or document.');
  const f = await tx((db) => saveFile(db, { companyId: d.company_id, entityType: 'finance', entityId: d.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id }));
  res.status(201).json({ id: f.id });
});

finance.patch('/finance/documents/:id', async (req, res) => {
  const { d, role } = await loadDoc(req.access, idParam(req.params.id));
  if (role !== 'finance' || d.status !== 'draft') throw forbidden('Only drafts can be edited. Issued documents are corrected with a credit note.');
  const b = parse(z.object({ recipient_name: text(200).min(2), recipient_email: z.email().nullable(), recipient_address: text(500).nullable(), period_start: isoDate.nullable(), period_end: isoDate.nullable(), reference: text(200).nullable(),
    tax_treatment: z.enum(['no_vat', 'outside_scope', 'exempt', 'zero_rated', 'standard_20', 'reduced_5']), terms: text(2000).nullable(), notes: text(2000).nullable(), lines: z.array(lineSchema).min(1).max(100) }).partial().strict(), req.body);
  await tx(async (db) => {
    const { lines, ...fields } = b;
    const treatment = fields.tax_treatment ?? d.tax_treatment;
    await checkTax(db, d.company_id, treatment);
    const keys = Object.keys(fields);
    if (keys.length) await q(`update finance_documents set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [d.id, ...keys.map((k) => (fields as any)[k])], db);
    const current = lines ?? (await q('select description, quantity::text as quantity, unit, rate::text as rate from finance_lines where document_id = $1 order by position', [d.id], db));
    await writeLines(db, d.id, treatment, current as any);
  });
  res.json({ ok: true });
});

const STEPS = ['request-approval', 'approve', 'reject', 'issue', 'void'] as const;
finance.post('/finance/documents/:id/:step', async (req, res, next) => {
  if (!(STEPS as readonly string[]).includes(req.params.step)) return next(); // payments, queries: handled by their own routes below
  const step = parse(z.enum(STEPS), req.params.step);
  const a = req.access;
  const out = await tx(async (db) => {
    const { d, role } = await loadDoc(a, idParam(req.params.id), db);
    const own = d.created_by === a.personId || d.submitted_by === a.personId;
    if (step === 'request-approval') {
      if (role !== 'finance' || d.status !== 'draft') throw forbidden();
      await q(`update finance_documents set status = 'awaiting_approval', updated_at = now() where id = $1`, [d.id], db);
    } else if (step === 'approve' || step === 'reject') {
      // Nobody approves their own document or their own claim.
      if (own) throw forbidden('Someone else must approve this.');
      need(a, d.kind === 'expense_claim' ? 'expenses.approve' : 'finance.approve', d.company_id);
      if (!['awaiting_approval', 'submitted'].includes(d.status)) throw conflict('This is not waiting for approval.');
      const note = step === 'reject' ? parse(text(1000).min(3, 'Say why'), req.body?.note) : null;
      await q(`update finance_documents set status = $2, approved_by = case when $2 = 'approved' then $3::uuid else null end, approved_at = case when $2 = 'approved' then now() else null end,
                 notes = case when $4::text is null then notes else coalesce(notes || E'\\n', '') || 'Rejected: ' || $4 end, updated_at = now() where id = $1`, [d.id, step === 'approve' ? 'approved' : 'rejected', a.personId, note], db);
      const who = d.submitted_by ?? d.created_by;
      await notify(db, who, d.company_id, `${LABEL[d.kind]} ${step === 'approve' ? 'approved' : 'rejected'}`, `/finance/${d.id}`, note ?? undefined);
    } else if (step === 'issue') {
      if (role !== 'finance' || d.status !== 'approved' || !(d.direction === 'receivable' || d.kind === 'payment_statement')) throw forbidden();
      // Each company has its own number series, taken under a row lock so two issues can never share a number.
      const series = d.kind === 'credit_note' ? ['credit_prefix', 'next_credit_number'] : d.kind === 'payment_statement' ? ['statement_prefix', 'next_statement_number'] : ['invoice_prefix', 'next_invoice_number'];
      const s = await one(`select ${series[0]} as prefix, ${series[1]} as n, payment_terms_days from company_finance_settings where company_id = $1 for update`, [d.company_id], db);
      const number = `${s.prefix}-${String(s.n).padStart(4, '0')}`;
      await q(`update company_finance_settings set ${series[1]} = ${series[1]} + 1 where company_id = $1`, [d.company_id], db);
      await q(`update finance_documents set number = $2, status = 'issued', issue_date = coalesce(issue_date, ${LONDON_TODAY}), due_date = coalesce(due_date, ${LONDON_TODAY} + $3::int), issued_at = now(), updated_at = now() where id = $1`, [d.id, number, s.payment_terms_days], db);
      if (d.kind === 'credit_note') {
        const bal = Number(await balance(db, d.credits_document_id));
        if (bal < 0) throw bad('This credit note is larger than the amount still owed on the invoice.');
        if (bal === 0) await q(`update finance_documents set status = 'credited', updated_at = now() where id = $1`, [d.credits_document_id], db);
      }
      if (d.recipient_person_id) {
        await notify(db, d.recipient_person_id, d.company_id, `${LABEL[d.kind]} ${number} is ready to view`, `/finance/${d.id}`);
        await enqueue(db, { person_id: d.recipient_person_id, company_id: d.company_id, category: 'invoice_available', dedup: `doc:${d.id}`, subject: `${LABEL[d.kind]} available`, body: `A ${LABEL[d.kind].toLowerCase()} is ready for you. Sign in to the Valor & Wellbeing Hub to view it.`, link: `/finance/${d.id}` });
      }
      return { number };
    } else {
      if (role !== 'finance' || !['draft', 'awaiting_approval', 'approved', 'submitted'].includes(d.status)) throw forbidden('Issued documents cannot be voided. Raise a credit note instead.');
      await q(`update finance_documents set status = 'void', updated_at = now() where id = $1`, [d.id], db);
    }
    await audit(db, a.personId, d.company_id, 'finance_document', d.id, step, {});
    return { ok: true };
  });
  res.json(out);
});

finance.post('/finance/documents/:id/payments', async (req, res) => {
  const b = parse(z.object({ amount: money, paid_on: isoDate, method: z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'other']), reference: text(200).nullable().optional() }), req.body);
  const out = await tx(async (db) => {
    const { d, role } = await loadDoc(req.access, idParam(req.params.id), db);
    if (role !== 'finance') throw forbidden();
    const payable = d.direction === 'payable' && ['approved', 'issued', 'part_paid'].includes(d.status);
    if (!payable && !['issued', 'part_paid'].includes(d.status)) throw conflict('Payments can be recorded only once the document is issued or approved.');
    await one(`select id from finance_documents where id = $1 for update`, [d.id], db);
    const bal = await balance(db, d.id);
    const over = (await one<{ o: boolean }>('select $1::numeric > $2::numeric o', [b.amount, bal], db))!.o;
    if (over) throw bad(`That is more than the £${bal} still outstanding.`, { fields: { amount: 'More than the balance' } });
    await q('insert into finance_payments (document_id, amount, paid_on, method, reference, recorded_by) values ($1,$2::numeric,$3,$4,$5,$6)', [d.id, b.amount, b.paid_on, b.method, b.reference ?? null, req.person.id], db);
    const left = await balance(db, d.id);
    const status = Number(left) === 0 ? 'paid' : 'part_paid';
    await q('update finance_documents set status = $2, updated_at = now() where id = $1', [d.id, status], db);
    await audit(db, req.person.id, d.company_id, 'finance_payment', d.id, 'record', { amount: b.amount });
    return { balance: left, status };
  });
  res.status(201).json(out);
});

finance.post('/finance/documents/:id/queries', async (req, res) => {
  const { d } = await loadDoc(req.access, idParam(req.params.id));
  const body = parse(text(2000).min(3), req.body?.body);
  await q('insert into finance_queries (document_id, raised_by, body) values ($1,$2,$3)', [d.id, req.person.id, body]);
  for (const r of await q<{ person_id: string }>(`select distinct g.person_id from role_grants g join role_permissions rp on rp.role_key = g.role_key where rp.permission_key = 'finance.manage' and (g.company_id = $1 or g.company_id is null) and g.revoked_at is null and g.person_id <> $2`, [d.company_id, req.person.id]))
    await notify(pool, r.person_id, d.company_id, `Query on ${LABEL[d.kind].toLowerCase()} ${d.number ?? ''}`.trim(), `/finance/${d.id}`);
  res.status(201).json({ ok: true });
});
finance.post('/finance/queries/:id/answer', async (req, res) => {
  const x = await one('select fq.*, f.company_id, f.id as doc_id from finance_queries fq join finance_documents f on f.id = fq.document_id where fq.id = $1', [idParam(req.params.id)]);
  if (!x) throw notFound();
  need(req.access, 'finance.manage', x.company_id);
  const answer = parse(text(2000).min(2), req.body?.answer);
  await q('update finance_queries set answer = $2, answered_by = $3, answered_at = now() where id = $1', [x.id, answer, req.person.id]);
  await notify(pool, x.raised_by, x.company_id, 'Your finance query has been answered', `/finance/${x.doc_id}`);
  res.json({ ok: true });
});

// From an approved timesheet: a payment statement (staff) or, only where a self-billing agreement exists, a contractor invoice.
finance.post('/finance/from-timesheet', async (req, res) => {
  const { timesheet_id } = parse(z.object({ timesheet_id: uuid }), req.body);
  const out = await tx(async (db) => {
    const t = await one(`select t.*, a.relationship, a.legal_employer_name, ${name('p')} as person_name, p.email from timesheets t join appointments a on a.id = t.appointment_id join people p on p.id = t.person_id where t.id = $1`, [timesheet_id], db);
    if (!t || !req.access.perms.has(t.company_id)) throw notFound();
    need(req.access, 'finance.manage', t.company_id);
    if (t.status !== 'approved') throw bad('Only approved timesheets can be used.');
    if (t.person_id === req.person.id) throw forbidden('You cannot prepare a payment for your own time.');
    const s = await one('select self_billing_enabled from company_finance_settings where company_id = $1', [t.company_id], db);
    const contractor = t.relationship === 'contractor';
    if (contractor && !s.self_billing_enabled) throw bad('Self-billing is not set up for this company, so the contractor must send their own invoice.');
    const calc = await timesheetCalc(db, t.appointment_id, t.period_start, t.period_end);
    // Lines use the rates frozen at approval-time calculation; each rate band is one exact line.
    const groups = new Map<string, { minutes: number; cost: number; rate: string; type: string }>();
    for (const day of calc.days.filter((x: any) => x.visit_minutes + x.other_minutes > 0)) {
      if (day.cost === null) throw bad('Some approved days have no hourly or daily rate. Set the rate first.');
      const k = `${day.rate_type}:${day.amount}`;
      const g = groups.get(k) ?? { minutes: 0, cost: 0, rate: day.amount, type: day.rate_type };
      g.minutes += day.visit_minutes + day.other_minutes;
      groups.set(k, g);
    }
    const lines: { description: string; quantity: string; unit: string; rate: string }[] = [];
    for (const g of groups.values()) {
      const days = calc.days.filter((x: any) => x.visit_minutes + x.other_minutes > 0 && x.rate_type === g.type && x.amount === g.rate);
      const cost = (await one<{ c: string }>('select sum(x::numeric)::text c from unnest($1::text[]) x', [days.map((x: any) => x.cost)], db))!.c;
      lines.push({ description: `${Math.floor(g.minutes / 60)} h ${g.minutes % 60} min approved work, ${t.period_start} to ${t.period_end}, at £${g.rate} ${g.type === 'hourly' ? 'per hour' : 'per day'}`, quantity: '1', unit: 'period', rate: cost });
    }
    // Rates are preserved: the document must match the cost frozen when the timesheet was approved.
    const same = (await one<{ ok: boolean }>('select coalesce((select sum(x::numeric) from unnest($1::text[]) x), 0) = $2::numeric ok', [lines.map((l) => l.rate), t.cost_estimate ?? '0'], db))!.ok;
    if (!same) throw conflict('Rates have changed since this timesheet was approved. Return and re-approve the timesheet first so the figures match.');
    const co = await one<{ legal_name: string | null; name: string }>('select legal_name, name from companies where id = $1', [t.company_id], db);
    try {
      const row = await one(`insert into finance_documents (company_id, kind, direction, issuer_name, recipient_name, recipient_person_id, recipient_email, period_start, period_end, reference, source_timesheet_id, self_billing, notes, created_by)
                             values ($1,$2,'payable',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [t.company_id, contractor ? 'contractor_invoice' : 'payment_statement', contractor ? t.legal_employer_name ?? t.person_name : co!.legal_name ?? co!.name, contractor ? co!.legal_name ?? co!.name : t.person_name,
          t.person_id, t.email, t.period_start, t.period_end, `Timesheet ${t.period_start} to ${t.period_end}`, t.id, contractor,
          contractor ? 'Self-billed invoice under the agreement recorded in finance settings.' : 'Payment statement: a record of approved work and agreed rates. It is not a payslip and shows no tax or deductions.', req.person.id], db);
      await writeLines(db, row.id, 'no_vat', lines as any);
      await audit(db, req.person.id, t.company_id, 'finance_document', row.id, 'from_timesheet', { timesheet_id });
      return row;
    } catch (e: any) {
      if (e.code === '23505' && e.constraint === 'one_document_per_timesheet') throw conflict('A document already exists for this timesheet, so it cannot be billed or paid twice.');
      throw e;
    }
  });
  res.status(201).json(out);
});

// ── Settings ──
finance.get('/finance/settings', async (req, res) => {
  res.json(await q(`select s.*, c.code as company_code, c.name as company_name from company_finance_settings s join companies c on c.id = s.company_id where s.company_id = any($1::uuid[]) order by c.name`, [companiesWith(req.access, 'finance.view')]));
});
finance.put('/finance/settings/:company', async (req, res) => {
  const companyId = idParam(req.params.company);
  need(req.access, 'finance.manage', companyId);
  const b = parse(z.object({ invoice_prefix: z.string().regex(/^[A-Z0-9]{1,8}$/), credit_prefix: z.string().regex(/^[A-Z0-9]{1,8}$/), statement_prefix: z.string().regex(/^[A-Z0-9]{1,8}$/),
    payment_instructions: text(2000).nullable(), payment_terms_days: z.coerce.number().int().min(0).max(365), vat_registered: z.boolean(), vat_number: text(20).nullable(),
    self_billing_enabled: z.boolean(), self_billing_agreement_ref: text(200).nullable() }), req.body);
  if (b.vat_registered && !b.vat_number) throw bad('Enter the VAT number.', { fields: { vat_number: 'Required when VAT registered' } });
  if (b.self_billing_enabled && !b.self_billing_agreement_ref) throw bad('Record the self-billing agreement reference.', { fields: { self_billing_agreement_ref: 'Required' } });
  const keys = Object.keys(b);
  await q(`update company_finance_settings set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where company_id = $1`, [companyId, ...keys.map((k) => (b as any)[k])]);
  await audit(pool, req.person.id, companyId, 'finance_settings', companyId, 'update', { vat_registered: b.vat_registered, self_billing_enabled: b.self_billing_enabled });
  res.json({ ok: true });
});

// ── Budgets, cash flow, scenarios ──
finance.get('/finance/budgets', async (req, res) => {
  const year = parse(z.coerce.number().int().min(2020).max(2100), req.query.year);
  const cs = scope(req.access, 'finance.view', req.query.company);
  res.json({
    budgets: await q(`select b.*, c.code as company_code from budgets b join companies c on c.id = b.company_id where b.company_id = any($1::uuid[]) and extract(year from b.month) = $2 order by b.month, b.category`, [cs, year]),
    // Staffing cost estimate from approved timesheets, by the month the period ends. Allocated per company, so shared staff are never counted twice.
    staffing_estimate: await q(`select t.company_id, date_trunc('month', t.period_end)::date::text as month, sum(t.cost_estimate)::text as estimate from timesheets t
                                 where t.company_id = any($1::uuid[]) and t.status = 'approved' and extract(year from t.period_end) = $2 group by 1, 2`, [cs, year]),
  });
});
finance.put('/finance/budgets', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, month: z.string().regex(/^\d{4}-\d{2}-01$/), category: z.enum(['staffing', 'cover', 'training', 'premises', 'other']), amount: money, actual: money.nullable().optional(), note: text(500).nullable().optional() }), req.body);
  need(req.access, 'finance.manage', b.company_id);
  res.json(await one(`insert into budgets (company_id, month, category, amount, actual, note) values ($1,$2,$3,$4::numeric,$5::numeric,$6)
                      on conflict (company_id, month, category) do update set amount = excluded.amount, actual = excluded.actual, note = excluded.note returning *`, [b.company_id, b.month, b.category, b.amount, b.actual ?? null, b.note ?? null]));
});
finance.get('/finance/cashflow', async (req, res) => {
  const company = parse(uuid, req.query.company);
  need(req.access, 'finance.view', company);
  const settings = await one('select * from cashflow_settings where company_id = $1', [company]);
  const lines = await q('select * from cashflow_lines where company_id = $1 order by month, kind, label', [company]);
  const scenarios = await q(`select s.*, ${name('p')} as created_by_name from finance_scenarios s left join people p on p.id = s.created_by where s.company_id = $1 order by s.created_at desc`, [company]);
  if (!settings) return res.json({ settings: null, lines, scenarios, projection: [] });
  // Projection in SQL numeric: 12 months from the opening month, base and each scenario.
  const projection = await q(`
    with m as (select (date_trunc('month', $2::date) + make_interval(months => g))::date as month from generate_series(0, 11) g),
    base as (select m.month, coalesce(sum(case when l.kind = 'income' then l.forecast else -l.forecast end), 0) as net,
                    coalesce(sum(case when l.kind = 'expense' then l.forecast end), 0) as expenses,
                    sum(case when l.actual is null then null when l.kind = 'income' then l.actual else -l.actual end) as actual_net
               from m left join cashflow_lines l on l.company_id = $1 and l.month = m.month group by m.month)
    select month::text, net::text, actual_net::text, ($3::numeric + sum(net) over (order by month))::text as balance,
           (select coalesce(json_agg(json_build_object('id', s.id, 'balance', ($3::numeric + (select sum(b2.net + coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(s.adjustments) x where (x->>'month')::date = b2.month), 0)
                                                                                    - round(b2.expenses * coalesce(s.supplier_increase_percent, 0) / 100, 2)) from base b2 where b2.month <= base.month))::text)), '[]')
              from finance_scenarios s where s.company_id = $1) as scenarios
      from base order by month`, [company, settings.opening_month, settings.opening_balance]);
  res.json({ settings, lines, scenarios, projection });
});
finance.put('/finance/cashflow/settings', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, opening_balance: z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/), opening_month: z.string().regex(/^\d{4}-\d{2}-01$/) }), req.body);
  need(req.access, 'finance.manage', b.company_id);
  await q(`insert into cashflow_settings (company_id, opening_balance, opening_month) values ($1,$2::numeric,$3) on conflict (company_id) do update set opening_balance = excluded.opening_balance, opening_month = excluded.opening_month`, [b.company_id, b.opening_balance, b.opening_month]);
  res.json({ ok: true });
});
finance.post('/finance/cashflow/lines', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, month: z.string().regex(/^\d{4}-\d{2}-01$/), kind: z.enum(['income', 'expense']), label: text(200).min(2), forecast: money, actual: money.nullable().optional(), note: text(500).nullable().optional(), id: uuid.optional() }), req.body);
  need(req.access, 'finance.manage', b.company_id);
  const row = b.id
    ? await one(`update cashflow_lines set month = $3, kind = $4, label = $5, forecast = $6::numeric, actual = $7::numeric, note = $8 where id = $1 and company_id = $2 returning *`, [b.id, b.company_id, b.month, b.kind, b.label, b.forecast, b.actual ?? null, b.note ?? null])
    : await one(`insert into cashflow_lines (company_id, month, kind, label, forecast, actual, note) values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7) returning *`, [b.company_id, b.month, b.kind, b.label, b.forecast, b.actual ?? null, b.note ?? null]);
  if (!row) throw notFound();
  res.status(201).json(row);
});
finance.post('/finance/scenarios', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, name: text(200).min(3), kind: z.enum(['delayed_income', 'cover_costs', 'unexpected_expenditure', 'supplier_increase', 'other']), assumptions: text(4000).min(5),
    adjustments: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}-01$/), label: text(200).min(1), amount: z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/) })).max(60).default([]),
    supplier_increase_percent: z.coerce.number().min(0).max(100).nullable().optional(), response: text(4000).nullable().optional() }), req.body);
  need(req.access, 'finance.manage', b.company_id);
  res.status(201).json(await one(`insert into finance_scenarios (company_id, name, kind, assumptions, adjustments, supplier_increase_percent, response, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [b.company_id, b.name, b.kind, b.assumptions, JSON.stringify(b.adjustments), b.supplier_increase_percent ?? null, b.response ?? null, req.person.id]));
});

// ── Continuity ──
finance.get('/continuity', async (req, res) => {
  const cs = scope(req.access, null, req.query.company).filter((c) => can(req.access, 'continuity.manage', c) || can(req.access, 'governance.view', c));
  res.json(await q(`select p.*, c.code as company_code, c.name as company_name, (select array_agg(${name('d')}) from people d where d.id = any(p.deputies)) as deputy_names,
                           (select json_agg(e order by e.held_on desc) from continuity_exercises e where e.plan_id = p.id) as exercises
                      from continuity_plans p join companies c on c.id = p.company_id where p.company_id = any($1::uuid[]) order by c.code, p.scenario`, [cs]));
});
const planBody = z.object({ scenario: z.enum(['staff_shortage', 'it_failure', 'office_loss', 'emergency', 'supplier_failure', 'other']), title: text(200).min(3), plan: text(20000).min(10), deputies: z.array(uuid).max(10), fallback: text(8000).nullable(), next_test_on: isoDate.nullable() });
finance.post('/continuity', async (req, res) => {
  const b = parse(planBody.extend({ company_id: uuid, deputies: z.array(uuid).max(10).default([]) }), req.body);
  need(req.access, 'continuity.manage', b.company_id);
  res.status(201).json(await one(`insert into continuity_plans (company_id, scenario, title, plan, deputies, fallback, next_test_on, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [b.company_id, b.scenario, b.title, b.plan, b.deputies, b.fallback ?? null, b.next_test_on ?? null, req.person.id]));
});
finance.patch('/continuity/:id', async (req, res) => {
  const p = await one('select * from continuity_plans where id = $1', [idParam(req.params.id)]);
  if (!p) throw notFound();
  need(req.access, 'continuity.manage', p.company_id);
  const b = parse(planBody.partial().strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  res.json(await one(`update continuity_plans set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() where id = $1 returning *`, [p.id, ...keys.map((k) => (b as any)[k]), req.person.id]));
});
finance.post('/continuity/:id/exercises', async (req, res) => {
  const p = await one('select * from continuity_plans where id = $1', [idParam(req.params.id)]);
  if (!p) throw notFound();
  need(req.access, 'continuity.manage', p.company_id);
  const b = parse(z.object({ held_on: isoDate, participants: text(1000).nullable().optional(), what_happened: text(8000).min(5), outcome: z.enum(['worked', 'partly_worked', 'did_not_work']), lessons: text(4000).nullable().optional() }), req.body);
  const e = await one('insert into continuity_exercises (plan_id, held_on, participants, what_happened, outcome, lessons, recorded_by) values ($1,$2,$3,$4,$5,$6,$7) returning *', [p.id, b.held_on, b.participants ?? null, b.what_happened, b.outcome, b.lessons ?? null, req.person.id]);
  await audit(pool, req.person.id, p.company_id, 'continuity_exercise', e.id, 'record', { outcome: b.outcome });
  res.status(201).json(e);
});
