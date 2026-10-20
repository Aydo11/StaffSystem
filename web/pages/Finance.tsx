import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

const KIND: Record<string, string> = { sales_invoice: 'Invoice', contractor_invoice: 'Contractor invoice', payment_statement: 'Payment statement', expense_claim: 'Expense claim', credit_note: 'Credit note' };
const DOC_STATUS: Record<string, [string, string]> = { draft: ['planned', 'Draft'], submitted: ['review', 'Submitted'], awaiting_approval: ['review', 'Awaiting approval'], approved: ['info', 'Approved'], issued: ['info', 'Issued'], part_paid: ['review', 'Part paid'], paid: ['verified', 'Paid'], rejected: ['action', 'Rejected'], credited: ['ended', 'Credited'], void: ['ended', 'Void'] };
const TAX: [string, string][] = [['no_vat', 'No VAT (not VAT registered)'], ['outside_scope', 'Outside the scope of VAT'], ['exempt', 'Exempt'], ['zero_rated', 'Zero rated'], ['standard_20', 'Standard rate 20%'], ['reduced_5', 'Reduced rate 5%']];
type Line = { description: string; quantity: string; unit: string; rate: string };

function LinesEditor({ lines, onChange, errors }: { lines: Line[]; onChange: (l: Line[]) => void; errors: Record<string, string> }) {
  const set = (i: number, k: keyof Line, v: string) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Lines</legend>
      {lines.map((l, i) => (
        <div key={i} className="card" style={{ padding: 12, marginBottom: 8 }}>
          <Field label={`Line ${i + 1} description`} error={errors[`lines.${i}.description`]}><input name={`l${i}d`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} /></Field>
          <div className="form-grid">
            <Field label="Quantity" error={errors[`lines.${i}.quantity`]}><input name={`l${i}q`} inputMode="decimal" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} /></Field>
            <Field label="Unit"><input name={`l${i}u`} value={l.unit} onChange={(e) => set(i, 'unit', e.target.value)} /></Field>
            <Field label="Rate (£)" error={errors[`lines.${i}.rate`]}><input name={`l${i}r`} inputMode="decimal" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></Field>
          </div>
          {lines.length > 1 && <Button variant="ghost" onClick={() => onChange(lines.filter((_, j) => j !== i))}>Remove line</Button>}
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...lines, { description: '', quantity: '1', unit: 'item', rate: '' }])}>Add a line</Button>
      <p className="small muted">Totals are worked out exactly by the server when you save. VAT is never added unless your company is set up as VAT registered.</p>
    </fieldset>
  );
}

type Tab = 'documents' | 'mine' | 'budgets' | 'cashflow' | 'continuity' | 'settings';
export function Finance() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const fin = hub.can('finance.view');
  const tab = (params.get('tab') as Tab) ?? (fin ? 'documents' : 'mine');
  const tabs: [Tab, string][] = [...(fin ? [['documents', 'Documents'] as [Tab, string]] : []), ['mine', 'My claims and statements'], ...(fin ? [['budgets', 'Budgets'], ['cashflow', 'Cash flow and scenarios']] as [Tab, string][] : []),
    ...(hub.can('continuity.manage') || hub.can('governance.view') ? [['continuity', 'Continuity'] as [Tab, string]] : []), ...(hub.can('finance.manage') ? [['settings', 'Settings'] as [Tab, string]] : [])];
  return (
    <>
      <PageHead title="Finance" intro="Each company issues and approves its own documents under its own name and numbering. Nobody approves their own submission." />
      <Tabs label="Finance sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'documents' && fin && <Documents />}
      {tab === 'mine' && <Mine />}
      {tab === 'budgets' && fin && <Budgets />}
      {tab === 'cashflow' && fin && <Cashflow />}
      {tab === 'continuity' && <Continuity />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

function DocTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty>No documents.</Empty>;
  return (
    <div className="table-wrap"><table><thead><tr><th>Document</th><th>From → To</th><th>Company</th><th>Due</th><th className="num">Total</th><th>Status</th></tr></thead>
      <tbody>{rows.map((d) => <tr key={d.id}><td><Link to={`/finance/${d.id}`}>{KIND[d.kind]} {d.number ?? '(no number yet)'}</Link><div className="muted small">{d.direction === 'receivable' ? 'Money in' : 'Money out'}{d.reference && ` · ${d.reference}`}</div></td>
        <td className="small">{d.issuer_name} → {d.recipient_name}</td><td><CompanyBadge code={d.company_code} name={d.company_name} /></td><td>{fmtDate(d.due_date)}{d.overdue && <div><Status s="action" text="Overdue" /></div>}</td><td className="num">{money(d.total)}</td><td><Status s={DOC_STATUS[d.status][0]} text={DOC_STATUS[d.status][1]} /></td></tr>)}</tbody></table></div>
  );
}

function Documents() {
  const hub = useHub();
  const nav = useNavigate();
  const d = useApi<any[]>(`/finance/documents${hub.q()}`);
  const ts = useApi<any[]>(`/timesheets${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const [fromTs, setFromTs] = useState(false);
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.manage'));
  const create = useSubmit(async () => { const r = await post('/finance/documents', { ...f, recipient_email: f.recipient_email || null, recipient_address: f.recipient_address || null, reference: f.reference || null, terms: f.terms || null }); nav(`/finance/${r.id}`); });
  const fromTimesheet = useSubmit(async (id: string) => { const r = await post('/finance/from-timesheet', { timesheet_id: id }); nav(`/finance/${r.id}`); });
  const approved = (ts.data ?? []).filter((t) => t.status === 'approved' && t.person_id !== hub.me.person.id && hub.can('finance.manage', t.company_id));
  return (
    <>
      {cos.length > 0 && <div className="row" style={{ marginBottom: 16 }}>
        <Button onClick={() => setF({ company_id: hub.company !== 'all' && hub.can('finance.manage', hub.company) ? hub.company : cos[0].id, kind: 'sales_invoice', recipient_name: '', recipient_email: '', recipient_address: '', reference: '', tax_treatment: 'no_vat', terms: '', lines: [{ description: '', quantity: '1', unit: 'item', rate: '' }] })}>New invoice</Button>
        <Button variant="secondary" onClick={() => setFromTs(true)}>Payment statement from a timesheet</Button></div>}
      {d.error && <LoadError error={d.error} />}
      {d.loading && !d.data ? <Skeleton /> : <DocTable rows={(d.data ?? []).filter((x) => x.role === 'finance')} />}
      <Dialog open={!!f} onClose={() => setF(null)} title="New invoice" footer={<Button busy={create.busy} onClick={() => create.run()}>Save draft</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <Field label="Issued by (company)" hint="The invoice is issued in this company's legal name with its own numbering."><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.legal_name ?? c.name}</option>)}</select></Field>
          <Field label="Bill to" error={create.error?.fields.recipient_name}><input name="recipient_name" value={f.recipient_name} onChange={(e) => setF({ ...f, recipient_name: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Their email" optional error={create.error?.fields.recipient_email}><input name="recipient_email" type="email" value={f.recipient_email} onChange={(e) => setF({ ...f, recipient_email: e.target.value })} /></Field><Field label="Reference" optional><input name="reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field></div>
          <Field label="Their address" optional><textarea name="recipient_address" value={f.recipient_address} onChange={(e) => setF({ ...f, recipient_address: e.target.value })} /></Field>
          <Field label="Tax treatment" error={create.error?.fields.tax_treatment}><select name="tax_treatment" value={f.tax_treatment} onChange={(e) => setF({ ...f, tax_treatment: e.target.value })}>{TAX.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <LinesEditor lines={f.lines} onChange={(lines) => setF({ ...f, lines })} errors={create.error?.fields ?? {}} />
          <Field label="Terms" optional><textarea name="terms" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={fromTs} onClose={() => setFromTs(false)} title="Payment statement from a timesheet">
        <p className="small muted">Uses the rates frozen when the timesheet was approved. Each timesheet can be used once. Contractors need a self-billing agreement; otherwise they send their own invoice.</p>
        <ErrorSummary error={fromTimesheet.error} />
        {approved.length === 0 ? <Empty>No approved timesheets.</Empty> : <ul className="list">{approved.map((t) => <li key={t.id}><span>{t.person_name} — {t.job_title} <span className="badge co">{t.company_code}</span><br /><span className="small muted">{fmtDate(t.period_start)} – {fmtDate(t.period_end)} · {money(t.cost_estimate)}</span></span><Button variant="secondary" busy={fromTimesheet.busy} onClick={() => fromTimesheet.run(t.id)}>Create</Button></li>)}</ul>}
      </Dialog>
    </>
  );
}

function Mine() {
  const hub = useHub();
  const nav = useNavigate();
  const d = useApi<any[]>('/finance/documents');
  const [f, setF] = useState<any>(null);
  const contractorCos = hub.me.appointments.filter((a) => a.relationship === 'contractor' && a.status === 'active');
  const submit = useSubmit(async () => {
    const r = await post('/finance/submissions', { company_id: f.company_id, kind: f.kind, reference: f.reference || null, lines: f.lines });
    if (f.file) await upload(`/finance/documents/${r.id}/files`, f.file, f.file.name);
    nav(`/finance/${r.id}`);
  });
  const rows = (d.data ?? []).filter((x) => x.submitted_by === hub.me.person.id || x.recipient_person_id === hub.me.person.id || x.role === 'approver');
  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <Button onClick={() => setF({ kind: 'expense_claim', company_id: hub.me.companies[0]?.id, reference: '', lines: [{ description: '', quantity: '1', unit: 'item', rate: '' }], file: null })}>Claim an expense</Button>
        {contractorCos.length > 0 && <Button variant="secondary" onClick={() => setF({ kind: 'contractor_invoice', company_id: contractorCos[0].company_id, reference: '', lines: [{ description: '', quantity: '1', unit: 'hour', rate: '' }], file: null })}>Submit an invoice</Button>}
      </div>
      <p className="small muted">Payment statements show approved work and agreed rates. They are not payslips: tax and deductions are handled by payroll. Nothing is ever deducted from wages through the Hub.</p>
      {d.loading && !d.data ? <Skeleton /> : <DocTable rows={rows} />}
      <Dialog open={!!f} onClose={() => setF(null)} title={f?.kind === 'expense_claim' ? 'Claim an expense' : 'Submit an invoice'} footer={<Button busy={submit.busy} onClick={() => submit.run()}>Submit</Button>}>
        {f && <><ErrorSummary error={submit.error} />
          <Field label="Company" hint={f.kind === 'contractor_invoice' ? 'The company you are invoicing.' : 'The company the cost was for.'}><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{(f.kind === 'contractor_invoice' ? contractorCos.map((a) => ({ id: a.company_id, name: a.company_name })) : hub.me.companies).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label={f.kind === 'contractor_invoice' ? 'Your invoice number' : 'Reference'} optional><input name="reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <LinesEditor lines={f.lines} onChange={(lines) => setF({ ...f, lines })} errors={submit.error?.fields ?? {}} />
          <FilePicker label={f.kind === 'expense_claim' ? 'Receipt' : 'Your invoice document'} accept="application/pdf,image/*" onChange={(fs) => setF({ ...f, file: fs[0] ?? null })} /></>}
      </Dialog>
    </>
  );
}

export function FinanceDocument() {
  const { id } = useParams();
  const d = useApi<any>(`/finance/documents/${id}`);
  const toast = useToast();
  const nav = useNavigate();
  const [dlg, setDlg] = useState<null | 'reject' | 'pay' | 'query' | 'edit'>(null);
  const [f, setF] = useState<any>({});
  const step = useSubmit(async (s: string, body: any = {}) => { const r = await post(`/finance/documents/${id}/${s}`, body); setDlg(null); toast(r?.number ? `Issued as ${r.number}.` : 'Done.'); d.reload(); });
  const pay = useSubmit(async () => { await post(`/finance/documents/${id}/payments`, f); setDlg(null); toast('Payment recorded.'); d.reload(); });
  const query = useSubmit(async () => { await post(`/finance/documents/${id}/queries`, { body: f.body }); setDlg(null); toast('Query sent to finance.'); d.reload(); });
  const answer = useSubmit(async (qid: string, text: string) => { await post(`/finance/queries/${qid}/answer`, { answer: text }); d.reload(); });
  const save = useSubmit(async () => { await patch(`/finance/documents/${id}`, { recipient_name: f.recipient_name, tax_treatment: f.tax_treatment, lines: f.lines.map((l: any) => ({ description: l.description, quantity: String(l.quantity), unit: l.unit, rate: String(l.rate) })) }); setDlg(null); toast('Draft saved.'); d.reload(); });
  const credit = useSubmit(async () => { const doc = d.data.document; const r = await post('/finance/documents', { company_id: doc.company_id, kind: 'credit_note', recipient_name: doc.recipient_name, recipient_email: doc.recipient_email, credits_document_id: doc.id, tax_treatment: doc.tax_treatment, lines: [{ description: `Credit against ${doc.number}`, quantity: '1', unit: 'item', rate: d.data.balance }] }); nav(`/finance/${r.id}`); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={10} />;
  const { document: doc, lines, payments, queries, credits, files, balance, company, can } = d.data;
  return (
    <>
      <div className="no-print"><PageHead title={`${KIND[doc.kind]} ${doc.number ?? '(draft)'}`} crumbs={[['Finance', '/finance'], [doc.number ?? 'Draft']]} intro={<><CompanyBadge code={doc.company_code} name={doc.company_name} /> {doc.direction === 'receivable' ? 'Money coming in to the company' : 'Money going out from the company'}</>}
        actions={<><Status s={DOC_STATUS[doc.status][0]} text={DOC_STATUS[doc.status][1]} /><Button variant="secondary" onClick={() => print()}>Print or save as PDF</Button></>} /></div>
      <ErrorSummary error={step.error ?? credit.error ?? answer.error} />
      <div className="row no-print" style={{ marginBottom: 16 }}>
        {can.edit && <Button variant="secondary" onClick={() => { setF({ recipient_name: doc.recipient_name, tax_treatment: doc.tax_treatment, lines }); setDlg('edit'); }}>Edit draft</Button>}
        {can.requestApproval && <Button busy={step.busy} onClick={() => step.run('request-approval')}>Send for approval</Button>}
        {can.approve && <><Button variant="go" busy={step.busy} onClick={() => step.run('approve')}>Approve</Button><Button variant="secondary" onClick={() => { setF({ note: '' }); setDlg('reject'); }}>Reject</Button></>}
        {can.issue && <Button variant="go" busy={step.busy} onClick={() => step.run('issue')}>Issue</Button>}
        {can.pay && Number(balance) > 0 && <Button variant="secondary" onClick={() => { setF({ amount: balance, paid_on: londonToday(), method: 'bank_transfer', reference: '' }); setDlg('pay'); }}>Record a payment</Button>}
        {can.credit && Number(balance) > 0 && <Button variant="secondary" busy={credit.busy} onClick={() => credit.run()}>Raise a credit note</Button>}
        {can.void && <Button variant="ghost" busy={step.busy} onClick={() => step.run('void')}>Void</Button>}
        <Button variant="ghost" onClick={() => { setF({ body: '' }); setDlg('query'); }}>Ask a question</Button>
      </div>
      <article className="card" style={{ maxWidth: 820 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div><h2 style={{ margin: 0 }}>{KIND[doc.kind]}</h2>{doc.number && <p style={{ margin: 0 }}>No. {doc.number}</p>}{doc.self_billing && <p className="small">Self-billed invoice</p>}</div>
          <div className="small" style={{ textAlign: 'right' }}><strong>From:</strong> {doc.issuer_name}{doc.direction === 'receivable' && company.company_number && <><br />Company no. {company.company_number}</>}{doc.direction === 'receivable' && company.registered_address && <><br />{company.registered_address}</>}{company.vat_registered && doc.direction === 'receivable' && <><br />VAT {company.vat_number}</>}</div>
        </div>
        <p className="small" style={{ marginTop: 16 }}><strong>To:</strong> {doc.recipient_name}{doc.recipient_address && <><br />{doc.recipient_address}</>}</p>
        <p className="small">Issued {fmtDate(doc.issue_date)} · Due {fmtDate(doc.due_date)}{doc.period_start && ` · Period ${fmtDate(doc.period_start)} – ${fmtDate(doc.period_end)}`}{doc.reference && ` · Ref ${doc.reference}`}</p>
        <div className="table-wrap"><table><thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">VAT</th><th className="num">Amount</th></tr></thead>
          <tbody>{lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="num">{Number(l.quantity)} {l.unit}</td><td className="num">{money(l.rate)}</td><td className="num">{Number(l.tax_rate)}%</td><td className="num">{money(l.amount)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={4} className="num">Subtotal</td><td className="num">{money(doc.subtotal)}</td></tr><tr><td colSpan={4} className="num">VAT ({label(doc.tax_treatment)})</td><td className="num">{money(doc.tax_total)}</td></tr><tr><td colSpan={4} className="num"><strong>Total</strong></td><td className="num"><strong>{money(doc.total)}</strong></td></tr>
            <tr><td colSpan={4} className="num">Still outstanding</td><td className="num">{money(balance)}</td></tr></tfoot></table></div>
        {doc.direction === 'receivable' && <p className="small"><strong>How to pay:</strong> {company.payment_instructions ?? 'Payment details have not been set up yet.'}</p>}
        {doc.terms && <p className="small">{doc.terms}</p>}
        {doc.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</p>}
      </article>
      <div className="grid-2 no-print" style={{ marginTop: 16 }}>
        <section className="card" aria-labelledby="pay-h"><h2 id="pay-h">Payments</h2>
          {payments.length === 0 ? <p className="muted">None recorded.</p> : <ul className="list">{payments.map((p: any) => <li key={p.id}><span>{money(p.amount)} on {fmtDate(p.paid_on)} by {label(p.method)}{p.reference && ` (${p.reference})`}<br /><span className="small muted">Recorded manually by {p.recorded_by_name} — not matched to a bank feed</span></span></li>)}</ul>}
          {credits.length > 0 && <><h3>Credit notes</h3><ul>{credits.map((c: any) => <li key={c.id}><Link to={`/finance/${c.id}`}>{c.number ?? 'Draft'}</Link> {money(c.total)} ({label(c.status)})</li>)}</ul></>}
          {files.length > 0 && <p>Attachments: {files.map((x: any) => <button key={x.id} type="button" className="btn ghost" onClick={() => download(`/files/${x.id}`, x.original_name)}>{x.original_name}</button>)}</p>}
        </section>
        <section className="card" aria-labelledby="q-h"><h2 id="q-h">Questions</h2>
          {queries.length === 0 ? <p className="muted">No questions.</p> : <ul className="list">{queries.map((x: any) => <li key={x.id}><div><strong>{x.raised_by_name}:</strong> {x.body}{x.answer ? <p className="small" style={{ margin: '4px 0 0' }}><strong>{x.answered_by_name}:</strong> {x.answer}</p> : d.data.role === 'finance' && <AnswerBox onSend={(t) => answer.run(x.id, t)} />}</div></li>)}</ul>}
        </section>
      </div>
      <Dialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Reject" variant="modal" footer={<Button variant="danger" busy={step.busy} onClick={() => step.run('reject', { note: f.note })}>Reject</Button>}>
        <Field label="Why?"><textarea name="note" value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'pay'} onClose={() => setDlg(null)} title="Record a payment" variant="modal" footer={<Button busy={pay.busy} onClick={() => pay.run()}>Record</Button>}>
        <p className="small muted">This is a manual record. It is not reconciled with your bank.</p>
        <ErrorSummary error={pay.error} />
        <div className="form-grid"><Field label="Amount (£)" error={pay.error?.fields.amount}><input name="amount" inputMode="decimal" value={f.amount ?? ''} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field><Field label="Paid on"><input name="paid_on" type="date" value={f.paid_on ?? ''} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field></div>
        <Field label="Method"><select name="method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['bank_transfer', 'card', 'cash', 'cheque', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
        <Field label="Reference" optional><input name="reference" value={f.reference ?? ''} onChange={(e) => setF({ ...f, reference: e.target.value || null })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'query'} onClose={() => setDlg(null)} title="Ask finance a question" variant="modal" footer={<Button busy={query.busy} onClick={() => query.run()}>Send</Button>}>
        <ErrorSummary error={query.error} /><Field label="Your question"><textarea name="body" value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'edit'} onClose={() => setDlg(null)} title="Edit draft" footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        {dlg === 'edit' && <><ErrorSummary error={save.error} />
          <Field label="Bill to"><input name="recipient_name" value={f.recipient_name} onChange={(e) => setF({ ...f, recipient_name: e.target.value })} /></Field>
          <Field label="Tax treatment" error={save.error?.fields.tax_treatment}><select name="tax_treatment" value={f.tax_treatment} onChange={(e) => setF({ ...f, tax_treatment: e.target.value })}>{TAX.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <LinesEditor lines={f.lines.map((l: any) => ({ ...l, quantity: String(Number(l.quantity)), rate: String(l.rate) }))} onChange={(lines) => setF({ ...f, lines })} errors={save.error?.fields ?? {}} /></>}
      </Dialog>
    </>
  );
}
function AnswerBox({ onSend }: { onSend: (t: string) => void }) {
  const [t, setT] = useState('');
  return <div className="row" style={{ marginTop: 4 }}><input aria-label="Answer" value={t} onChange={(e) => setT(e.target.value)} style={{ flex: 1 }} /><Button variant="secondary" disabled={t.trim().length < 2} onClick={() => onSend(t)}>Answer</Button></div>;
}

function Budgets() {
  const hub = useHub();
  const toast = useToast();
  const [year, setYear] = useState(Number(londonToday().slice(0, 4)));
  const d = useApi<any>(`/finance/budgets${hub.q({ year: String(year) })}`);
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => { await api('PUT', '/finance/budgets', { ...f, actual: f.actual || null, note: f.note || null }); setF(null); toast('Saved.'); d.reload(); });
  const est = (company: string, month: string) => d.data?.staffing_estimate.find((x: any) => x.company_id === company && x.month === month)?.estimate;
  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}><Button variant="secondary" onClick={() => setYear(year - 1)}>‹ {year - 1}</Button><h2 style={{ margin: 0 }}>{year}</h2><Button variant="secondary" onClick={() => setYear(year + 1)}>{year + 1} ›</Button>
        {hub.can('finance.manage') && <Button onClick={() => setF({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies.find((c) => c.perms.includes('finance.manage'))?.id, month: `${year}-01-01`, category: 'staffing', amount: '', actual: '', note: '' })}>Set a budget</Button>}</div>
      <p className="small muted">The staffing estimate comes from approved timesheets, allocated to the company the work was for, so people working for more than one company are never counted twice. It is an estimate, not payroll.</p>
      {(d.data?.budgets ?? []).length === 0 ? <Empty>No budgets set for {year}.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Month</th><th>Company</th><th>Category</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Staffing estimate</th><th>Note</th></tr></thead>
          <tbody>{d.data.budgets.map((b: any) => <tr key={b.id}><td>{fmtDate(b.month).replace(/^1 /, '')}</td><td>{b.company_code}</td><td>{label(b.category)}</td><td className="num">{money(b.amount)}</td><td className="num">{money(b.actual)}</td><td className="num">{b.category === 'staffing' ? money(est(b.company_id, b.month) ?? 0) : '—'}</td><td className="small">{b.note}</td></tr>)}</tbody></table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Set a budget" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {f && <><ErrorSummary error={save.error} />
          <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{hub.me.companies.filter((c) => c.perms.includes('finance.manage')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <div className="form-grid"><Field label="Month"><input name="month" type="month" value={f.month.slice(0, 7)} onChange={(e) => setF({ ...f, month: `${e.target.value}-01` })} /></Field>
            <Field label="Category"><select name="category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['staffing', 'cover', 'training', 'premises', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field></div>
          <div className="form-grid"><Field label="Budget (£)" error={save.error?.fields.amount}><input name="amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field><Field label="Actual (£)" optional><input name="actual" inputMode="decimal" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} /></Field></div>
          <Field label="Note" optional><input name="note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

function Cashflow() {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.view'));
  const [company, setCompany] = useState(hub.company !== 'all' && hub.can('finance.view', hub.company) ? hub.company : cos[0]?.id);
  const d = useApi<any>(company ? `/finance/cashflow?company=${company}` : null);
  const [line, setLine] = useState<any>(null);
  const [sc, setSc] = useState<any>(null);
  const [setup, setSetup] = useState<any>(null);
  const manage = hub.can('finance.manage', company);
  const saveLine = useSubmit(async () => { await post('/finance/cashflow/lines', { ...line, company_id: company, actual: line.actual || null }); setLine(null); toast('Saved.'); d.reload(); });
  const saveSc = useSubmit(async () => { await post('/finance/scenarios', { ...sc, company_id: company, supplier_increase_percent: sc.supplier_increase_percent ? Number(sc.supplier_increase_percent) : null, adjustments: sc.adjustments.filter((x: any) => x.amount) }); setSc(null); toast('Scenario saved.'); d.reload(); });
  const saveSetup = useSubmit(async () => { await api('PUT', '/finance/cashflow/settings', { ...setup, company_id: company }); setSetup(null); d.reload(); });
  const data = d.data;
  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="cf-co">Company</label><select id="cf-co" value={company} onChange={(e) => setCompany(e.target.value)} style={{ width: 'auto' }}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        {manage && <><Button variant="secondary" onClick={() => setSetup({ opening_balance: data?.settings?.opening_balance ?? '0.00', opening_month: data?.settings?.opening_month ?? `${londonToday().slice(0, 7)}-01` })}>Opening balance</Button>
          <Button variant="secondary" onClick={() => setLine({ month: `${londonToday().slice(0, 7)}-01`, kind: 'income', label: '', forecast: '', actual: '' })}>Add a forecast line</Button>
          <Button variant="secondary" onClick={() => setSc({ name: '', kind: 'delayed_income', assumptions: '', response: '', supplier_increase_percent: '', adjustments: [{ month: `${londonToday().slice(0, 7)}-01`, label: '', amount: '' }] })}>Add a scenario</Button></>}
      </div>
      {!data ? <Skeleton /> : !data.settings ? <Empty>Set the opening balance and month to start the forecast.</Empty> : (
        <>
          <div className="table-wrap"><table>
            <caption>Projected balance for 12 months (forecast; actual where entered)</caption>
            <thead><tr><th>Month</th><th className="num">Forecast net</th><th className="num">Actual net</th><th className="num">Projected balance</th>{data.scenarios.map((s: any) => <th key={s.id} className="num">If: {s.name}</th>)}</tr></thead>
            <tbody>{data.projection.map((p: any) => <tr key={p.month}><td>{new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date(`${p.month}T12:00Z`))}</td><td className="num">{money(p.net)}</td><td className="num">{money(p.actual_net)}</td>
              <td className="num">{Number(p.balance) < 0 ? <strong style={{ color: 'var(--danger)' }}>{money(p.balance)} (below zero)</strong> : money(p.balance)}</td>
              {data.scenarios.map((s: any) => { const v = p.scenarios.find((x: any) => x.id === s.id)?.balance; return <td key={s.id} className="num">{Number(v) < 0 ? <strong style={{ color: 'var(--danger)' }}>{money(v)} (below zero)</strong> : money(v)}</td>; })}</tr>)}</tbody>
          </table></div>
          <div className="grid-2" style={{ marginTop: 16 }}>
            <section className="card"><h2>Forecast lines</h2>{data.lines.length === 0 ? <Empty>None.</Empty> : <ul className="list">{data.lines.map((l: any) => <li key={l.id}><span>{fmtDate(l.month).replace(/^1 /, '')} · {label(l.kind)}: {l.label}<br /><span className="small">Forecast {money(l.forecast)} · Actual {money(l.actual)}</span></span>{manage && <Button variant="ghost" onClick={() => setLine({ ...l, forecast: String(l.forecast), actual: l.actual ?? '' })}>Edit</Button>}</li>)}</ul>}</section>
            <section className="card"><h2>Scenarios</h2>{data.scenarios.length === 0 ? <Empty>No scenarios. Try delayed income, cover costs, unexpected spending or supplier increases.</Empty> : data.scenarios.map((s: any) => <div key={s.id} style={{ marginBottom: 12 }}><strong>{s.name}</strong> <span className="badge co">{label(s.kind)}</span><p className="small" style={{ margin: '4px 0' }}>Assumptions: {s.assumptions}</p>{s.response && <p className="small" style={{ margin: 0 }}>Management response: {s.response}</p>}</div>)}</section>
          </div>
        </>
      )}
      <Dialog open={!!setup} onClose={() => setSetup(null)} title="Opening balance" variant="modal" footer={<Button busy={saveSetup.busy} onClick={() => saveSetup.run()}>Save</Button>}>
        {setup && <><ErrorSummary error={saveSetup.error} /><Field label="Opening balance (£)"><input name="opening_balance" inputMode="decimal" value={setup.opening_balance} onChange={(e) => setSetup({ ...setup, opening_balance: e.target.value })} /></Field><Field label="From month"><input name="opening_month" type="month" value={setup.opening_month.slice(0, 7)} onChange={(e) => setSetup({ ...setup, opening_month: `${e.target.value}-01` })} /></Field></>}
      </Dialog>
      <Dialog open={!!line} onClose={() => setLine(null)} title="Forecast line" footer={<Button busy={saveLine.busy} onClick={() => saveLine.run()}>Save</Button>}>
        {line && <><ErrorSummary error={saveLine.error} />
          <div className="form-grid"><Field label="Month"><input name="month" type="month" value={line.month.slice(0, 7)} onChange={(e) => setLine({ ...line, month: `${e.target.value}-01` })} /></Field><Field label="Type"><select name="kind" value={line.kind} onChange={(e) => setLine({ ...line, kind: e.target.value })}><option value="income">Income</option><option value="expense">Expense</option></select></Field></div>
          <Field label="Label" error={saveLine.error?.fields.label}><input name="label" value={line.label} onChange={(e) => setLine({ ...line, label: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Forecast (£)" error={saveLine.error?.fields.forecast}><input name="forecast" inputMode="decimal" value={line.forecast} onChange={(e) => setLine({ ...line, forecast: e.target.value })} /></Field><Field label="Actual (£)" optional><input name="actual" inputMode="decimal" value={line.actual} onChange={(e) => setLine({ ...line, actual: e.target.value })} /></Field></div></>}
      </Dialog>
      <Dialog open={!!sc} onClose={() => setSc(null)} title="Add a scenario" footer={<Button busy={saveSc.busy} onClick={() => saveSc.run()}>Save</Button>}>
        {sc && <><ErrorSummary error={saveSc.error} />
          <Field label="Name" error={saveSc.error?.fields.name}><input name="name" value={sc.name} onChange={(e) => setSc({ ...sc, name: e.target.value })} /></Field>
          <Field label="Type"><select name="kind" value={sc.kind} onChange={(e) => setSc({ ...sc, kind: e.target.value })}>{['delayed_income', 'cover_costs', 'unexpected_expenditure', 'supplier_increase', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
          <Field label="Assumptions" error={saveSc.error?.fields.assumptions}><textarea name="assumptions" value={sc.assumptions} onChange={(e) => setSc({ ...sc, assumptions: e.target.value })} /></Field>
          {sc.kind === 'supplier_increase' && <Field label="Increase on all forecast expenses (%)"><input name="pct" type="number" min={0} max={100} value={sc.supplier_increase_percent} onChange={(e) => setSc({ ...sc, supplier_increase_percent: e.target.value })} /></Field>}
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Changes to the forecast</legend><span className="hint">Use a minus sign for money lost or spent, for example -18000.00.</span>
            {sc.adjustments.map((x: any, i: number) => <div key={i} className="form-grid"><Field label="Month"><input name={`am${i}`} type="month" value={x.month.slice(0, 7)} onChange={(e) => setSc({ ...sc, adjustments: sc.adjustments.map((y: any, j: number) => (j === i ? { ...y, month: `${e.target.value}-01` } : y)) })} /></Field><Field label="What"><input name={`al${i}`} value={x.label} onChange={(e) => setSc({ ...sc, adjustments: sc.adjustments.map((y: any, j: number) => (j === i ? { ...y, label: e.target.value } : y)) })} /></Field><Field label="Amount (£)"><input name={`aa${i}`} value={x.amount} onChange={(e) => setSc({ ...sc, adjustments: sc.adjustments.map((y: any, j: number) => (j === i ? { ...y, amount: e.target.value } : y)) })} /></Field></div>)}
            <Button variant="ghost" onClick={() => setSc({ ...sc, adjustments: [...sc.adjustments, { month: sc.adjustments.at(-1)?.month ?? `${londonToday().slice(0, 7)}-01`, label: '', amount: '' }] })}>Add a change</Button></fieldset>
          <Field label="What management would do" optional><textarea name="response" value={sc.response} onChange={(e) => setSc({ ...sc, response: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

const SCENARIOS: [string, string][] = [['staff_shortage', 'Staff shortage'], ['it_failure', 'IT failure'], ['office_loss', 'Loss of office'], ['emergency', 'Emergency'], ['supplier_failure', 'Supplier failure'], ['other', 'Other']];
function Continuity() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/continuity${hub.q()}`);
  const [plan, setPlan] = useState<any>(null);
  const [ex, setEx] = useState<any>(null);
  const people = useApi<any[]>(plan?.company_id ? `/people?company=${plan.company_id}` : null);
  const save = useSubmit(async () => { const body = { scenario: plan.scenario, title: plan.title, plan: plan.plan, deputies: plan.deputies, fallback: plan.fallback || null, next_test_on: plan.next_test_on || null }; if (plan.id) await patch(`/continuity/${plan.id}`, body); else await post('/continuity', { ...body, company_id: plan.company_id }); setPlan(null); toast('Plan saved.'); d.reload(); });
  const record = useSubmit(async () => { await post(`/continuity/${ex.plan_id}/exercises`, ex); setEx(null); toast('Exercise recorded.'); d.reload(); });
  return (
    <>
      <p className="muted">A plan only shows as tested once a recovery exercise has been recorded. The Hub makes no promise about recovery times — only what your exercises show.</p>
      {hub.can('continuity.manage') && <p><Button onClick={() => setPlan({ company_id: hub.me.companies.find((c) => c.perms.includes('continuity.manage'))?.id, scenario: 'staff_shortage', title: '', plan: '', deputies: [], fallback: '', next_test_on: '' })}>Write a plan</Button></p>}
      {(d.data ?? []).length === 0 ? <Empty>No continuity plans.</Empty> : d.data!.map((p) => {
        const last = p.exercises?.[0];
        return (
          <section key={p.id} className="card" aria-labelledby={`cp-${p.id}`}>
            <div className="row between"><h2 id={`cp-${p.id}`} style={{ fontSize: '1.125rem', margin: 0 }}>{p.title} <span className="badge co">{p.company_code}</span></h2>
              {last ? <Status s={last.outcome === 'worked' ? 'verified' : 'action'} text={`Tested ${fmtDate(last.held_on)}: ${label(last.outcome)}`} /> : <Status s="evidence_missing" text="Not tested" />}</div>
            <p className="small muted">{SCENARIOS.find(([k]) => k === p.scenario)?.[1]} · deputies: {(p.deputy_names ?? []).join(', ') || 'none named'} · next test {fmtDate(p.next_test_on)}</p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.plan}</p>{p.fallback && <p className="small"><strong>Fallback:</strong> {p.fallback}</p>}
            {(p.exercises ?? []).length > 0 && <details><summary>Exercise history ({p.exercises.length})</summary><ul>{p.exercises.map((e: any) => <li key={e.id}>{fmtDate(e.held_on)} — {label(e.outcome)}: {e.what_happened}{e.lessons && ` Lessons: ${e.lessons}`}</li>)}</ul></details>}
            {hub.can('continuity.manage', p.company_id) && <div className="row"><Button variant="secondary" onClick={() => setEx({ plan_id: p.id, held_on: londonToday(), participants: '', what_happened: '', outcome: 'worked', lessons: '' })}>Record an exercise</Button><Button variant="ghost" onClick={() => setPlan({ ...p, fallback: p.fallback ?? '', next_test_on: p.next_test_on ?? '' })}>Edit</Button></div>}
          </section>
        );
      })}
      <Dialog open={!!plan} onClose={() => setPlan(null)} title="Continuity plan" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {plan && <><ErrorSummary error={save.error} />
          {!plan.id && <Field label="Company"><select name="company_id" value={plan.company_id} onChange={(e) => setPlan({ ...plan, company_id: e.target.value })}>{hub.me.companies.filter((c) => c.perms.includes('continuity.manage')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <Field label="Situation"><select name="scenario" value={plan.scenario} onChange={(e) => setPlan({ ...plan, scenario: e.target.value })}>{SCENARIOS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Title" error={save.error?.fields.title}><input name="title" value={plan.title} onChange={(e) => setPlan({ ...plan, title: e.target.value })} /></Field>
          <Field label="What we do" error={save.error?.fields.plan}><textarea name="plan" rows={6} value={plan.plan} onChange={(e) => setPlan({ ...plan, plan: e.target.value })} /></Field>
          <Field label="Fallback procedure" optional><textarea name="fallback" value={plan.fallback} onChange={(e) => setPlan({ ...plan, fallback: e.target.value })} /></Field>
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Deputies</legend>{people.data?.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={plan.deputies.includes(p.id)} onChange={(e) => setPlan({ ...plan, deputies: e.target.checked ? [...plan.deputies, p.id] : plan.deputies.filter((x: string) => x !== p.id) })} /> {p.full_name}</label>)}</fieldset>
          <Field label="Next test" optional><input name="next_test_on" type="date" value={plan.next_test_on} onChange={(e) => setPlan({ ...plan, next_test_on: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={!!ex} onClose={() => setEx(null)} title="Record a recovery exercise" footer={<Button busy={record.busy} onClick={() => record.run()}>Save</Button>}>
        {ex && <><ErrorSummary error={record.error} />
          <Field label="Date"><input name="held_on" type="date" max={londonToday()} value={ex.held_on} onChange={(e) => setEx({ ...ex, held_on: e.target.value })} /></Field>
          <Field label="Who took part" optional><input name="participants" value={ex.participants} onChange={(e) => setEx({ ...ex, participants: e.target.value })} /></Field>
          <Field label="What happened" error={record.error?.fields.what_happened}><textarea name="what_happened" value={ex.what_happened} onChange={(e) => setEx({ ...ex, what_happened: e.target.value })} /></Field>
          <Field label="Did the plan work?"><select name="outcome" value={ex.outcome} onChange={(e) => setEx({ ...ex, outcome: e.target.value })}><option value="worked">Worked</option><option value="partly_worked">Partly worked</option><option value="did_not_work">Did not work</option></select></Field>
          <Field label="Lessons" optional><textarea name="lessons" value={ex.lessons} onChange={(e) => setEx({ ...ex, lessons: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

function Settings() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>('/finance/settings');
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => { const { company_id, company_code: _a, company_name: _b, next_invoice_number: _c, next_credit_number: _d, next_statement_number: _e, ...body } = f; await api('PUT', `/finance/settings/${company_id}`, { ...body, payment_terms_days: Number(body.payment_terms_days), vat_number: body.vat_number || null, self_billing_agreement_ref: body.self_billing_agreement_ref || null, payment_instructions: body.payment_instructions || null }); setF(null); toast('Settings saved.'); d.reload(); });
  return (
    <>
      <p className="muted">Each company keeps its own numbering and payment details. Enter only details you have verified. VAT is off and self-billing is disabled until you turn them on with the supporting details.</p>
      {(d.data ?? []).map((s) => (
        <section key={s.company_id} className="card"><div className="row between"><h2 style={{ fontSize: '1.125rem', margin: 0 }}>{s.company_name}</h2>{hub.can('finance.manage', s.company_id) && <Button variant="secondary" onClick={() => setF({ ...s })}>Edit</Button>}</div>
          <dl className="facts" style={{ marginTop: 8 }}><dt>Next numbers</dt><dd>{s.invoice_prefix}-{String(s.next_invoice_number).padStart(4, '0')}, {s.credit_prefix}-{String(s.next_credit_number).padStart(4, '0')}, {s.statement_prefix}-{String(s.next_statement_number).padStart(4, '0')}</dd>
            <dt>VAT</dt><dd>{s.vat_registered ? `Registered (${s.vat_number})` : 'Not registered'}</dd><dt>Self-billing</dt><dd>{s.self_billing_enabled ? `On — agreement ${s.self_billing_agreement_ref}` : 'Off'}</dd>
            <dt>Payment terms</dt><dd>{s.payment_terms_days} days</dd><dt>Payment instructions</dt><dd>{s.payment_instructions ?? <Status s="evidence_missing" text="Not set" />}</dd></dl></section>
      ))}
      <Dialog open={!!f} onClose={() => setF(null)} title={`Finance settings: ${f?.company_name ?? ''}`} footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        {f && <><ErrorSummary error={save.error} />
          <div className="form-grid">{['invoice_prefix', 'credit_prefix', 'statement_prefix'].map((k) => <Field key={k} label={label(k)} hint="Capital letters and numbers"><input name={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.toUpperCase() })} /></Field>)}</div>
          <Field label="Payment terms (days)"><input name="payment_terms_days" type="number" min={0} max={365} value={f.payment_terms_days} onChange={(e) => setF({ ...f, payment_terms_days: e.target.value })} /></Field>
          <Field label="Payment instructions" optional hint="Bank details as verified by finance. Shown on invoices."><textarea name="payment_instructions" value={f.payment_instructions ?? ''} onChange={(e) => setF({ ...f, payment_instructions: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={f.vat_registered} onChange={(e) => setF({ ...f, vat_registered: e.target.checked })} /> This company is VAT registered</label>
          {f.vat_registered && <Field label="VAT number" error={save.error?.fields.vat_number}><input name="vat_number" value={f.vat_number ?? ''} onChange={(e) => setF({ ...f, vat_number: e.target.value })} /></Field>}
          <label className="check"><input type="checkbox" checked={f.self_billing_enabled} onChange={(e) => setF({ ...f, self_billing_enabled: e.target.checked })} /> A self-billing agreement is in place with contractors</label>
          {f.self_billing_enabled && <Field label="Agreement reference" error={save.error?.fields.self_billing_agreement_ref}><input name="self_billing_agreement_ref" value={f.self_billing_agreement_ref ?? ''} onChange={(e) => setF({ ...f, self_billing_agreement_ref: e.target.value })} /></Field>}</>}
      </Dialog>
    </>
  );
}
