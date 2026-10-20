import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, patch, post, put, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

export const LEVELS: [string, string][] = [['not_assessed', 'Not Assessed'], ['developing', 'Developing'], ['competent', 'Competent'], ['verified_to_support', 'Verified to Support Others']];
const levelLabel = (l: string) => LEVELS.find(([v]) => v === l)?.[1] ?? label(l);
const OUTCOME: Record<string, string> = { pending: 'Due', on_track: 'On track', concerns: 'Concerns raised', passed: 'Passed', extended: 'Extended', not_passed: 'Not passed' };

// ── Person profile tab: job description, onboarding, probation, competence ──
export function DevelopmentTab({ personId, isMe }: { personId: string; isMe: boolean }) {
  const d = useApi<any>(`/people/${personId}/development`);
  const [assessing, setAssessing] = useState<any>(null);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={6} />;
  const { appointments, competence } = d.data;
  const assessFor = appointments.filter((a: any) => a.is_current && a.can.assess);
  return (
    <>
      {appointments.filter((a: any) => a.is_current || a.onboarding).map((a: any) => <AppointmentDev key={a.id} a={a} isMe={isMe} reload={d.reload} />)}
      <section className="card" aria-labelledby="comp-h">
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 id="comp-h" style={{ fontSize: '1.125rem' }}>Competence</h2>
          {assessFor.length > 0 && <Button variant="secondary" onClick={() => setAssessing(assessFor)}>Record an assessment</Button>}</div>
        <p className="small muted">Assessed by observing practice. Completing training does not by itself show competence.</p>
        {competence.length ? (
          <div className="table-wrap"><table><thead><tr><th>Competency</th><th>Level</th><th>Assessed</th><th>Evidence</th><th>Review due</th></tr></thead>
            <tbody>{competence.map((c: any) => <tr key={c.id}><td>{c.competency_name}{c.history > 1 && <span className="small muted"> ({c.history} assessments)</span>}</td><td>{levelLabel(c.level)}</td>
              <td>{fmtDate(c.assessed_on)}<br /><span className="small muted">by {c.assessor_name}</span></td><td className="small">{c.evidence}<br /><span className="muted">Rubric: {c.rubric_notes}</span></td>
              <td>{c.review_due ? fmtDate(c.review_due) : '—'}</td></tr>)}</tbody></table></div>
        ) : <Empty>No competency assessments yet.</Empty>}
      </section>
      {assessing && <AssessDialog personId={personId} appts={assessing} onClose={() => setAssessing(null)} onSaved={() => { setAssessing(null); d.reload(); }} />}
    </>
  );
}

function AppointmentDev({ a, isMe, reload }: { a: any; isMe: boolean; reload: () => void }) {
  const toast = useToast();
  const [setJd, setSetJd] = useState(false);
  const ack = useSubmit(async () => { await post(`/job-descriptions/${a.job_description.id}/acknowledge`, {}); toast('Acknowledged.'); reload(); });
  const start = useSubmit(async () => { await post(`/appointments/${a.id}/onboarding`, {}); toast('Onboarding started.'); reload(); });
  const items = a.onboarding?.items ?? [];
  const done = items.filter((i: any) => i.done_at).length;
  return (
    <section className="card" aria-labelledby={`dev-${a.id}`}>
      <h2 id={`dev-${a.id}`} style={{ fontSize: '1.125rem' }}>{a.job_title} <CompanyBadge code={a.company_code} name={a.company_name} /></h2>
      <h3 style={{ fontSize: '1rem' }}>Job description</h3>
      {a.job_description ? (
        <p><Link to={`/job-descriptions/${a.job_description.id}`}>{a.job_description.title} (version {a.job_description.version})</Link>{' '}
          {a.job_description.acknowledged_at ? <span className="small muted">Acknowledged {fmtDateTime(a.job_description.acknowledged_at)}</span>
            : isMe ? <Button variant="secondary" busy={ack.busy} onClick={() => ack.run()} aria-label={`I have read and understood the job description for ${a.job_title}, ${a.company_name}`}>I have read and understood it</Button> : <Status s="pending" text="Not yet acknowledged" />}</p>
      ) : <p className="muted">No job description linked.</p>}
      {a.can.setJd && <Button variant="ghost" onClick={() => setSetJd(true)} aria-label={`${a.job_description ? 'Change' : 'Link'} job description for ${a.job_title}, ${a.company_name}`}>{a.job_description ? 'Change job description' : 'Link a job description'}</Button>}
      <ErrorSummary error={ack.error ?? start.error} />

      <h3 style={{ fontSize: '1rem', marginTop: 16 }}>Onboarding</h3>
      {a.onboarding ? (
        <>
          <div className="progress"><div className="bar" role="progressbar" aria-label="Onboarding progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}><span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} /></div><span className="small">{done} of {items.length} done</span></div>
          <ul className="list">{items.map((i: any) => <OnboardingItem key={i.id} i={i} editable={a.can.onboarding} reload={reload} />)}</ul>
        </>
      ) : a.can.onboarding ? <Button variant="secondary" busy={start.busy} onClick={() => start.run()} aria-label={`Start onboarding checklist for ${a.job_title}, ${a.company_name}`}>Start onboarding checklist</Button> : <p className="muted">Not started.</p>}

      {a.probation.length > 0 && <>
        <h3 style={{ fontSize: '1rem', marginTop: 16 }}>Probation reviews</h3>
        <ul className="list">{a.probation.map((r: any) => <ProbationRow key={r.id} r={r} editable={a.can.onboarding} reload={reload} />)}</ul>
      </>}
      {setJd && <LinkJdDialog a={a} onClose={() => setSetJd(false)} onSaved={() => { setSetJd(false); reload(); }} />}
    </section>
  );
}

function OnboardingItem({ i, editable, reload }: { i: any; editable: boolean; reload: () => void }) {
  const tick = useSubmit(async (doneNow: boolean) => { await patch(`/onboarding-items/${i.id}`, { done: doneNow }); reload(); });
  const id = `ob-${i.id}`;
  return (
    <li>
      <span>{editable ? <label className="check" htmlFor={id}><input id={id} type="checkbox" checked={!!i.done_at} disabled={tick.busy} onChange={(e) => tick.run(e.target.checked)} /> {i.title}</label> : <>{i.done_at ? '✓ ' : ''}{i.title}</>}
        {i.done_at && <><br /><span className="small muted">Done {fmtDate(i.done_at)}{i.done_by_name && ` by ${i.done_by_name}`}</span></>}</span>
      <ErrorSummary error={tick.error} />
    </li>
  );
}

function ProbationRow({ r, editable, reload }: { r: any; editable: boolean; reload: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const opts: [string, string][] = r.kind === 'interim' ? [['on_track', 'On track'], ['concerns', 'Concerns raised']] : [['passed', 'Passed'], ['extended', 'Extended'], ['not_passed', 'Not passed']];
  const [f, setF] = useState({ outcome: opts[0][0], notes: '', extend_to: '' });
  const save = useSubmit(async () => { await post(`/probation-reviews/${r.id}/complete`, { ...f, extend_to: f.extend_to || undefined }); toast('Review recorded.'); setOpen(false); reload(); });
  return (
    <li>
      <span>{label(r.kind)} review · due {fmtDate(r.due_on)}{r.reviewer_name && <span className="small muted"> · {r.reviewer_name}</span>}{r.notes && <><br /><span className="small">{r.notes}</span></>}</span>
      <span className="row"><Status s={r.outcome === 'pending' ? 'pending' : ['passed', 'on_track'].includes(r.outcome) ? 'approved' : 'rejected'} text={OUTCOME[r.outcome]} />
        {editable && r.outcome === 'pending' && <Button variant="secondary" onClick={() => setOpen(true)} aria-label={`Record ${r.kind} review`}>Record</Button>}</span>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${label(r.kind)} probation review`} footer={<Button busy={save.busy} onClick={() => save.run()}>Save review</Button>}>
        <ErrorSummary error={save.error} />
        <Field label="Outcome" error={save.error?.fields.outcome}><select name="outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
        {f.outcome === 'extended' && <Field label="New review date" error={save.error?.fields.extend_to}><input name="extend_to" type="date" value={f.extend_to} min={r.due_on} onChange={(e) => setF({ ...f, extend_to: e.target.value })} /></Field>}
        <Field label="What was discussed and agreed" hint="Seen only by them, HR and onboarding managers." error={save.error?.fields.notes}><textarea name="notes" rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </Dialog>
    </li>
  );
}

function AssessDialog({ personId, appts, onClose, onSaved }: { personId: string; appts: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const comps = useApi<any[]>('/competencies');
  const cos = appts.map((a) => a.company_id);
  const list = (comps.data ?? []).filter((c) => c.active && cos.includes(c.company_id));
  const [f, setF] = useState({ competency_id: '', level: 'competent', assessed_on: londonToday(), rubric_notes: '', evidence: '', review_due: '' });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const chosen = list.find((c) => c.id === f.competency_id);
  const save = useSubmit(async () => {
    if (!f.competency_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { competency_id: 'Choose a competency' } });
    await post(`/people/${personId}/competency-assessments`, { ...f, review_due: f.review_due || null }); toast('Assessment recorded.'); onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title="Record a competency assessment" footer={<Button busy={save.busy} onClick={() => save.run()}>Save assessment</Button>}>
      <ErrorSummary error={save.error} />
      {comps.data && !list.length && <p className="notice">No competencies are set up yet. Add them in Admin Centre → Templates.</p>}
      <Field label="Competency" error={e.competency_id}><select name="competency_id" value={f.competency_id} onChange={set('competency_id')}><option value="">Choose…</option>{list.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.company_code})</option>)}</select></Field>
      {chosen && <div className="notice small"><strong>Rubric:</strong> {chosen.rubric}</div>}
      <div className="form-grid">
        <Field label="Level" error={e.level}><select name="level" value={f.level} onChange={set('level')}>{LEVELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
        <Field label="Assessed on" error={e.assessed_on}><input name="assessed_on" type="date" max={londonToday()} value={f.assessed_on} onChange={set('assessed_on')} /></Field>
      </div>
      <Field label="How the rubric was applied" error={e.rubric_notes}><textarea name="rubric_notes" rows={2} value={f.rubric_notes} onChange={set('rubric_notes')} /></Field>
      <Field label="Evidence" hint="What you observed. A training certificate alone is not evidence of competence." error={e.evidence}><textarea name="evidence" rows={3} value={f.evidence} onChange={set('evidence')} /></Field>
      <Field label="Review by" optional error={e.review_due}><input name="review_due" type="date" min={f.assessed_on} value={f.review_due} onChange={set('review_due')} /></Field>
    </Dialog>
  );
}

function LinkJdDialog({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const jds = useApi<any[]>(`/job-descriptions?company=${a.company_id}`);
  const [root, setRoot] = useState(a.job_description ? '' : '');
  const save = useSubmit(async () => { await put(`/appointments/${a.id}/job-description`, { root_id: root || null }); onSaved(); });
  const published = (jds.data ?? []).filter((j) => j.published_id);
  return (
    <Dialog open onClose={onClose} title="Link a job description" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
      <ErrorSummary error={save.error ?? jds.error} />
      {jds.data && !published.length && <p className="notice">No published job descriptions for {a.company_name} yet. Write one in Admin Centre → Templates.</p>}
      <Field label="Job description" hint="They will be asked to read and acknowledge it."><select name="root_id" value={root} onChange={(e) => setRoot(e.target.value)}><option value="">None</option>{published.map((j) => <option key={j.root_id} value={j.root_id}>{j.title}</option>)}</select></Field>
    </Dialog>
  );
}

// ── One job description version ──
export function JobDescriptionPage() {
  const { id } = useParams();
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any>(`/job-descriptions/${id}`);
  const ack = useSubmit(async () => { await post(`/job-descriptions/${id}/acknowledge`, {}); toast('Thank you. Your acknowledgement of this version is recorded.'); await hub.reloadMe(); d.reload(); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const j = d.data;
  const S = ({ t, v }: { t: string; v?: string | null }) => (v ? <section style={{ marginTop: 16 }}><h2 style={{ fontSize: '1.125rem' }}>{t}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{v}</p></section> : null);
  return (
    <>
      <PageHead title={j.title} crumbs={[[j.company_name], [`Version ${j.version}`]]} intro={<><Status s={j.status === 'published' ? 'active' : j.status === 'draft' ? 'planned' : 'ended'} text={label(j.status)} /> {j.published_at && <span className="small muted">Published {fmtDate(j.published_at)}{j.published_by_name && ` by ${j.published_by_name}`}</span>}</>} />
      <article className="card">
        <S t="Purpose" v={j.purpose} /><S t="Duties" v={j.duties} /><S t="Boundaries (what this role does not do)" v={j.boundaries} /><S t="Standards" v={j.standards} />
        <S t="Reports to" v={j.reports_to} /><S t="Required training" v={j.required_training} /><S t="Required qualifications" v={j.required_qualifications} />
      </article>
      <ErrorSummary error={ack.error} />
      {j.acknowledged_at && <p className="notice ok">You acknowledged this version on {fmtDate(j.acknowledged_at)}.</p>}
      {j.can.acknowledge && <Button busy={ack.busy} onClick={() => ack.run()}>I have read and understood version {j.version}</Button>}
      {j.versions.length > 1 && <p className="small muted" style={{ marginTop: 16 }}>Versions: {j.versions.map((v: any) => <Link key={v.id} to={`/job-descriptions/${v.id}`} style={{ marginRight: 8 }}>v{v.version} ({label(v.status)})</Link>)}</p>}
    </>
  );
}

// ── Admin Centre → Templates: job descriptions, competencies, onboarding templates ──
export function TemplatesAdmin() {
  const [tab, setTab] = useState<'jd' | 'comp' | 'onb'>('jd');
  return (
    <>
      <PageHead title="Templates" crumbs={[['Admin Centre', '/admin'], ['Templates']]} intro="Job descriptions (versioned, acknowledged per version), competencies with their rubrics, and onboarding checklists." />
      <Chips label="Show" value={tab} onChange={setTab} options={[['jd', 'Job descriptions'], ['comp', 'Competencies'], ['onb', 'Onboarding templates']]} />
      <div style={{ marginTop: 16 }}>{tab === 'jd' ? <JdAdmin /> : tab === 'comp' ? <CompAdmin /> : <OnbAdmin />}</div>
    </>
  );
}
const useManageCos = (perm: string) => useHub().me.companies.filter((c) => c.perms.includes(perm));

const JD_FIELDS: [string, string, number, boolean][] = [['title', 'Title', 1, true], ['purpose', 'Purpose', 2, false], ['duties', 'Duties', 6, true], ['boundaries', 'Boundaries (what the role does not do)', 3, false],
  ['standards', 'Standards', 3, false], ['reports_to', 'Reports to', 1, false], ['required_training', 'Required training', 2, false], ['required_qualifications', 'Required qualifications', 2, false]];

function JdAdmin() {
  const d = useApi<any[]>('/job-descriptions');
  const cos = useManageCos('jobs.manage');
  const [edit, setEdit] = useState<any>(null);
  const toast = useToast();
  const act = useSubmit(async (path: string, msg: string) => { const r = await post(path, {}); toast(msg); d.reload(); if (r?.id) setEdit(r); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  return (
    <>
      <Button onClick={() => setEdit({ company_id: cos[0]?.id ?? '' })} disabled={!cos.length}>New job description</Button>
      <ErrorSummary error={act.error} />
      {!d.data ? <Skeleton /> : d.data.length ? <ul className="list" style={{ marginTop: 12 }}>{d.data.map((j) => (
        <li key={j.id}><span><Link to={`/job-descriptions/${j.id}`}>{j.title}</Link> <CompanyBadge code={j.company_code} name={j.company_name} /><br /><span className="small muted">Version {j.version} · {label(j.status)} · {j.people} current {j.people === 1 ? 'person' : 'people'}</span></span>
          <span className="row">{j.status === 'draft' ? <><Button variant="secondary" onClick={() => setEdit(j)} aria-label={`Edit draft ${j.title}`}>Edit</Button><Button onClick={() => act.run(`/job-descriptions/${j.id}/publish`, 'Published. Linked staff are asked to acknowledge it.')} aria-label={`Publish ${j.title}`}>Publish</Button></>
            : <Button variant="secondary" onClick={() => act.run(`/job-descriptions/${j.id}/new-version`, 'New draft version created.')} aria-label={`New version of ${j.title}`}>New version</Button>}</span></li>))}</ul>
        : <Empty>No job descriptions yet.</Empty>}
      {edit && <JdEditor jd={edit} cos={cos} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); }} />}
    </>
  );
}
function JdEditor({ jd, cos, onClose, onSaved }: { jd: any; cos: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(() => Object.fromEntries([['company_id', jd.company_id], ...JD_FIELDS.map(([k]) => [k, jd[k] ?? ''])]));
  const save = useSubmit(async () => {
    const body = Object.fromEntries(JD_FIELDS.map(([k, , , req]) => [k, f[k] || (req ? f[k] : null)]));
    if (jd.id) await patch(`/job-descriptions/${jd.id}`, body); else await post('/job-descriptions', { company_id: f.company_id, ...body });
    onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={jd.id ? `Edit draft (version ${jd.version})` : 'New job description'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save draft</Button>}>
      <ErrorSummary error={save.error} />
      {!jd.id && <Field label="Company"><select name="company_id" value={f.company_id} onChange={(ev) => setF({ ...f, company_id: ev.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      {JD_FIELDS.map(([k, t, rows, req]) => <Field key={k} label={t} optional={!req} error={e[k]}>{rows === 1 ? <input name={k} value={f[k]} onChange={(ev) => setF({ ...f, [k]: ev.target.value })} /> : <textarea name={k} rows={rows} value={f[k]} onChange={(ev) => setF({ ...f, [k]: ev.target.value })} />}</Field>)}
      <p className="small muted">Drafts are private to administrators. Publishing makes this version the one people acknowledge; it cannot then be edited.</p>
    </Dialog>
  );
}

function CompAdmin() {
  const d = useApi<any[]>('/competencies');
  const cos = useManageCos('jobs.manage');
  const [edit, setEdit] = useState<any>(null);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  return (
    <>
      <Button onClick={() => setEdit({ company_id: cos[0]?.id ?? '', name: '', description: '', rubric: 'Developing: \nCompetent: \nVerified to support others: ' })} disabled={!cos.length}>New competency</Button>
      {!d.data ? <Skeleton /> : d.data.length ? <ul className="list" style={{ marginTop: 12 }}>{d.data.map((c) => (
        <li key={c.id}><span>{c.name} <CompanyBadge code={c.company_code} name={c.company_name} />{!c.active && <Status s="ended" text="Retired" />}<br /><span className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{c.rubric}</span></span>
          {cos.some((x) => x.id === c.company_id) && <Button variant="secondary" onClick={() => setEdit(c)} aria-label={`Edit ${c.name}`}>Edit</Button>}</li>))}</ul> : <Empty>No competencies yet.</Empty>}
      {edit && <CompEditor c={edit} cos={cos} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); }} />}
    </>
  );
}
function CompEditor({ c, cos, onClose, onSaved }: { c: any; cos: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ company_id: c.company_id, name: c.name, description: c.description ?? '', rubric: c.rubric, active: c.active ?? true });
  const save = useSubmit(async () => {
    const body = { name: f.name, description: f.description || null, rubric: f.rubric };
    if (c.id) await patch(`/competencies/${c.id}`, { ...body, active: f.active }); else await post('/competencies', { company_id: f.company_id, ...body });
    onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={c.id ? 'Edit competency' : 'New competency'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
      <ErrorSummary error={save.error} />
      {!c.id && <Field label="Company"><select name="company_id" value={f.company_id} onChange={(ev) => setF({ ...f, company_id: ev.target.value })}>{cos.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
      <Field label="Name" error={e.name}><input name="name" value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} /></Field>
      <Field label="Description" optional error={e.description}><textarea name="description" rows={2} value={f.description} onChange={(ev) => setF({ ...f, description: ev.target.value })} /></Field>
      <Field label="Rubric" hint="What each level looks like in practice." error={e.rubric}><textarea name="rubric" rows={5} value={f.rubric} onChange={(ev) => setF({ ...f, rubric: ev.target.value })} /></Field>
      {c.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(ev) => setF({ ...f, active: ev.target.checked })} /> In use (untick to retire; past assessments are kept)</label>}
    </Dialog>
  );
}

const OB_KINDS = ['profile', 'checks', 'contract', 'job_description', 'induction', 'policies', 'training', 'competence', 'allocation', 'probation', 'other'];
function OnbAdmin() {
  const d = useApi<any[]>('/onboarding-templates');
  const cos = useManageCos('jobs.manage');
  const [edit, setEdit] = useState<any>(null);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  return (
    <>
      <p className="small muted">Without a template, onboarding uses the standard ten-step checklist and a six-month probation (interim review at three months).</p>
      <Button onClick={() => setEdit({ company_id: cos[0]?.id ?? '', name: '', probation_months: 6, items: [] })} disabled={!cos.length}>New template</Button>
      {!d.data ? <Skeleton /> : d.data.length ? <ul className="list" style={{ marginTop: 12 }}>{d.data.map((t) => (
        <li key={t.id}><span>{t.name} <CompanyBadge code={t.company_code} name={t.company_name} /><br /><span className="small muted">{t.items.length} steps · probation {t.probation_months} months{!t.active && ' · retired'}</span></span>
          <Button variant="secondary" onClick={() => setEdit(t)} aria-label={`Edit ${t.name}`}>Edit</Button></li>))}</ul> : <Empty>No templates yet.</Empty>}
      {edit && <OnbEditor t={edit} cos={cos} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); d.reload(); }} />}
    </>
  );
}
function OnbEditor({ t, cos, onClose, onSaved }: { t: any; cos: any[]; onClose: () => void; onSaved: () => void }) {
  // One step per line: "kind: title". Unknown kinds become "other".
  const [f, setF] = useState({ company_id: t.company_id, name: t.name, probation_months: String(t.probation_months), steps: t.items.map((i: any) => `${i.kind}: ${i.title}`).join('\n'), active: t.active ?? true });
  const save = useSubmit(async () => {
    const items = f.steps.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(\w+):\s*(.+)$/); return m && OB_KINDS.includes(m[1]) ? { kind: m[1], title: m[2] } : { kind: 'other', title: l }; });
    const body = { name: f.name, probation_months: Number(f.probation_months), ...(items.length ? { items } : {}) };
    if (t.id) await patch(`/onboarding-templates/${t.id}`, { ...body, active: f.active }); else await post('/onboarding-templates', { company_id: f.company_id, ...body });
    onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={t.id ? 'Edit onboarding template' : 'New onboarding template'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
      <ErrorSummary error={save.error} />
      {!t.id && <Field label="Company"><select name="company_id" value={f.company_id} onChange={(ev) => setF({ ...f, company_id: ev.target.value })}>{cos.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
      <Field label="Name" hint="For example the role it is for." error={e.name}><input name="name" value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} /></Field>
      <Field label="Probation length (months)" hint="0 for none." error={e.probation_months}><input name="probation_months" type="number" min={0} max={24} value={f.probation_months} onChange={(ev) => setF({ ...f, probation_months: ev.target.value })} style={{ maxWidth: 120 }} /></Field>
      <Field label="Steps, one per line" optional hint={`Start a line with a type and a colon, e.g. "induction: Shadow two property visits". Types: ${OB_KINDS.join(', ')}. Leave empty for the standard checklist.`} error={e.items}>
        <textarea name="steps" rows={8} value={f.steps} onChange={(ev) => setF({ ...f, steps: ev.target.value })} />
      </Field>
      {t.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(ev) => setF({ ...f, active: ev.target.checked })} /> In use</label>}
    </Dialog>
  );
}
