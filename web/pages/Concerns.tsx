import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

const KINDS: [string, string, string][] = [
  ['grievance', 'Grievance', 'A complaint about how you have been treated at work.'],
  ['bullying_harassment', 'Bullying or harassment', 'Behaviour that is offensive, intimidating or unwanted.'],
  ['whistleblowing', 'Whistleblowing', 'Wrongdoing that affects others, such as danger, fraud or a breach of law.'],
  ['concern_about_manager', 'Concern about my manager', 'This will be kept away from your manager automatically.'],
];
const CASE_STATUS: Record<string, [string, string]> = { received: ['info', 'Received'], acknowledged: ['info', 'Acknowledged'], investigating: ['review', 'Being looked into'], outcome_given: ['verified', 'Outcome given'], appeal: ['review', 'Appeal'], closed: ['completed', 'Closed'] };

type Tab = 'raise' | 'cases' | 'contracts';
export function Concerns() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'raise';
  return (
    <>
      <PageHead title="Concerns and HR processes" intro="A private route for raising concerns. Only authorised HR handlers can read a case, and never anyone you name as involved." />
      <Tabs label="Sections" tabs={[['raise', 'Raise a concern'], ['cases', hub.can('cases.handle') ? 'Cases' : 'My cases'], ['contracts', 'Contract changes']]} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'raise' && <Raise />}
      {tab === 'cases' && <CaseList />}
      {tab === 'contracts' && <Contracts />}
    </>
  );
}

function Raise() {
  const hub = useHub();
  const nav = useNavigate();
  const [f, setF] = useState({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies[0]?.id ?? '', kind: 'grievance', summary: '', implicated_ids: [] as string[] });
  const people = useApi<any[]>(f.company_id ? `/people?company=${f.company_id}` : null);
  const send = useSubmit(async () => { const c = await post('/cases', f); nav(`/concerns/${c.id}`); });
  return (
    <div className="grid-2">
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); send.run(); }} aria-labelledby="raise-h">
        <h2 id="raise-h">Raise a concern</h2>
        <ErrorSummary error={send.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>What kind of concern is it?</legend>
          {KINDS.map(([k, t, h]) => <label key={k} className="check" style={{ alignItems: 'flex-start' }}><input type="radio" name="kind" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} /><span><strong>{t}</strong><br /><span className="small muted">{h}</span></span></label>)}
        </fieldset>
        <Field label="What happened?" hint="Include dates and what you would like to happen. You can add more later." error={send.error?.fields.summary}><textarea name="summary" rows={6} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Is anyone involved who should not see or handle this? <span className="muted">(optional)</span></legend>
          <span className="hint">They will not be able to see the case, even if they work in HR.</span>
          <select aria-label="Add a person involved" value="" onChange={(e) => e.target.value && setF({ ...f, implicated_ids: [...new Set([...f.implicated_ids, e.target.value])] })}><option value="">Add a person…</option>{people.data?.filter((p) => p.id !== hub.me.person.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
          <ul>{f.implicated_ids.map((id) => <li key={id}>{people.data?.find((p) => p.id === id)?.full_name} <Button variant="ghost" onClick={() => setF({ ...f, implicated_ids: f.implicated_ids.filter((x) => x !== id) })}>Remove</Button></li>)}</ul>
        </fieldset>
        <Button type="submit" busy={send.busy}>Send confidentially</Button>
      </form>
      <section className="card" aria-labelledby="conf-h">
        <h2 id="conf-h">Who can see this</h2>
        <ul>
          <li>Authorised HR case handlers for the company you choose.</li>
          <li>The investigator, once one is appointed.</li>
          <li>Never anyone you name as involved — and for a concern about your manager, never your manager.</li>
        </ul>
        <p>Your name is recorded so we can keep you updated and protect you. The Hub does not offer anonymous reporting, because we cannot promise anonymity in a small team. If you need to raise a concern outside the organisation, the whistleblowing policy explains how.</p>
        <p>Every time a handler opens a case, it is recorded in the audit log. Nothing in the Hub decides an outcome automatically.</p>
      </section>
    </div>
  );
}

function CaseList() {
  const hub = useHub();
  const d = useApi<any[]>('/cases');
  const [f, setF] = useState<any>(null);
  const nav = useNavigate();
  const open = useSubmit(async () => { const c = await post('/cases', f); nav(`/concerns/${c.id}`); });
  const people = useApi<any[]>(f?.company_id ? `/people?company=${f.company_id}` : null);
  const handleCos = hub.me.companies.filter((c) => c.perms.includes('cases.handle'));
  return (
    <>
      {handleCos.length > 0 && <p><Button variant="secondary" onClick={() => setF({ company_id: handleCos[0].id, kind: 'development', subject_person_id: '', summary: '', procedure_ref: '' })}>Open a development, capability or conduct process</Button></p>}
      {d.loading && !d.data ? <Skeleton /> : (d.data ?? []).length === 0 ? <Empty>No cases.</Empty> : (
        <ul className="list card">{d.data!.map((c) => <li key={c.id}><span><Link to={`/concerns/${c.id}`}>{label(c.kind)}</Link>{c.subject_name && ` — ${c.subject_name}`} <CompanyBadge code={c.company_code} name={c.company_name} /><br /><span className="muted small">Opened {fmtDate(c.created_at)} · {c.role === 'party' ? 'You raised this / it concerns you' : 'You are a handler'}</span></span><Status s={CASE_STATUS[c.status][0]} text={CASE_STATUS[c.status][1]} /></li>)}</ul>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Open an HR process" footer={<Button busy={open.busy} onClick={() => open.run()}>Open process</Button>}>
        {f && <><p className="small muted">Development, capability and conduct are separate processes. Each follows your approved procedure. The employee can read shared updates and respond.</p>
          <ErrorSummary error={open.error} />
          <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{handleCos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Process"><select name="kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="development">Development plan</option><option value="capability">Capability</option><option value="conduct">Conduct</option></select></Field>
          <Field label="Employee" error={open.error?.fields.subject_person_id}><select name="subject_person_id" value={f.subject_person_id} onChange={(e) => setF({ ...f, subject_person_id: e.target.value })}><option value="">Choose…</option>{people.data?.filter((p) => p.id !== hub.me.person.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Procedure followed" optional><input name="procedure_ref" value={f.procedure_ref} onChange={(e) => setF({ ...f, procedure_ref: e.target.value })} /></Field>
          <Field label="Summary" error={open.error?.fields.summary}><textarea name="summary" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

export function CasePage() {
  const { id } = useParams();
  const d = useApi<any>(`/cases/${id}`);
  const toast = useToast();
  const [upd, setUpd] = useState({ body: '', shared: true });
  const [resp, setResp] = useState<string | null>(null);
  const [appeal, setAppeal] = useState('');
  const [h, setH] = useState<any>(null);
  const people = useApi<any[]>(h && d.data ? `/people?company=${d.data.case.company_id}` : null);
  const addUpdate = useSubmit(async () => { await post(`/cases/${id}/updates`, upd); setUpd({ body: '', shared: true }); d.reload(); });
  const respond = useSubmit(async () => { await post(`/cases/${id}/respond`, { employee_response: resp ?? undefined }); toast('Response saved.'); d.reload(); });
  const doAppeal = useSubmit(async () => { await post(`/cases/${id}/respond`, { appeal }); toast('Appeal lodged.'); d.reload(); });
  const save = useSubmit(async () => { await patch(`/cases/${id}`, Object.fromEntries(Object.entries(h).filter(([, v]) => v !== '' && v !== undefined))); setH(null); toast('Case updated.'); d.reload(); });
  const file = useSubmit(async (f: File) => { await upload(`/cases/${id}/files`, f, f.name); d.reload(); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { case: c, role, updates, implicated, files } = d.data;
  return (
    <>
      <PageHead title={label(c.kind)} crumbs={[['Concerns', '/concerns?tab=cases'], ['Case']]} intro={<><CompanyBadge code={c.company_code} name={c.company_name} /> Opened {fmtDate(c.created_at)}{c.subject_name && ` · about ${c.subject_name}`}{c.raised_by_name && ` · raised by ${c.raised_by_name}`}</>}
        actions={<><Status s={CASE_STATUS[c.status][0]} text={CASE_STATUS[c.status][1]} />{role === 'handler' && <Button variant="secondary" onClick={() => setH({ status: c.status, investigator_id: c.investigator_id ?? '', outcome: c.outcome ?? '', outcome_on: c.outcome_on ?? '', appeal_outcome: c.appeal_outcome ?? '', procedure_ref: c.procedure_ref ?? '' })}>Update case</Button>}</>} />
      <div className="notice">Confidential. {role === 'handler' ? 'Your viewing of this case has been recorded.' : 'Only authorised handlers can read this. Nobody you named as involved can see it.'} Nothing in the Hub decides an outcome automatically.</div>
      <ErrorSummary error={addUpdate.error ?? respond.error ?? doAppeal.error ?? file.error} />
      <div className="grid-2">
        <section className="card" aria-labelledby="sum-h">
          <h2 id="sum-h">Summary</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.summary}</p>
          <dl className="facts">
            {implicated.length > 0 && <><dt>Kept away from</dt><dd>{implicated.map((p: any) => p.name).join(', ')}</dd></>}
            <dt>Acknowledged</dt><dd>{c.acknowledged_at ? fmtDateTime(c.acknowledged_at) : 'Not yet'}</dd>
            <dt>Investigator</dt><dd>{c.investigator_name ?? 'Not appointed'}</dd>
            {c.procedure_ref && <><dt>Procedure</dt><dd>{c.procedure_ref}</dd></>}
            {c.outcome && <><dt>Outcome</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.outcome} ({fmtDate(c.outcome_on)})</dd></>}
            {c.appeal && <><dt>Appeal</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.appeal}</dd></>}
            {c.appeal_outcome && <><dt>Appeal outcome</dt><dd>{c.appeal_outcome}</dd></>}
          </dl>
          {files.length > 0 && <p>Files: {files.map((f: any) => <button key={f.id} type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button>)}</p>}
          <div className="field"><label htmlFor="case-file">Add a document</label><input id="case-file" type="file" accept="application/pdf,image/*" onChange={(e) => e.target.files?.[0] && file.run(e.target.files[0])} /></div>
        </section>
        <section className="card" aria-labelledby="upd-h">
          <h2 id="upd-h">Updates</h2>
          {updates.length === 0 ? <p className="muted">No updates yet.</p> : <ul className="list">{updates.map((u: any) => <li key={u.id}><div><strong>{u.author_name}</strong> <span className="muted small">{fmtDateTime(u.created_at)}</span>{role === 'handler' && !u.shared && <Status s="review" text="Handlers only" />}<p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{u.body}</p></div></li>)}</ul>}
          <Field label="Add an update"><textarea name="body" value={upd.body} onChange={(e) => setUpd({ ...upd, body: e.target.value })} /></Field>
          {role === 'handler' && <label className="check"><input type="checkbox" checked={upd.shared} onChange={(e) => setUpd({ ...upd, shared: e.target.checked })} /> Share with {c.raised_by_name ?? c.subject_name}</label>}
          <Button variant="secondary" busy={addUpdate.busy} disabled={upd.body.trim().length < 2} onClick={() => addUpdate.run()}>Add update</Button>
        </section>
        {role === 'party' && (
          <section className="card" aria-labelledby="resp-h">
            <h2 id="resp-h">Your response</h2>
            <Field label="Your response" optional hint="Your side, in your own words. Handlers can read it."><textarea name="employee_response" value={resp ?? c.employee_response ?? ''} onChange={(e) => setResp(e.target.value)} /></Field>
            <Button variant="secondary" busy={respond.busy} onClick={() => respond.run()}>Save response</Button>
            {c.status === 'outcome_given' && <><Field label="Appeal" hint="Explain why you disagree with the outcome."><textarea name="appeal" value={appeal} onChange={(e) => setAppeal(e.target.value)} /></Field><Button busy={doAppeal.busy} disabled={appeal.trim().length < 5} onClick={() => doAppeal.run()}>Lodge appeal</Button></>}
          </section>
        )}
      </div>
      <Dialog open={!!h} onClose={() => setH(null)} title="Update case" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        {h && <><ErrorSummary error={save.error} />
          <Field label="Stage"><select name="status" value={h.status} onChange={(e) => setH({ ...h, status: e.target.value })}>{Object.entries(CASE_STATUS).map(([k, [, t]]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Investigator" hint="Cannot be anyone involved." error={save.error?.fields.investigator_id}><select name="investigator_id" value={h.investigator_id} onChange={(e) => setH({ ...h, investigator_id: e.target.value })}><option value="">Not appointed</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Procedure followed" optional><input name="procedure_ref" value={h.procedure_ref} onChange={(e) => setH({ ...h, procedure_ref: e.target.value })} /></Field>
          <Field label="Outcome" optional><textarea name="outcome" value={h.outcome} onChange={(e) => setH({ ...h, outcome: e.target.value })} /></Field>
          <Field label="Outcome date" optional><input name="outcome_on" type="date" value={h.outcome_on} onChange={(e) => setH({ ...h, outcome_on: e.target.value })} /></Field>
          {c.appeal && <Field label="Appeal outcome" optional><textarea name="appeal_outcome" value={h.appeal_outcome} onChange={(e) => setH({ ...h, appeal_outcome: e.target.value })} /></Field>}</>}
      </Dialog>
    </>
  );
}

const AGREEMENT: Record<string, [string, string]> = { proposed: ['planned', 'Proposed'], communicated: ['review', 'Communicated — awaiting response'], agreed: ['verified', 'Agreed'], not_agreed: ['action', 'Not agreed'], withdrawn: ['ended', 'Withdrawn'] };
function Contracts() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>('/contract-changes');
  const [f, setF] = useState<any>(null);
  const [resp, setResp] = useState<any>(null);
  const people = useApi<any[]>(f?.company_id ? `/people?company=${f.company_id}` : null);
  const create = useSubmit(async () => { await post('/contract-changes', { appointment_id: f.appointment_id, summary: f.summary, details: f.details || null, effective_on: f.effective_on || null }); setF(null); toast('Proposal recorded.'); d.reload(); });
  const step = useSubmit(async (cid: string, s: string, body: any = {}) => { await post(`/contract-changes/${cid}/${s}`, body); setResp(null); toast('Updated.'); d.reload(); });
  const cos = hub.me.companies.filter((c) => c.perms.includes('contracts.manage'));
  const appts = (people.data ?? []).flatMap((p) => p.appointments.filter((a: any) => a.company_id === f?.company_id && a.status === 'active').map((a: any) => ({ id: a.appointment_id, label: `${p.full_name} — ${a.job_title}`, person: p.id }))).filter((x: any) => x.person !== hub.me.person.id);
  return (
    <>
      <p className="muted">A contract change is proposed, communicated to the employee, approved by someone other than the proposer, and has an effective date. The employee records whether they agree. Nothing changes automatically.</p>
      {cos.length > 0 && <p><Button onClick={() => setF({ company_id: cos[0].id, appointment_id: '', summary: '', details: '', effective_on: '' })}>Propose a change</Button></p>}
      <ErrorSummary error={step.error} />
      {(d.data ?? []).length === 0 ? <Empty>No contract changes.</Empty> : (
        <ul className="list card">{d.data!.map((c) => {
          const mine = c.person_id === hub.me.person.id;
          const manage = hub.can('contracts.manage', c.company_id);
          return <li key={c.id}><div><strong>{c.summary}</strong> <span className="badge co">{c.company_code}</span><br /><span className="small">{c.person_name} — {c.job_title} · effective {fmtDate(c.effective_on)}</span>
            <div className="small muted">Proposed by {c.proposed_by_name}{c.communicated_on && ` · communicated ${fmtDate(c.communicated_on)}`}{c.approved_by_name && ` · approved by ${c.approved_by_name}`}</div>
            {c.details && <p className="small">{c.details}</p>}{c.employee_response && <p className="small">Employee response: {c.employee_response}</p>}
            <div className="row">
              {manage && !c.communicated_on && <Button variant="secondary" disabled={step.busy} onClick={() => step.run(c.id, 'communicate', { communicated_on: new Date().toISOString().slice(0, 10) })}>Mark as communicated today</Button>}
              {hub.can('contracts.approve', c.company_id) && !c.approved_by && c.proposed_by_name && !mine && <Button variant="secondary" disabled={step.busy} onClick={() => step.run(c.id, 'approve')}>Approve</Button>}
              {mine && c.agreement === 'communicated' && <Button onClick={() => setResp({ id: c.id, agreement: 'agreed', employee_response: '' })}>Respond</Button>}
              {manage && !['agreed', 'withdrawn'].includes(c.agreement) && <Button variant="ghost" disabled={step.busy} onClick={() => step.run(c.id, 'agreement', { agreement: 'withdrawn' })}>Withdraw</Button>}
            </div></div><Status s={AGREEMENT[c.agreement][0]} text={AGREEMENT[c.agreement][1]} /></li>;
        })}</ul>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Propose a contract change" footer={<Button busy={create.busy} onClick={() => create.run()}>Save proposal</Button>}>
        {f && <><ErrorSummary error={create.error} />
          <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, appointment_id: '' })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Employee and role"><select name="appointment_id" value={f.appointment_id} onChange={(e) => setF({ ...f, appointment_id: e.target.value })}><option value="">Choose…</option>{appts.map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
          <Field label="Change" error={create.error?.fields.summary}><input name="summary" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
          <Field label="Details" optional><textarea name="details" value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
          <Field label="Proposed effective date" optional><input name="effective_on" type="date" value={f.effective_on} onChange={(e) => setF({ ...f, effective_on: e.target.value })} /></Field></>}
      </Dialog>
      <Dialog open={!!resp} onClose={() => setResp(null)} title="Your response" variant="modal" footer={<Button busy={step.busy} onClick={() => step.run(resp.id, 'agreement', { agreement: resp.agreement, employee_response: resp.employee_response || undefined })}>Send</Button>}>
        {resp && <><Field label="Do you agree to this change?"><select name="agreement" value={resp.agreement} onChange={(e) => setResp({ ...resp, agreement: e.target.value })}><option value="agreed">I agree</option><option value="not_agreed">I do not agree</option></select></Field>
          <Field label="Comments" optional><textarea name="employee_response" value={resp.employee_response} onChange={(e) => setResp({ ...resp, employee_response: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}
