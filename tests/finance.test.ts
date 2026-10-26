// Stage 7 acceptance tests: finance (spec §41 item 14), email notifications and failures (item 15), messaging and news.
import { beforeEach, describe, expect, it } from 'vitest';
import { processOutbox } from '../server/outbox.ts';
import { A, as, C, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const TEAM = '00000000-0000-4000-8000-000000000f71';
const invoice = (company: string, lines = [{ description: 'Property inspection service', quantity: '3', rate: '33.33' }]) =>
  ({ company_id: company, kind: 'sales_invoice', recipient_name: 'Example Client Ltd (fictional)', recipient_email: 'client@example.test', lines });

async function issue(id: string) {
  const morgan = await as('morgan'), alex = await as('alex');
  expect((await morgan.post(`/api/finance/documents/${id}/request-approval`)).status).toBe(200);
  expect((await alex.post(`/api/finance/documents/${id}/approve`)).status).toBe(200);
  return (await morgan.post(`/api/finance/documents/${id}/issue`)).body;
}

describe('14 · invoices use the correct legal entity', () => {
  it('names the issuing company, numbers per company, and keeps pennies exact', async () => {
    const morgan = await as('morgan');
    const d = (await morgan.post('/api/finance/documents').send(invoice(C.VH))).body;
    const doc = (await morgan.get(`/api/finance/documents/${d.id}`)).body.document;
    expect(doc).toMatchObject({ issuer_name: 'Valor Housing Ltd', direction: 'receivable', subtotal: '99.99', tax_total: '0.00', total: '99.99' });
    expect((await issue(d.id)).number).toBe('VH-0001');
    const d2 = (await morgan.post('/api/finance/documents').send(invoice(C.VH))).body;
    expect((await issue(d2.id)).number).toBe('VH-0002');
  });
  it('never adds VAT unless the company is set up as VAT registered', async () => {
    const r = await (await as('morgan')).post('/api/finance/documents').send({ ...invoice(C.VH), tax_treatment: 'standard_20' });
    expect(r.status).toBe(400);
    await pool.query(`update company_finance_settings set vat_registered = true, vat_number = 'GB000000000' where company_id = $1`, [C.VH]);
    const ok = (await (await as('morgan')).post('/api/finance/documents').send({ ...invoice(C.VH), tax_treatment: 'standard_20' })).body;
    expect((await pool.query('select tax_total::text, total::text from finance_documents where id = $1', [ok.id])).rows[0]).toEqual({ tax_total: '20.00', total: '119.99' });
  });
  it('the creator cannot approve their own document, and issued documents are corrected by credit note only', async () => {
    const morgan = await as('morgan');
    const d = (await morgan.post('/api/finance/documents').send(invoice(C.VH))).body;
    await morgan.post(`/api/finance/documents/${d.id}/request-approval`);
    expect((await morgan.post(`/api/finance/documents/${d.id}/approve`)).status).toBe(403);
    await (await as('alex')).post(`/api/finance/documents/${d.id}/approve`);
    await morgan.post(`/api/finance/documents/${d.id}/issue`);
    expect((await morgan.patch(`/api/finance/documents/${d.id}`).send({ recipient_name: 'Changed' })).status).toBe(403);
    expect((await morgan.post(`/api/finance/documents/${d.id}/void`)).status).toBe(403);
    // Part payment, then a credit note for the rest closes it.
    expect((await morgan.post(`/api/finance/documents/${d.id}/payments`).send({ amount: '50.00', paid_on: '2026-10-20', method: 'bank_transfer' })).body).toMatchObject({ balance: '49.99', status: 'part_paid' });
    expect((await morgan.post(`/api/finance/documents/${d.id}/payments`).send({ amount: '60.00', paid_on: '2026-10-20', method: 'bank_transfer' })).status).toBe(400);
    const cn = (await morgan.post('/api/finance/documents').send({ ...invoice(C.VH, [{ description: 'Credit for unused hours', quantity: '1', rate: '49.99' }]), kind: 'credit_note', credits_document_id: d.id })).body;
    expect((await issue(cn.id)).number).toBe('CN-0001');
    expect((await pool.query('select status from finance_documents where id = $1', [d.id])).rows[0].status).toBe('credited');
  });
  it('turns an approved timesheet into one payment statement, never two', async () => {
    const sam = await as('sam');
    const ts = (await sam.post('/api/timesheets').send({ appointment_id: A.samVH, period_start: '2026-10-12', period_end: '2026-10-18' })).body;
    await (await as('priya')).post(`/api/timesheets/${ts.id}/decide`).send({ approve: true });
    const morgan = await as('morgan');
    const ps = await morgan.post('/api/finance/from-timesheet').send({ timesheet_id: ts.id });
    expect(ps.status).toBe(201);
    const doc = (await morgan.get(`/api/finance/documents/${ps.body.id}`)).body.document;
    expect(doc).toMatchObject({ kind: 'payment_statement', total: '20.25', recipient_person_id: P.sam });
    expect(doc.notes).toMatch(/not a payslip/);
    expect((await morgan.post('/api/finance/from-timesheet').send({ timesheet_id: ts.id })).status).toBe(409);
  });
  it('a contractor’s timesheet needs a self-billing agreement; contractors submit their own invoices', async () => {
    const sam = await as('sam');
    await pool.query(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'finance_admin', $2, 'test')`, [P.morgan, C.WHM]);
    const ts = (await sam.post('/api/timesheets').send({ appointment_id: A.samWHM, period_start: '2026-10-12', period_end: '2026-10-18' })).body;
    await (await as('jordan')).post(`/api/timesheets/${ts.id}/decide`).send({ approve: true });
    expect((await (await as('morgan')).post('/api/finance/from-timesheet').send({ timesheet_id: ts.id })).status).toBe(400);
    const inv = await sam.post('/api/finance/submissions').send({ company_id: C.WHM, kind: 'contractor_invoice', reference: 'SR-101', lines: [{ description: 'Hinge repair', quantity: '1', rate: '18.00' }] });
    expect(inv.status).toBe(201);
    const d = (await sam.get(`/api/finance/documents/${inv.body.id}`)).body.document;
    expect(d).toMatchObject({ issuer_name: 'Sam Rivers Services (fictional sole trader)', recipient_name: 'Wellbeing Homes Ltd', direction: 'payable', status: 'submitted' });
    expect((await sam.post('/api/finance/submissions').send({ company_id: C.VH, kind: 'contractor_invoice', lines: [{ description: 'x', quantity: '1', rate: '1' }] })).status).toBe(400); // employee there
  });
  it('expense claims: approved by someone else, visible to the claimant, hidden from other staff', async () => {
    const sam = await as('sam');
    const c = (await sam.post('/api/finance/submissions').send({ company_id: C.VH, kind: 'expense_claim', lines: [{ description: 'Parking at Alder House', quantity: '1', rate: '4.50' }] })).body;
    expect((await (await as('casey')).get(`/api/finance/documents/${c.id}`)).status).toBe(404);
    expect((await (await as('priya')).post(`/api/finance/documents/${c.id}/approve`)).status).toBe(200);
  });
});

describe('15 · notifications handle failures', () => {
  it('queues one email per event, retries failures, and marks it failed after repeated errors', async () => {
    process.env.RESEND_API_KEY = 'test'; process.env.EMAIL_FROM = 'hub@example.test';
    try {
      const priya = await as('priya');
      const rev = (await priya.post('/api/reviews').send({ company_id: C.VH, person_id: P.sam, kind: 'periodic', period_start: '2026-07-01', period_end: '2026-09-30', objectives: 'Deliver agreed support.', achievements: 'Support records reviewed.', development: 'Continue reflective practice.', feedback: 'Progress discussed.' })).body;
      expect((await priya.post(`/api/reviews/${rev.id}/publish`)).status).toBe(200);
      const rows = (await pool.query(`select id, status from outbound_messages where category = 'feedback_ready'`)).rows;
      expect(rows).toEqual([{ id: rows[0].id, status: 'queued' }]);
      let calls = 0;
      const failing = async () => { calls++; throw new Error('provider down'); };
      for (let i = 0; i < 5; i++) { await pool.query(`update outbound_messages set next_attempt_at = now()`); await processOutbox(20, failing); }
      expect(calls).toBe(5);
      expect((await pool.query('select status, attempts, last_error from outbound_messages where id = $1', [rows[0].id])).rows[0]).toMatchObject({ status: 'failed', attempts: 5, last_error: 'provider down' });
      // The in-app notification still exists, and the failure appears for an administrator.
      expect((await pool.query(`select count(*)::int n from notifications where person_id = $1 and title like '%review is ready%'`, [P.sam])).rows[0].n).toBe(1);
      const inbox = (await (await as('alex')).get('/api/inbox')).body;
      expect(inbox.some((i: any) => i.kind === 'delivery_failed')).toBe(true);
    } finally { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; }
  });
  it('without an email provider, messages are recorded as not configured — never as sent', async () => {
    const priya = await as('priya');
    const rev = (await priya.post('/api/reviews').send({ company_id: C.VH, person_id: P.sam, kind: 'periodic', period_start: '2026-07-01', period_end: '2026-09-30', objectives: 'Deliver agreed support.', achievements: 'Support records reviewed.', development: 'Continue reflective practice.', feedback: 'Progress discussed.' })).body;
    expect((await priya.post(`/api/reviews/${rev.id}/publish`)).status).toBe(200);
    expect((await pool.query(`select status from outbound_messages where category = 'feedback_ready'`)).rows[0].status).toBe('not_configured');
  });
  it('respects a person switching email off', async () => {
    await (await as('sam')).put('/api/me/preferences').send({ email_enabled: false, categories: [] });
    const priya = await as('priya');
    const rev = (await priya.post('/api/reviews').send({ company_id: C.VH, person_id: P.sam, kind: 'periodic', period_start: '2026-07-01', period_end: '2026-09-30', objectives: 'Deliver agreed support.', achievements: 'Support records reviewed.', development: 'Continue reflective practice.', feedback: 'Progress discussed.' })).body;
    expect((await priya.post(`/api/reviews/${rev.id}/publish`)).status).toBe(200);
    expect((await pool.query(`select count(*)::int n from outbound_messages`)).rows[0].n).toBe(0);
  });
});

describe('messaging and news', () => {
  it('only members read a conversation; a reported message is the only one a moderator sees', async () => {
    const sam = await as('sam');
    const msgs = (await sam.get(`/api/conversations/${TEAM}/messages`)).body.messages;
    expect((await (await as('alex')).get(`/api/conversations/${TEAM}/messages`)).status).toBe(404); // even a super admin
    const id = crypto.randomUUID();
    await sam.post(`/api/conversations/${TEAM}/messages`).field('body', 'Done, all call points worked.').field('client_request_id', id);
    await sam.post(`/api/conversations/${TEAM}/messages`).field('body', 'Done, all call points worked.').field('client_request_id', id); // retry
    expect((await pool.query('select count(*)::int n from messages where conversation_id = $1', [TEAM])).rows[0].n).toBe(2);
    expect((await (await as('priya')).get('/api/me')).body.unreadMessages).toBe(1);
    await sam.post(`/api/messages/${msgs[0].id}/report`).send({ reason: 'Testing reports' });
    const reports = (await (await as('alex')).get('/api/message-reports')).body;
    expect(reports.map((r: any) => r.body)).toEqual(['Please remember the fire alarm test at Alder House this week.']);
  });
  it('conversation members must work for its company; news reaches only its audience', async () => {
    const priya = await as('priya');
    expect((await priya.post('/api/conversations').send({ company_id: C.VH, kind: 'direct', member_ids: [P.jordan] })).status).toBe(400);
    const n = (await priya.post('/api/news').send({ company_ids: [C.VH], category: 'operations', title: 'Valor only', body: 'Only Valor staff see this.' })).body;
    await priya.post(`/api/news/${n.id}/publish`);
    expect((await (await as('taylor')).get('/api/news')).body.some((x: any) => x.id === n.id)).toBe(false); // Wellbeing Housing only
    expect((await (await as('sam')).get('/api/news')).body.some((x: any) => x.id === n.id)).toBe(true);
  });
});
