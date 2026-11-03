// Process a remittance and add expenses. The AI reads the uploaded file into lines; nothing is saved until the person
// has checked them. Expenses can also be typed straight in, one or many.
import { useState } from 'react';
import { post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, ErrorSummary, Field, FilePicker, Icon, useToast } from '../ui.tsx';
import { CAT, DEPTS } from './FinanceHub.tsx';

const INCOME = ['rent', 'service_charge', 'support_income', 'grant', 'other_income'];
const EXPENSE = Object.keys(CAT).filter((k) => !INCOME.includes(k) && !['loan_received', 'loan_repayment', 'capital_introduced', 'dividends', 'transfer'].includes(k));
const pence = (s: string) => Math.round(Number(s || 0) * 100);
const READS = 'image/*,application/pdf,.xlsx,.xlsm,.csv,text/csv';

// Company and account pickers shared by both dialogs. Only GBP accounts the person can manage are offered.
function useBooks() {
  const hub = useHub();
  const cos = hub.me.companies.filter((c) => c.perms.includes('finance.manage'));
  const [company, setCompany] = useState(hub.company !== 'all' && cos.some((c) => c.id === hub.company) ? hub.company : cos.find((c) => c.code === 'VH')?.id ?? cos[0]?.id);
  const accounts = useApi<any[]>(company ? `/finance/accounts?company=${company}` : null);
  const props = useApi<any[]>(`/properties${hub.q()}`);
  const gbp = (accounts.data ?? []).filter((a) => a.currency === 'GBP' && !a.archived && a.company_id === company);
  const picker = cos.length > 1 && <Field label="Company"><select value={company} onChange={(e) => setCompany(e.target.value)}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>;
  return { company, picker, accounts: gbp, loaded: !!accounts.data, properties: (props.data ?? []).filter((p) => p.company_id === company) };
}
const PropSelect = ({ value, onChange, props, ...rest }: { value: string; onChange: (v: string) => void; props: any[]; id?: string }) =>
  <select {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">No property</option>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;

// ── Remittance ──
export function RemittanceDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const bk = useBooks();
  const [file, setFile] = useState<File | null>(null);
  const [r, setR] = useState<any>(null);
  const [account, setAccount] = useState('');
  const [split, setSplit] = useState('');
  const reset = () => { setFile(null); setR(null); setSplit(''); };
  const read = useSubmit(async (f: File) => {
    const out = await upload('/finance/remittances/read', f, f.name, undefined, { company_id: bk.company! });
    setFile(f); setR({ ...out, pay_date: out.pay_date ?? londonToday() }); setSplit(out.matches[0]?.id ?? ''); if (out.matches[0]) setAccount(out.matches[0].account_id);
  });
  const lines: any[] = r?.lines ?? [];
  const setLine = (i: number, x: any) => setR({ ...r, lines: lines.map((l, j) => (j === i ? { ...l, ...x } : l)) });
  const inc = lines.filter((l) => l.kind === 'income').reduce((s, l) => s + pence(l.amount), 0), ded = lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + pence(l.amount), 0);
  const match = r?.matches.find((m: any) => m.id === split);
  const target = match ? pence(match.amount) : pence(r?.net_paid);
  const acct = match?.account_id ?? account ?? bk.accounts[0]?.id;
  const save = useSubmit(async () => {
    const data = { company_id: bk.company, account_id: acct, txn_date: r.pay_date, payer: r.payer, reference: r.reference || null, transaction_id: split || null,
      lines: lines.map((l) => ({ description: l.description, kind: l.kind, amount: l.amount, category: l.category, department: l.department || null, property_id: l.property_id || null })) };
    await upload('/finance/remittances', file, file?.name ?? 'remittance', undefined, { data: JSON.stringify(data) });
    toast(`Remittance saved: ${lines.length} lines, ${money((inc - ded) / 100)} net.`); reset(); onDone(); onClose();
  });
  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title="Process a remittance"
      footer={r && <Button busy={save.busy} disabled={!acct || !lines.length || (!!match && inc - ded !== target)} onClick={() => save.run()}>Save remittance</Button>}>
      <ErrorSummary error={read.error ?? save.error} />
      {bk.picker}
      {!r ? (
        <>
          <p className="small">Upload the remittance advice from your managing agent or RSL (Excel, CSV, PDF or a photo). The AI suggests a line for each property's rent and each fee or deduction. Nothing is saved until you check it and press Save.</p>
          <FilePicker label="Remittance file" accept={READS} instant busy={read.busy} onChange={(fs) => fs[0] && read.run(fs[0])} hint={read.busy ? 'Reading the file… this can take up to a minute.' : undefined} />
        </>
      ) : (
        <>
          {r.notes.length > 0 && <ul className="notice warn fi-notes">{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
          <div className="form-grid"><Field label="From"><input value={r.payer} onChange={(e) => setR({ ...r, payer: e.target.value })} /></Field>
            <Field label="Payment date"><input type="date" value={r.pay_date} disabled={!!match} onChange={(e) => setR({ ...r, pay_date: e.target.value })} /></Field></div>
          <Field label="Reference" optional><input value={r.reference ?? ''} onChange={(e) => setR({ ...r, reference: e.target.value })} /></Field>
          <ol className="fi-rows">{lines.map((l, i) => (
            <li key={i} className={`fi-row ${l.kind === 'income' ? 'in' : 'out'}`}><div className="fi-row-head"><strong>{l.kind === 'income' ? 'Income' : 'Deduction'}: {money(l.amount || 0)}</strong>
              <Button variant="ghost" onClick={() => setR({ ...r, lines: lines.filter((_, j) => j !== i) })} aria-label={`Remove line ${i + 1}`}>Remove</Button></div>
              <div className="fi-grid">
                <Field label="Line"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
                <Field label="Property" optional><PropSelect value={l.property_id} props={bk.properties} onChange={(v) => setLine(i, { property_id: v })} /></Field>
                <Field label="Type"><select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value, category: e.target.value === 'income' ? 'rent' : 'managing_agent_fee' })}><option value="income">Income</option><option value="deduction">Deduction</option></select></Field>
                <Field label="Category"><select value={l.category} onChange={(e) => setLine(i, { category: e.target.value })}>{(l.kind === 'income' ? INCOME : EXPENSE).map((c) => <option key={c} value={c}>{CAT[c]}</option>)}</select></Field>
                <Field label="Amount (£)"><input inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></Field>
              </div></li>))}</ol>
          <p className="fi-total" role="status">Income {money(inc / 100)} − deductions {money(ded / 100)} = <strong className={inc - ded !== target ? 'fh-bad' : undefined}>{money((inc - ded) / 100)}</strong>
            {inc - ded !== target && <span className="fh-bad"> · must add up to {money(target / 100)} ({match ? 'the bank item' : 'the amount paid'})</span>}</p>
          <Button variant="ghost" onClick={() => setR({ ...r, lines: [...lines, { description: '', kind: 'deduction', category: 'managing_agent_fee', amount: '', property_id: null, department: 'housing' }] })}><Icon name="plus" size={18} />Add a line</Button>
          <fieldset className="fh-fieldset"><legend>Where the money went</legend>
            {r.matches.map((m: any) => <label key={m.id} className="check"><input type="radio" name="split" checked={split === m.id} onChange={() => setSplit(m.id)} /> Explain this bank item: {fmtDate(m.txn_date)} · {m.description} · {money(m.amount)} ({m.account_name})</label>)}
            <label className="check"><input type="radio" name="split" checked={!split} onChange={() => setSplit('')} /> {r.matches.length ? 'None of these: record it as a new payment' : 'Record it as a payment received'}</label>
            {!split && (bk.accounts.length ? <Field label="Into account"><select value={acct} onChange={(e) => setAccount(e.target.value)}>{bk.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
              : bk.loaded && <p className="small fh-bad">Add a bank account under Bank & cash first.</p>)}
            {!split && <p className="small muted">When you import the bank statement later, the payment is recognised and not added twice.</p>}
          </fieldset>
        </>
      )}
    </Dialog>
  );
}

// ── Expenses ──
const blank = () => ({ txn_date: londonToday(), counterparty: '', description: '', amount: '', vat: '', category: 'other_expense', department: '', property_id: '', file: null as File | null });
export function ExpenseDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const bk = useBooks();
  const [rows, setRows] = useState<any[]>([blank()]);
  const [notes, setNotes] = useState<string[]>([]);
  const [account, setAccount] = useState('');
  const [pick, setPick] = useState(0);
  const acct = account || bk.accounts[0]?.id;
  const setRow = (i: number, x: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...x } : r)));
  const read = useSubmit(async (f: File) => {
    const out = await upload('/finance/expenses/read', f, f.name, undefined, { company_id: bk.company! });
    const isDoc = /^image\/|pdf$/.test(f.type);   // a receipt is kept with the expense it shows
    const got = out.items.map((x: any) => ({ ...blank(), ...x, txn_date: x.txn_date ?? londonToday(), counterparty: x.counterparty ?? '', vat: x.vat ?? '', department: x.department ?? '', property_id: x.property_id ?? '', file: isDoc && out.items.length === 1 ? f : null }));
    setRows([...rows.filter((r) => r.amount || r.description), ...got]); setNotes(out.notes); setPick(pick + 1);
    if (!got.length) setNotes(['Nothing was found to add. Type the expense in instead.', ...out.notes]);
  });
  const total = rows.reduce((s, r) => s + pence(r.amount), 0);
  const save = useSubmit(async () => {
    const res = await post('/finance/expenses', { account_id: acct, items: rows.map((r) => ({ txn_date: r.txn_date, amount: r.amount, description: r.description || r.counterparty || CAT[r.category], counterparty: r.counterparty || null, category: r.category,
      department: r.department || null, property_id: r.property_id || null, note: r.vat ? `VAT £${r.vat}` : null })) });
    await Promise.all(rows.map((r, i) => r.file && upload(`/finance/transactions/${res[i].id}/files`, r.file, r.file.name)));
    const matched = res.filter((x: any) => x.matched).length;
    toast(`${res.length} expense${res.length === 1 ? '' : 's'} saved${matched ? `; ${matched} matched to bank items already imported` : ''}.`);
    setRows([blank()]); setNotes([]); onDone(); onClose();
  });
  return (
    <Dialog open={open} onClose={onClose} title="Add expenses"
      footer={<Button busy={save.busy} disabled={!acct || !rows.length || rows.some((r) => !pence(r.amount))} onClick={() => save.run()}>Save {rows.length > 1 ? `${rows.length} expenses (${money(total / 100)})` : 'expense'}</Button>}>
      <ErrorSummary error={read.error ?? save.error} />
      {bk.picker}
      <div className="form-grid">
        {bk.accounts.length ? <Field label="Paid from"><select value={acct} onChange={(e) => setAccount(e.target.value)}>{bk.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          : bk.loaded && <p className="small fh-bad">Add a bank or card account under Bank & cash first.</p>}
        <FilePicker key={pick} label="Read a receipt or a list" hint={read.busy ? 'Reading… this can take up to a minute.' : 'Photo or PDF of a receipt, or an Excel/CSV list. You check the result before saving.'} accept={READS} instant busy={read.busy} onChange={(fs) => fs[0] && read.run(fs[0])} />
      </div>
      {notes.length > 0 && <ul className="notice warn fi-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <ol className="fi-rows">{rows.map((r, i) => (
        <li key={i} className="fi-row"><div className="fi-row-head"><strong>{rows.length > 1 ? `Expense ${i + 1}` : 'Expense'}</strong>{r.file && <span className="small muted">Receipt attached{r.vat && ` · VAT £${r.vat}`}</span>}
          {rows.length > 1 && <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove expense ${i + 1}`}>Remove</Button>}</div>
          <div className="fi-grid">
            <Field label="Date"><input type="date" value={r.txn_date} onChange={(e) => setRow(i, { txn_date: e.target.value })} /></Field>
            <Field label="Amount (£)"><input inputMode="decimal" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} /></Field>
            <Field label="Supplier"><input value={r.counterparty} onChange={(e) => setRow(i, { counterparty: e.target.value })} /></Field>
            <Field label="What for"><input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></Field>
            <Field label="Category"><select value={r.category} onChange={(e) => setRow(i, { category: e.target.value })}>{EXPENSE.map((c) => <option key={c} value={c}>{CAT[c]}</option>)}</select></Field>
            <Field label="Property" optional><PropSelect value={r.property_id} props={bk.properties} onChange={(v) => setRow(i, { property_id: v })} /></Field>
            <Field label="Department" optional><select value={r.department} onChange={(e) => setRow(i, { department: e.target.value })}><option value="">None</option>{DEPTS.map((d) => <option key={d} value={d}>{label(d)}</option>)}</select></Field>
          </div></li>))}</ol>
      <Button variant="ghost" onClick={() => setRows([...rows, { ...blank(), txn_date: rows.at(-1)?.txn_date ?? londonToday(), category: rows.at(-1)?.category ?? 'other_expense' }])}><Icon name="plus" size={18} />Add another</Button>
      <p className="small muted">Enter the amount paid, including VAT. If the bank statement already has the payment, it is coded instead of added twice.</p>
    </Dialog>
  );
}
