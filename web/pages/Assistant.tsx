import { useState } from 'react';
import { ApiError, api, patch, post, useApi, useSubmit } from '../api.ts';
import { fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

// Inputs for each task. Everything the assistant returns is a draft for a person to check.
function TaskInputs({ task, companyId, value, onChange, errors }: { task: string; companyId: string; value: any; onChange: (v: any) => void; errors: Record<string, string> }) {
  const people = useApi<any[]>(['supervision_prep', 'development_summary'].includes(task) ? `/people?company=${companyId}` : null);
  const meetings = useApi<any[]>(task === 'meeting_minutes' ? `/meetings?company=${companyId}` : null);
  const courses = useApi<any[]>(task === 'quiz_draft' ? `/courses?company=${companyId}` : null);
  const audits = useApi<any[]>(task === 'quality_check' ? `/audits?company=${companyId}` : null);
  const props = useApi<any[]>(task === 'property_audit' ? `/properties?company=${companyId}` : null);
  const set = (k: string) => (e: any) => onChange({ ...value, [k]: e.target.value });
  const sel = (k: string, l: string, rows: any[] | null | undefined, text: (r: any) => string) => <Field label={l} error={errors[`input.${k}`]}><select name={k} value={value[k] ?? ''} onChange={set(k)}><option value="">Choose…</option>{rows?.map((r) => <option key={r.id} value={r.id}>{text(r)}</option>)}</select></Field>;
  if (task === 'analytics_question') return <Field label="Your question" hint="For example: which properties need attention most, or why are tasks going overdue?" error={errors['input.question']}><textarea name="question" value={value.question ?? ''} onChange={set('question')} /></Field>;
  if (task === 'property_audit') return sel('property_id', 'Property', props.data, (p) => p.name);
  if (task === 'policy_question') return <Field label="Your question" error={errors['input.question']}><textarea name="question" value={value.question ?? ''} onChange={set('question')} /></Field>;
  if (task === 'supervision_prep' || task === 'development_summary') return sel('person_id', 'Person', people.data, (p) => p.full_name);
  if (task === 'meeting_minutes') return <>{sel('meeting_id', 'Meeting', meetings.data, (m) => `${m.title} (${m.held_on})`)}<Field label="Your rough notes" hint="The draft will only contain what your notes say." error={errors['input.rough_notes']}><textarea name="rough_notes" rows={8} value={value.rough_notes ?? ''} onChange={set('rough_notes')} /></Field></>;
  if (task === 'job_description') return <><Field label="Job title" error={errors['input.job_title']}><input name="job_title" value={value.job_title ?? ''} onChange={set('job_title')} /></Field><Field label="Main responsibilities" error={errors['input.responsibilities']}><textarea name="responsibilities" value={value.responsibilities ?? ''} onChange={set('responsibilities')} /></Field><Field label="Reports to" optional><input name="reporting_to" value={value.reporting_to ?? ''} onChange={set('reporting_to')} /></Field></>;
  if (task === 'quiz_draft') return <>{sel('course_id', 'Course', courses.data, (c) => `${c.title} (v${c.version}, ${label(c.status)})`)}<Field label="How many questions"><input name="count" type="number" min={1} max={15} value={value.count ?? 5} onChange={set('count')} style={{ maxWidth: 120 }} /></Field></>;
  if (task === 'management_briefing') return <Field label="Month"><input name="month" type="month" value={value.month ?? ''} onChange={set('month')} style={{ maxWidth: 200 }} /></Field>;
  if (task === 'quality_check') return <>{sel('audit_id', 'Audit rubric', audits.data, (a) => a.title)}<Field label="Evidence to check" hint="Paste the evidence text. Never include resident details." error={errors['input.evidence']}><textarea name="evidence" rows={8} value={value.evidence ?? ''} onChange={set('evidence')} /></Field></>;
  return null;
}

function Output({ value }: { value: any }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return <p style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</p>;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((v, i) => <li key={i}>{typeof v === 'object' ? <Output value={v} /> : String(v)}</li>)}</ul> : <p className="muted">None.</p>;
  return <dl className="facts">{Object.entries(value).flatMap(([k, v]) => [<dt key={`${k}t`}>{label(k)}</dt>, <dd key={k}><Output value={v} /></dd>])}</dl>;
}

export function Assistant() {
  const hub = useHub();
  const toast = useToast();
  const meta = useApi<any>('/ai/tasks');
  const runs = useApi<any[]>('/ai/runs');
  const [company, setCompany] = useState(hub.company !== 'all' ? hub.company : hub.me.companies[0]?.id);
  const [task, setTask] = useState('policy_question');
  const [input, setInput] = useState<any>({});
  const [result, setResult] = useState<any>(null);
  const [amend, setAmend] = useState(false);
  const [note, setNote] = useState('');
  const run = useSubmit(async () => { setResult(null); setResult(await post('/ai/runs', { task, company_id: company, input: { ...input, ...(input.count ? { count: Number(input.count) } : {}) } })); runs.reload(); });
  const review = useSubmit(async (status: string) => { await post(`/ai/runs/${result.id}/review`, { status, note: note || undefined }); setResult({ ...result, status }); setAmend(false); toast(status === 'dismissed' ? 'Dismissed.' : 'Recorded. Remember to check it before using it.'); runs.reload(); });
  const useIt = useSubmit(async () => {
    if (task === 'meeting_minutes') {
      await patch(`/meetings/${result.input.meeting_id}`, { minutes: result.output.minutes });
      toast('Copied into the meeting as draft minutes. They still need approval.');
    } else if (task === 'quiz_draft') {
      const c = (await api('GET', `/courses/${result.input.course_id}`)).course;
      if (c.status !== 'draft') throw new ApiError(409, 'conflict', 'Questions can only be added to a draft course. Create a new version first.');
      const added = result.output.questions.map((q: any) => ({ id: Math.random().toString(36).slice(2, 8), type: q.type, prompt: q.prompt, marks: 1, options: q.options.map((o: any, i: number) => ({ id: String.fromCharCode(97 + i), text: o.text, correct: o.correct })) }));
      await patch(`/courses/${c.id}`, { questions: [...c.questions, ...added] });
      toast(`${added.length} questions added to the draft course for you to check.`);
    } else {
      await navigator.clipboard.writeText(JSON.stringify(result.output, null, 2));
      toast('Copied to the clipboard.');
    }
  });
  if (meta.error) return <LoadError error={meta.error} />;
  if (!meta.data) return <Skeleton lines={6} />;
  const co = meta.data.companies.find((c: any) => c.company_id === company);
  const tasks = meta.data.tasks.filter((t: any) => t.companies.includes(company));
  const original = result && (result.input.rough_notes ?? result.input.evidence ?? result.input.question ?? result.input.responsibilities);
  return (
    <>
      <PageHead title="AI assistant" intro="Drafts help with paperwork. They use only records you can already see, cite where each point came from, and must be checked by you. The assistant never decides employment, pay or contract matters, and never sends anything." />
      {!meta.data.configured && <div className="notice warn">The AI assistant is not set up on this server. Every task can still be done by hand.</div>}
      <section className="card" aria-labelledby="ask-h">
        <h2 id="ask-h">New draft</h2>
        <div className="form-grid">
          <Field label="Company"><select name="company" value={company} onChange={(e) => { setCompany(e.target.value); setInput({}); }}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Task"><select name="task" value={task} onChange={(e) => { setTask(e.target.value); setInput({}); setResult(null); }}>{meta.data.tasks.map((t: any) => <option key={t.key} value={t.key} disabled={!t.companies.includes(company)}>{t.label}{!t.companies.includes(company) ? ' (not available to you here)' : ''}</option>)}</select></Field>
        </div>
        {co && !co.enabled && <div className="notice">The assistant is switched off for this company.</div>}
        {co && co.enabled && !co.allowed && <div className="notice">Your role is not permitted to use the assistant in this company.</div>}
        <ErrorSummary error={run.error} />
        {tasks.some((t: any) => t.key === task) && <TaskInputs task={task} companyId={company} value={input} onChange={setInput} errors={run.error?.fields ?? {}} />}
        <Button busy={run.busy} busyText="Drafting… this can take a minute" disabled={!co?.enabled || !co?.allowed || !tasks.some((t: any) => t.key === task)} onClick={() => run.run()}>Draft it</Button>
      </section>
      {result && (
        <section className="card" aria-labelledby="draft-h">
          <div className="row between"><h2 id="draft-h">Draft — check before using</h2><Status s={result.status === 'draft' ? 'review' : result.status === 'dismissed' ? 'ended' : 'verified'} text={result.status === 'draft' ? 'Awaiting your review' : label(result.status)} /></div>
          <div className="grid-2">
            {original && <div><h3>Your original</h3><p style={{ whiteSpace: 'pre-wrap' }} className="small">{original}</p></div>}
            <div><h3>Draft</h3><Output value={Object.fromEntries(Object.entries(result.output).filter(([k]) => k !== 'missing_evidence' && k !== 'citations'))} /></div>
          </div>
          {result.output.missing_evidence?.length > 0 && <div className="notice warn"><strong>Missing evidence:</strong><ul>{result.output.missing_evidence.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>}
          <details><summary>Sources the assistant was given ({result.sources.length})</summary><ul>{result.sources.map((s: any) => <li key={s.id}>{s.title} <span className="muted small">({label(s.type)}{s.version ? `, version ${s.version}` : ''}, id {s.id})</span></li>)}</ul>
            {result.output.citations?.length > 0 && <><h4>Citations</h4><ul>{result.output.citations.map((c: any, i: number) => <li key={i}>{c.source_id}: {c.note}</li>)}</ul></>}</details>
          <ErrorSummary error={review.error ?? useIt.error} />
          {result.status === 'draft' && <div className="row" style={{ marginTop: 12 }}>
            <Button variant="go" busy={review.busy} onClick={() => review.run('accepted')}>Accept as a starting point</Button>
            <Button variant="secondary" onClick={() => setAmend(true)}>I amended it</Button>
            <Button variant="ghost" busy={review.busy} onClick={() => review.run('dismissed')}>Dismiss</Button>
          </div>}
          {['accepted', 'amended'].includes(result.status) && <p><Button variant="secondary" busy={useIt.busy} onClick={() => useIt.run()}>{task === 'meeting_minutes' ? 'Copy into the meeting as draft minutes' : task === 'quiz_draft' ? 'Add questions to the draft course' : 'Copy to clipboard'}</Button></p>}
        </section>
      )}
      <Reports company={company} />
      <section className="card" aria-labelledby="hist-h"><h2 id="hist-h">History</h2>
        {(runs.data ?? []).length === 0 ? <Empty>No drafts yet.</Empty> : <ul className="list">{runs.data!.map((r) => <li key={r.id}><span>{label(r.task)} <span className="badge co">{r.company_code}</span><br /><span className="small muted">{r.person_name} · {fmtDateTime(r.created_at)} · {r.tokens} tokens{r.error && ` · ${r.error}`}</span></span><Status s={r.status === 'failed' ? 'action' : r.status === 'draft' ? 'review' : 'verified'} text={label(r.status)} /></li>)}</ul>}
      </section>
      <Dialog open={amend} onClose={() => setAmend(false)} title="What did you change?" variant="modal" footer={<Button busy={review.busy} onClick={() => review.run('amended')}>Save</Button>}>
        <Field label="Note" optional><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

// Daily report for managers: the figures, and Claude's summary when the assistant is on.
function Reports({ company }: { company: string }) {
  const hub = useHub();
  const toast = useToast();
  const list = useApi<any[]>(hub.can('performance.view_all', company) ? '/ai/reports' : null);
  const now = useSubmit(async () => { await post(`/ai/reports/${company}/run`, {}); toast('Report updated.'); list.reload(); });
  if (!hub.can('performance.view_all', company)) return null;
  const reports = (list.data ?? []).filter((r) => r.company_id === company);
  const r = reports[0];
  return (
    <section className="card" id="reports" aria-labelledby="rep-h">
      <div className="row between"><h2 id="rep-h">Daily report</h2><Button variant="secondary" busy={now.busy} onClick={() => now.run()}>Refresh now</Button></div>
      <p className="small muted">Made every morning for managers, who get a notification. With the assistant on, Claude adds a summary; otherwise you see the figures.</p>
      <ErrorSummary error={now.error ?? list.error} />
      {!r ? <Empty>No report yet. Press Refresh now to make today's.</Empty> : <>
        <p className="small muted">{fmtDateTime(r.created_at)}</p>
        {r.summary && <><p><strong>{r.summary.headline}</strong></p><div className="grid-2"><div><h3>Needs action</h3><Output value={r.summary.priorities} /></div><div><h3>Risks to watch</h3><Output value={r.summary.risks} /></div></div><h3>Going well</h3><Output value={r.summary.going_well} /></>}
        <details open={!r.summary}><summary>Figures</summary><Output value={r.figures} /></details>
      </>}
    </section>
  );
}

const ROLE_KEYS = ['staff', 'manager', 'hr_admin', 'quality_lead', 'company_admin', 'super_admin', 'finance_admin', 'property_officer'];
export function AiSettings() {
  const toast = useToast();
  const d = useApi<any>('/ai/settings');
  const meta = useApi<any>('/ai/tasks');
  const [f, setF] = useState<any>(null);
  const save = useSubmit(async () => { await api('PUT', `/ai/settings/${f.company_id}`, { enabled: f.enabled, model: f.model, allowed_roles: f.allowed_roles, allowed_tasks: f.allowed_tasks, monthly_token_limit: Number(f.monthly_token_limit), retention_days: Number(f.retention_days) }); setF(null); toast('AI settings saved.'); d.reload(); });
  if (!d.data) return <Skeleton />;
  const toggle = (k: string, v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x: string) => x !== v) : [...f[k], v] });
  return (
    <>
      <PageHead title="AI assistant settings" crumbs={[['Admin Centre', '/admin'], ['AI assistant']]} intro="Off by default. The API key is kept in the server environment, never in the browser. Drafts are deleted after the retention period; the audit log keeps a record that each draft was made." />
      {!d.data.configured && <div className="notice warn">No API key is set on the server (ANTHROPIC_API_KEY), or AI_ENABLED is false. The assistant cannot run until that is done.</div>}
      {d.data.settings.map((s: any) => (
        <section key={s.company_id} className="card"><div className="row between"><h2 style={{ fontSize: '1.125rem', margin: 0 }}>{s.company_name}</h2><Status s={s.enabled ? 'verified' : 'ended'} text={s.enabled ? 'On' : 'Off'} /></div>
          <p className="small">Model {s.model} · {s.used_this_month.toLocaleString('en-GB')} of {s.monthly_token_limit.toLocaleString('en-GB')} tokens used this month · drafts kept {s.retention_days} days<br />Roles: {s.allowed_roles.map(label).join(', ')}</p>
          <Button variant="secondary" onClick={() => setF({ ...s })}>Change</Button></section>
      ))}
      <Dialog open={!!f} onClose={() => setF(null)} title="AI assistant settings" footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        {f && <><ErrorSummary error={save.error} />
          <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Switch the assistant on for {f.company_name}</label>
          <Field label="Model"><select name="model" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}><option value="claude-opus-5-5">Claude Opus 5.5 (recommended)</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5 (lower cost)</option><option value="claude-haiku-5-5">Claude Haiku 5.5 (lowest cost)</option></select></Field>
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Who may use it</legend>{ROLE_KEYS.map((r) => <label key={r} className="check"><input type="checkbox" checked={f.allowed_roles.includes(r)} onChange={() => toggle('allowed_roles', r)} /> {label(r)}</label>)}</fieldset>
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Tasks</legend>{(meta.data?.tasks ?? []).map((t: any) => <label key={t.key} className="check"><input type="checkbox" checked={f.allowed_tasks.includes(t.key)} onChange={() => toggle('allowed_tasks', t.key)} /> {t.label}</label>)}</fieldset>
          <div className="form-grid"><Field label="Monthly token limit"><input name="limit" type="number" min={0} value={f.monthly_token_limit} onChange={(e) => setF({ ...f, monthly_token_limit: e.target.value })} /></Field><Field label="Keep drafts for (days)"><input name="retention" type="number" min={1} max={3650} value={f.retention_days} onChange={(e) => setF({ ...f, retention_days: e.target.value })} /></Field></div></>}
      </Dialog>
    </>
  );
}
