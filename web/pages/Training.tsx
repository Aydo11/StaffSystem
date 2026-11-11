import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, blobUrl, download, patch, post, serverNow, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtElapsed, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';
import { CATEGORY, CourseLibrary, LearningHome } from './Learning.tsx';

const CHOICE_TYPES = ['single', 'multiple', 'true_false'];
const MATRIX_STATUS: Record<string, [string, string]> = { current: ['verified', 'Up to date'], expiring: ['submitted', 'Renew soon'], due: ['info', 'Due'], overdue: ['action', 'Overdue'] };

export function Paragraphs({ text }: { text?: string | null }) {
  return <>{(text ?? '').split(/\n{2,}/).filter(Boolean).map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}</>;
}
export function FileImage({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let u: string | null = null; blobUrl(`/files/${id}`).then((x) => { u = x; setSrc(x); }); return () => { if (u) URL.revokeObjectURL(u); }; }, [id]);
  return src ? <img src={src} alt={alt} style={{ maxHeight: 360, borderRadius: 8, margin: '8px 0' }} /> : <div className="skeleton" style={{ height: 120 }} aria-label={alt} />;
}

type Tab = 'mine' | 'courses' | 'record' | 'manage';
export function Training() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const manager = hub.can('training.manage') || hub.can('training.view_all');
  const tab = (params.get('tab') as Tab) ?? 'mine';
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const canCreate = hub.me.companies.some((c) => c.perms.includes('training.manage')) || hub.me.superAdmin;
  const tabs: [Tab, string][] = [['mine', 'Dashboard'], ['courses', 'Course library'], ['record', 'My record'], ...(manager ? [['manage', 'Manage training'] as [Tab, string]] : [])];
  return (
    <>
      <PageHead title="Training & coaching" intro="Courses, assessments and your training record. Completing training shows learning, not competence; competence is assessed separately."
        actions={canCreate && tab === 'manage' ? <Button variant="secondary" onClick={() => setImporting(true)}>Import course pack</Button> : undefined} />
      <Tabs label="Training sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'mine' && <LearningHome onTab={(t) => setParams({ tab: t })} />}
      {tab === 'courses' && <CourseLibrary onBuild={canCreate ? () => setCreating(true) : undefined} />}
      {tab === 'record' && <MyTraining />}
      {creating && <NewCourse onClose={() => setCreating(false)} onSaved={(id) => nav(`/training/courses/${id}/edit`)} />}
      {tab === 'manage' && manager && <Manage />}
      {importing && <ImportPack onClose={() => setImporting(false)} />}
    </>
  );
}

function MyTraining() {
  const toast = useToast();
  const matrix = useApi<any[]>('/training/matrix?person=me');
  const records = useApi<any[]>('/training/records');
  const [ext, setExt] = useState<any>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const addExt = useSubmit(async () => {
    const r = await post('/training/records', { title: ext.title, provider: ext.provider || null, completed_on: ext.completed_on });
    if (ext.file) { setProgress(0); try { await upload(`/training/records/${r.id}/certificate`, ext.file, ext.file.name, setProgress); } finally { setProgress(null); } }
    setExt(null); toast('Sent for verification. It will count once a trainer has checked it.'); records.reload();
  });
  return (
    <div className="stack">
      <section className="card" aria-labelledby="req-h">
        <h2 id="req-h">Required and assigned training</h2>
        {matrix.loading && !matrix.data ? <Skeleton /> : (matrix.data ?? []).length === 0 ? <Empty>No training is required for your roles yet.</Empty> : (
          <ul className="list">{matrix.data!.map((m) => {
            const [s, t] = MATRIX_STATUS[m.status];
            return <li key={`${m.company_id}${m.course_root_id}`}><span><strong>{m.course_title ?? 'Course not yet published'}</strong> <CompanyBadge code={m.company_code} name={m.company_name} /><br />
              <span className="muted small">{m.completed_on ? `Completed ${fmtDate(m.completed_on)}` : 'Not completed'}{m.renew_on && ` · renew by ${fmtDate(m.renew_on)}`}{!m.completed_on && ` · due ${fmtDate(m.due_on)}`}{m.source === 'assignment' && ' · assigned to you'}</span></span>
              <span className="row"><Status s={s} text={t} />{m.course_id && m.status !== 'current' && <Link className="btn secondary" to={`/training/courses/${m.course_id}`}>Open course</Link>}</span></li>;
          })}</ul>
        )}
      </section>
      <section className="card" aria-labelledby="rec-h">
        <div className="row between"><h2 id="rec-h">My training record</h2><Button variant="secondary" onClick={() => setExt({ title: '', provider: '', completed_on: londonToday(), file: null })}>Add an external certificate</Button></div>
        {(records.data ?? []).length === 0 ? <Empty>Nothing completed yet.</Empty> : (
          <ul className="list">{records.data!.map((r) => <li key={r.id}><span><strong>{r.title}</strong><br /><span className="muted small">{fmtDate(r.completed_on)} · {r.source === 'course' ? 'Hub course' : `External${r.provider ? `, ${r.provider}` : ''}`}</span></span>
            {r.source === 'course' && <Link className="btn secondary" to={`/training/certificates/${r.id}`}>Certificate</Link>}
            {r.source === 'external' && (r.verified_at ? <Status s="verified" text={`Verified by ${r.verified_by_name}`} /> : <Status s="awaiting_verification" />)}</li>)}</ul>
        )}
      </section>
      <Dialog open={!!ext} onClose={() => setExt(null)} title="Add an external certificate" footer={<Button busy={addExt.busy} onClick={() => addExt.run()}>Send for verification</Button>}>
        {ext && <>
          <ErrorSummary error={addExt.error} />
          <Field label="Course or qualification title" error={addExt.error?.fields.title}><input name="title" value={ext.title} onChange={(e) => setExt({ ...ext, title: e.target.value })} /></Field>
          <Field label="Provider" optional><input name="provider" value={ext.provider} onChange={(e) => setExt({ ...ext, provider: e.target.value })} /></Field>
          <Field label="Completed on" error={addExt.error?.fields.completed_on}><input name="completed_on" type="date" max={londonToday()} value={ext.completed_on} onChange={(e) => setExt({ ...ext, completed_on: e.target.value })} /></Field>
          <FilePicker label="Certificate (PDF or photo)" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(fs) => setExt({ ...ext, file: fs[0] ?? null })} />
          {progress !== null && <progress max={100} value={progress} aria-label="Upload progress" />}
        </>}
      </Dialog>
    </div>
  );
}

/** A course pack is a JSON file ({ format: 'hub-course-pack', pack, courses: [...] }); every course arrives as a draft waiting for content review. */
function ImportPack({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('training.manage'));
  const [company, setCompany] = useState(cos[0]?.id ?? '');
  const [pack, setPack] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const read = useSubmit(async (f: File) => {
    let j: any; try { j = JSON.parse(await f.text()); } catch { throw new ApiError(400, 'validation', 'This file is not a course pack (it is not valid JSON).'); }
    if (j?.format !== 'hub-course-pack' || !Array.isArray(j.courses)) throw new ApiError(400, 'validation', 'This file is not a Hub course pack.');
    setPack(j);
  });
  const save = useSubmit(async () => { const r = await api('POST', '/courses/import', { company_id: company || null, pack: pack.pack, courses: pack.courses }); setDone(r); toast(`${r.added.length} course${r.added.length === 1 ? '' : 's'} added as drafts.`); });
  return (
    <Dialog open onClose={onClose} title="Import a course pack" variant="modal" footer={done ? <Button onClick={onClose}>Close</Button> : <Button busy={save.busy} disabled={!pack} onClick={() => save.run()}>Add as drafts</Button>}>
      <ErrorSummary error={read.error ?? save.error} />
      {done ? <>
        <p>{done.added.length} added as drafts waiting for content review{done.skipped.length ? `; ${done.skipped.length} skipped because a course with the same title already exists` : ''}.</p>
        <p className="small muted">Open each course from the library, check it, approve the content and publish it.</p>
      </> : <>
        <p className="small">Courses arrive as drafts marked <strong>waiting for content review</strong>. Nobody sees them until someone checks, approves and publishes each one. A course whose title already exists is skipped.</p>
        <Field label="Owned by"><select name="company_id" value={company} onChange={(e) => setCompany(e.target.value)}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}{hub.me.superAdmin && <option value="">Shared learning (all companies)</option>}</select></Field>
        <FilePicker label="Course pack file (.json)" accept="application/json,.json" onChange={(fs) => (fs[0] ? read.run(fs[0]) : setPack(null))} />
        {pack && <><p><strong>{pack.pack}</strong> · {pack.courses.length} course{pack.courses.length === 1 ? '' : 's'}</p>
          <ul className="small">{pack.courses.map((c: any) => <li key={c.title}>{c.title}{c.duration_minutes ? ` · ${c.duration_minutes} min` : ''}</li>)}</ul></>}
      </>}
    </Dialog>
  );
}

function NewCourse({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const hub = useHub();
  const cos = hub.me.companies.filter((c) => c.perms.includes('training.manage'));
  const [f, setF] = useState({ company_id: cos[0]?.id ?? '', title: '' });
  const save = useSubmit(async () => { const c = await post('/courses', { company_id: f.company_id || null, title: f.title }); onSaved(c.id); });
  return (
    <Dialog open onClose={onClose} title="Build a course" variant="modal" footer={<Button busy={save.busy} onClick={() => save.run()}>Create draft</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Owned by"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}{hub.me.superAdmin && <option value="">Shared learning (all companies)</option>}</select></Field>
      <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    </Dialog>
  );
}

const answered = (qn: any, v: any) => qn.type === 'observation' || (Array.isArray(v) ? v.length > 0 && v.every(Boolean) : !!String(v ?? '').trim());

/** One question's answer control. Answers: choice → [ids]; matching → right ids in pair order; ordering → ids; written/fill → text; file → file id (server-set). */
function Answer({ qn, value, set, attemptId }: { qn: any; value: any; set: (v: any) => void; attemptId: string }) {
  const evidence = useSubmit(async (f: File) => { const r = await upload(`/attempts/${attemptId}/files/${qn.id}`, f, f.name); set(r.id); });
  if (CHOICE_TYPES.includes(qn.type)) return <>{qn.options.map((o: any) => (
    <label key={o.id} className="check lx-option">
      <input type={qn.type === 'multiple' ? 'checkbox' : 'radio'} name={qn.id} checked={(value ?? []).includes(o.id)}
        onChange={(e) => set(qn.type === 'multiple' ? (e.target.checked ? [...(value ?? []), o.id] : (value ?? []).filter((x: string) => x !== o.id)) : [o.id])} /> {o.text}
    </label>))}</>;
  if (qn.type === 'written') return <textarea aria-label={`Answer: ${qn.prompt}`} rows={qn.length === 'long' ? 10 : 4} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  if (qn.type === 'fill_blank') return <Field label="Your answer"><input value={value ?? ''} onChange={(e) => set(e.target.value)} /></Field>;
  if (qn.type === 'matching') {
    const v: string[] = value ?? qn.pairs.map(() => '');
    return <div className="lx-match">{qn.pairs.map((p: any, i: number) => (
      <label key={p.id}><span>{p.left}</span>
        <select value={v[i] ?? ''} onChange={(e) => set(v.map((x, j) => (j === i ? e.target.value : x)))}>
          <option value="">Choose…</option>{qn.rights.map((r: any) => <option key={r.id} value={r.id}>{r.text}</option>)}
        </select></label>))}</div>;
  }
  if (qn.type === 'ordering') {
    const ids: string[] = value?.length ? value : qn.items.map((x: any) => x.id);
    const text = (id: string) => qn.items.find((x: any) => x.id === id)?.text;
    return <ol className="lx-order">{ids.map((id, i) => (
      <li key={id}><span>{text(id)}</span>
        <Button variant="secondary" disabled={i === 0} aria-label={`Move "${text(id)}" up`} onClick={() => set(move(ids, i, -1))}>↑</Button>
        <Button variant="secondary" disabled={i === ids.length - 1} aria-label={`Move "${text(id)}" down`} onClick={() => set(move(ids, i, 1))}>↓</Button></li>))}</ol>;
  }
  if (qn.type === 'file') return <>
    <FilePicker label="Upload your evidence (PDF or photo)" accept="application/pdf,image/jpeg,image/png,image/webp" instant busy={evidence.busy} error={evidence.error?.message}
      buttonText={value ? 'Replace file' : undefined} onChange={(fs) => fs[0] && evidence.run(fs[0])} />
    {value && <p className="small">File uploaded. A trainer will mark it.</p>}
    <p className="muted small">Remove names and anything that could identify a resident before you upload.</p></>;
  return <p className="notice">Your manager or a trainer assesses this by watching your practice. Nothing to answer here.</p>; // observation
}

export function Quiz({ course, onDone }: { course: any; onDone: () => void }) {
  const [at, setAt] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [step, setStep] = useState(0);   // question index; questions.length = review screen
  const [result, setResult] = useState<any>(null);
  const [now, setNow] = useState(serverNow());
  const start = useSubmit(async () => { const a = await post(`/courses/${course.id}/attempts`); setAt(a); setAnswers(a.answers ?? {}); });
  const submit = useSubmit(async () => { setResult(await post(`/attempts/${at.id}/submit`, { answers })); window.scrollTo(0, 0); });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { start.run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!at?.deadline) return; const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, [at]);
  useEffect(() => { head.current?.focus(); }, [step]);
  const set = (qid: string, v: any) => {
    const next = { ...answers, [qid]: v };
    setAnswers(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { api('PUT', `/attempts/${at.id}/answers`, { answers: next }).catch(() => {}); }, 800); // autosave; submit sends everything anyway
  };
  if (start.error) return <><PageHead title={`${course.title}: assessment`} /><ErrorSummary error={start.error} /><Link className="btn" to="/training">Back to Training & coaching</Link></>;
  if (!at) return <Skeleton lines={6} />;
  const qs: any[] = at.questions;
  if (result) return <QuizResult course={course} result={result} questions={qs} onDone={onDone} />;
  const remaining = at.deadline ? Date.parse(at.deadline) - now : null;
  const done = qs.filter((qn) => answered(qn, answers[qn.id])).length;
  const qn = qs[step];
  return (
    <>
      <PageHead title={`${course.title}: assessment`} intro={`Pass mark ${course.pass_mark}%. Your answers are saved as you go.`} />
      {remaining !== null && <div className={`notice ${remaining < 120000 ? 'warn' : ''}`} role="timer" aria-live={remaining < 120000 ? 'polite' : 'off'}>Time left: <strong>{remaining > 0 ? fmtElapsed(remaining) : 'none — submit now'}</strong></div>}
      <div className="lx-quiz">
        <div className="lx-progress" role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={qs.length} aria-valuenow={done}><span style={{ width: `${(done / qs.length) * 100}%` }} /></div>
        <p className="muted small">{done} of {qs.length} answered</p>
        {qn ? (
          <section className="card lx-qcard" aria-labelledby="q-title">
            <p className="muted small">Question {step + 1} of {qs.length} · {qn.marks} mark{qn.marks > 1 ? 's' : ''}{qn.type === 'multiple' ? ' · choose all that apply' : ''}</p>
            {qn.scenario && <div className="lx-scenario"><strong>Scenario</strong><Paragraphs text={qn.scenario} /></div>}
            <h2 id="q-title" ref={head} tabIndex={-1}>{qn.prompt}</h2>
            {qn.image_file_id && <FileImage id={qn.image_file_id} alt={qn.image_alt} />}
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="sr-only">{qn.prompt}</legend>
              <Answer key={qn.id} qn={qn} value={answers[qn.id]} set={(v) => set(qn.id, v)} attemptId={at.id} />
            </fieldset>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
              <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>Previous</Button>
              <Button onClick={() => setStep(step + 1)}>{step === qs.length - 1 ? 'Review answers' : 'Next'}</Button>
            </div>
          </section>
        ) : (
          <section className="card lx-qcard">
            <h2 ref={head} tabIndex={-1}>Check your answers</h2>
            <ErrorSummary error={submit.error} />
            <ol className="lx-review">{qs.map((x, i) => (
              <li key={x.id}><button type="button" className="linkish" onClick={() => setStep(i)}>{x.prompt}</button>
                {answered(x, answers[x.id]) ? <Status s="verified" text="Answered" /> : <Status s="action" text="Not answered" />}</li>))}</ol>
            {done < qs.length && <p className="notice warn">{qs.length - done} question{qs.length - done > 1 ? 's are' : ' is'} not answered. Unanswered questions score nothing.</p>}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <Button variant="secondary" onClick={() => setStep(qs.length - 1)}>Back</Button>
              <Button variant="go" busy={submit.busy} busyText="Submitting…" onClick={() => submit.run()}>Submit assessment</Button>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

export function QuizResult({ course, result, questions, onDone, inDialog }: { course: any; result: any; questions: any[]; onDone: () => void; inDialog?: boolean }) {
  const prompt = (id: string) => questions.find((q) => q.id === id)?.prompt;
  const items: any[] = result.review?.items ?? [];
  const pct = result.max ? Math.round((result.score / result.max) * 100) : 0;
  return (
    <div className={inDialog ? 'lx-result' : 'card lx-result'} style={{ maxWidth: 760, margin: '0 auto' }}>
      {!inDialog && <h1 id="page-title" tabIndex={-1}>Assessment submitted</h1>}
      {result.late && <div className="notice warn">The time limit had passed, so the answers saved before then were marked.</div>}
      {result.status === 'awaiting_marking' ? <p>Some answers are marked by a trainer (written answers, evidence or observed practice). You will get a notification with your result.</p> : <>
        <div className={`lx-score ${result.passed ? 'pass' : 'fail'}`}><strong>{pct}%</strong><span>{result.score} of {result.max} marks · pass mark {course.pass_mark}%</span></div>
        {result.status === 'awaiting_approval' ? <p className="notice">You reached the pass mark. The course counts as complete once a manager approves it.</p>
          : result.passed ? <p><strong>You passed.</strong></p> : <p>You did not reach the pass mark this time. You can try again if attempts remain.</p>}
      </>}
      {items.length > 0 && <>
        {items.some((x) => x.right) && <><h2>Strengths</h2><ul>{items.filter((x) => x.right).map((x) => <li key={x.id}>{prompt(x.id)}</li>)}</ul></>}
        {items.some((x) => !x.right) && <><h2>To improve</h2><ul className="lx-feedback">{items.filter((x) => !x.right).map((x) => (
          <li key={x.id}><strong>{prompt(x.id)}</strong> <span className="muted small">({x.marks} of {x.of})</span>
            {x.answer && <p className="small">Right answer: {x.answer}</p>}
            {x.explanation && <p className="small">{x.explanation}</p>}
            {x.comment && <p className="small">Trainer: {x.comment}</p>}</li>))}</ul></>}
        {result.review.revisit?.length > 0 && <><h2>Lessons to revisit</h2><ul>{result.review.revisit.map((l: string) => <li key={l}>{l}</li>)}</ul></>}
      </>}
      {!inDialog && <Button onClick={onDone}>Continue</Button>}
    </div>
  );
}

// ── Course editor: lessons and quiz builder, preview, publish, new version ──
const blankLesson = () => ({ title: 'New lesson', body: '' });
const rid = () => Math.random().toString(36).slice(2, 8);
const blankQuestion = (type = 'single') => ({ id: rid(), type, prompt: '', marks: 1,
  options: !CHOICE_TYPES.includes(type) ? [] : type === 'true_false' ? [{ id: 't', text: 'True', correct: true }, { id: 'f', text: 'False', correct: false }] : [{ id: 'a', text: '', correct: true }, { id: 'b', text: '', correct: false }],
  ...(type === 'matching' ? { pairs: [{ id: rid(), left: '', right: '' }, { id: rid(), left: '', right: '' }] } : type === 'ordering' ? { items: [{ id: rid(), text: '' }, { id: rid(), text: '' }] } : type === 'fill_blank' ? { accepted: [''] } : {}) });
const QUESTION_KINDS: [string, string][] = [['single', 'Single choice'], ['multiple', 'Multiple choice'], ['true_false', 'True/false'], ['matching', 'Matching'], ['ordering', 'Ordering'], ['fill_blank', 'Fill in the blank'], ['written', 'Written'], ['file', 'File evidence'], ['observation', 'Observed practice']];
const MANUAL_NOTE: Record<string, string> = { written: 'A trainer marks written answers. The result waits until they do.', file: 'The learner uploads a document or photo; a trainer marks it.', observation: 'A manager or trainer marks this after watching the learner in practice.' };
function move<T>(list: T[], i: number, by: number) { const out = [...list]; const j = i + by; if (j < 0 || j >= out.length) return out; [out[i], out[j]] = [out[j], out[i]]; return out; }

function AddQuestion({ onAdd }: { onAdd: (type: string) => void }) {
  const [t, setT] = useState('single');
  return <div className="row"><select aria-label="Question type" value={t} onChange={(e) => setT(e.target.value)} style={{ width: 'auto' }}>{QUESTION_KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
    <Button variant="secondary" onClick={() => onAdd(t)}>Add question</Button></div>;
}
function ListEditor({ title, rows, cols, onChange, blank, edit, error }: { title: string; rows: any[]; cols: [string, string][]; onChange: (v: any[]) => void; blank: () => any; edit: boolean; error?: string }) {
  return (
    <fieldset style={{ border: 0, padding: 0 }}>
      <legend style={{ fontWeight: 600 }}>{title}</legend>
      {error && <span className="err">Error: {error}</span>}
      {rows.map((r, k) => (
        <div key={r.id} className="row" style={{ marginBottom: 8 }}>
          {cols.map(([key, name]) => <input key={key} aria-label={`${name} ${k + 1}`} value={r[key]} onChange={(e) => onChange(rows.map((x, j) => (j === k ? { ...x, [key]: e.target.value } : x)))} style={{ flex: 1 }} />)}
          {edit && <><Button variant="ghost" disabled={k === 0} aria-label={`Move ${k + 1} up`} onClick={() => onChange(move(rows, k, -1))}>↑</Button>
            <Button variant="ghost" aria-label={`Remove ${k + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== k))}>Remove</Button></>}
        </div>))}
      {edit && rows.length < 10 && <Button variant="ghost" onClick={() => onChange([...rows, blank()])}>Add</Button>}
    </fieldset>
  );
}

export function CourseEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const d = useApi<any>(`/courses/${id}`);
  const [c, setC] = useState<any>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (d.data) setC(d.data.course); }, [d.data]);
  const save = useSubmit(async () => {
    await patch(`/courses/${id}`, { title: c.title, summary: c.summary || null, lessons: c.lessons, questions: c.questions.map((x: any) => (x.accepted ? { ...x, accepted: x.accepted.map((t: string) => t.trim()).filter(Boolean) } : x)), draw_count: c.draw_count || null, pass_mark: c.pass_mark || null, attempt_limit: c.attempt_limit || null, time_limit_minutes: c.time_limit_minutes || null,
      category: c.category || null, difficulty: c.difficulty || null, duration_minutes: c.duration_minutes || null, audience: c.audience || null, roles: c.roles ?? [],
      objectives: (c.objectives ?? []).filter(Boolean), source_refs: c.source_refs ?? [], certificate_eligible: c.certificate_eligible ?? true, content_owner: c.content_owner || null, review_on: c.review_on || null,
      shuffle_questions: !!c.shuffle_questions, shuffle_options: !!c.shuffle_options, show_feedback: c.show_feedback ?? 'result', approval_required: !!c.approval_required });
    toast('Draft saved.'); d.reload();
  });
  const publish = useSubmit(async () => { await save.run(); await post(`/courses/${id}/publish`); toast('Published. Earlier attempts stay linked to the version they used.'); d.reload(); });
  const approve = useSubmit(async () => { const note = window.prompt('Who reviewed the content, and what did they check?'); if (!note) return; await post(`/courses/${id}/approve-content`, { note }); toast('Content approved. You can publish it now.'); d.reload(); });
  const roles = useApi<any[]>('/job-roles');
  const newVersion = useSubmit(async () => { const r = await post(`/courses/${id}/new-version`); nav(`/training/courses/${r.id}/edit`); });
  const img = useSubmit(async (kind: 'lessons' | 'questions', idx: number, file: File) => {
    const r = await upload(`/courses/${id}/images`, file, file.name);
    setC((x: any) => ({ ...x, [kind]: x[kind].map((it: any, j: number) => (j === idx ? { ...it, image_file_id: r.id, image_alt: it.image_alt ?? '' } : it)) }));
  });
  if (d.error) return <LoadError error={d.error} />;
  if (!c) return <Skeleton lines={10} />;
  const edit = d.data.can.edit;
  const setL = (i: number, k: string, v: any) => setC({ ...c, lessons: c.lessons.map((l: any, j: number) => (j === i ? { ...l, [k]: v } : l)) });
  const setQ = (i: number, k: string, v: any) => setC({ ...c, questions: c.questions.map((q: any, j: number) => (j === i ? { ...q, [k]: v } : q)) });
  const err = save.error ?? publish.error;
  return (
    <>
      <PageHead title={`${edit ? 'Edit' : 'Manage'}: ${c.title}`} crumbs={[['Training centre', '/training?tab=courses'], [c.title]]}
        intro={<>Version {c.version} · {label(c.status)}{c.company_id ? '' : ' · shared learning'}</>}
        actions={<>
          {edit && <><Button variant="secondary" onClick={() => setPreview(true)}>Preview</Button><Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button><Button variant="go" busy={publish.busy} onClick={() => publish.run()}>Publish</Button></>}
          {!edit && <><Link className="btn secondary" to={`/training/courses/${id}`}>Open as learner</Link>{d.data.can.manage && <Button busy={newVersion.busy} onClick={() => newVersion.run()}>Create a new version</Button>}</>}
        </>} />
      {c.review_status === 'pending_review' && <div className="notice warn row between"><span>This content is waiting for a specialist review. It cannot be published until someone who manages training approves it.</span>{d.data.can.manage && <Button variant="secondary" busy={approve.busy} onClick={() => approve.run()}>Approve content</Button>}</div>}
      {!edit && <div className="notice">Published versions cannot change, so results stay tied to what people actually saw. Create a new version to make changes.</div>}
      <ErrorSummary error={err ?? img.error} />
      <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0 }}>
        <section className="card" aria-labelledby="set-h">
          <h2 id="set-h">Course settings</h2>
          <Field label="Title" error={err?.fields.title}><input name="title" value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} /></Field>
          <Field label="Summary" optional><textarea name="summary" value={c.summary ?? ''} onChange={(e) => setC({ ...c, summary: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label="Category" optional><select name="category" value={c.category ?? ''} onChange={(e) => setC({ ...c, category: e.target.value || null })}><option value="">Choose…</option>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
            <Field label="Level" optional><select name="difficulty" value={c.difficulty ?? ''} onChange={(e) => setC({ ...c, difficulty: e.target.value || null })}><option value="">Choose…</option><option value="foundation">Foundation</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></Field>
            <Field label="Estimated time (minutes)" optional><input name="duration_minutes" type="number" min={1} max={1200} value={c.duration_minutes ?? ''} onChange={(e) => setC({ ...c, duration_minutes: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Content owner" optional><input name="content_owner" value={c.content_owner ?? ''} onChange={(e) => setC({ ...c, content_owner: e.target.value })} /></Field>
            <Field label="Next review" optional><input name="review_on" type="date" value={c.review_on ?? ''} onChange={(e) => setC({ ...c, review_on: e.target.value || null })} /></Field>
          </div>
          <Field label="Who it is for" optional><textarea name="audience" rows={2} value={c.audience ?? ''} onChange={(e) => setC({ ...c, audience: e.target.value })} /></Field>
          <Field label="Learning objectives" optional hint="One per line."><textarea name="objectives" rows={4} value={(c.objectives ?? []).join('\n')} onChange={(e) => setC({ ...c, objectives: e.target.value.split('\n') })} /></Field>
          <Field label="Sources and guidance" optional hint="One per line: title | https link (the link is optional)." error={err?.fields.source_refs}><textarea name="source_refs" rows={3} value={(c.source_refs ?? []).map((r: any) => r.url ? `${r.label} | ${r.url}` : r.label).join('\n')}
            onChange={(e) => setC({ ...c, source_refs: e.target.value.split('\n').filter((l) => l.trim()).map((l) => { const [lab, url] = l.split('|').map((x) => x.trim()); return { label: lab, url: url || null }; }) })} /></Field>
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Suits these roles (used for recommendations)</legend>
            <div className="row" style={{ flexWrap: 'wrap' }}>{(roles.data ?? []).map((r) => <label key={r.key} className="check"><input type="checkbox" checked={(c.roles ?? []).includes(r.key)} onChange={(e) => setC({ ...c, roles: e.target.checked ? [...(c.roles ?? []), r.key] : (c.roles ?? []).filter((x: string) => x !== r.key) })} /> {r.label}</label>)}</div></fieldset>
          <label className="check"><input type="checkbox" checked={c.certificate_eligible ?? true} onChange={(e) => setC({ ...c, certificate_eligible: e.target.checked })} /> Certificate on completion</label>
          <div className="form-grid">
            <Field label="Pass mark (%)" optional error={err?.fields.pass_mark}><input name="pass_mark" type="number" min={1} max={100} value={c.pass_mark ?? ''} onChange={(e) => setC({ ...c, pass_mark: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Attempt limit" optional><input name="attempt_limit" type="number" min={1} max={20} value={c.attempt_limit ?? ''} onChange={(e) => setC({ ...c, attempt_limit: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Time limit (minutes)" optional hint="Leave blank for no timer."><input name="time_limit_minutes" type="number" min={1} max={240} value={c.time_limit_minutes ?? ''} onChange={(e) => setC({ ...c, time_limit_minutes: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Questions drawn per attempt" optional hint="Use the questions as a bank: each attempt gets this many at random." error={err?.fields.draw_count}><input name="draw_count" type="number" min={1} value={c.draw_count ?? ''} onChange={(e) => setC({ ...c, draw_count: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="After submitting, learners see"><select name="show_feedback" value={c.show_feedback ?? 'result'} onChange={(e) => setC({ ...c, show_feedback: e.target.value })}>
              <option value="none">Their score only</option><option value="result">Score, what was wrong, explanations and lessons to revisit</option><option value="answers">All of that plus the right answers</option></select></Field>
          </div>
          <label className="check"><input type="checkbox" checked={!!c.shuffle_questions} onChange={(e) => setC({ ...c, shuffle_questions: e.target.checked })} /> Shuffle question order for each attempt</label>
          <label className="check"><input type="checkbox" checked={!!c.shuffle_options} onChange={(e) => setC({ ...c, shuffle_options: e.target.checked })} /> Shuffle answer options</label>
          <label className="check"><input type="checkbox" checked={!!c.approval_required} onChange={(e) => setC({ ...c, approval_required: e.target.checked })} /> A manager must approve a pass before the course counts as complete</label>
        </section>

        <section className="card" aria-labelledby="les-h">
          <div className="row between"><h2 id="les-h">Lessons ({c.lessons.length})</h2>{edit && <Button variant="secondary" onClick={() => setC({ ...c, lessons: [...c.lessons, blankLesson()] })}>Add lesson</Button>}</div>
          {c.lessons.map((l: any, i: number) => (
            <details key={i} className="card" open={c.lessons.length < 3}>
              <summary><strong>{i + 1}. {l.title}</strong></summary>
              <div className="form-grid">
                <Field label="Lesson title" error={err?.fields[`lessons.${i}.title`]}><input name={`lesson-${i}-title`} value={l.title} onChange={(e) => setL(i, 'title', e.target.value)} /></Field>
                <Field label="Module" optional hint="Lessons with the same module name are grouped."><input name={`lesson-${i}-module`} value={l.module ?? ''} onChange={(e) => setL(i, 'module', e.target.value || null)} /></Field>
              </div>
              <Field label="Text" hint="Leave a blank line between paragraphs. Start a line with ## for a heading, or - for a list."><textarea name={`lesson-${i}-body`} rows={6} value={l.body ?? ''} onChange={(e) => setL(i, 'body', e.target.value)} /></Field>
              <FilePicker label="Image" accept="image/jpeg,image/png,image/webp" instant compact busy={img.busy} buttonText={l.image_file_id ? 'Replace image' : undefined} onChange={(fs) => img.run('lessons', i, fs[0])} />
              {l.image_file_id && <><FileImage id={l.image_file_id} alt={l.image_alt || 'Lesson image'} /><Field label="Describe the image (alternative text)" error={err?.fields[`lessons.${i}.image_alt`]}><input name={`lesson-${i}-alt`} value={l.image_alt ?? ''} onChange={(e) => setL(i, 'image_alt', e.target.value)} /></Field></>}
              <Field label="Video link" optional hint="https link. A transcript or captions text is required."><input name={`lesson-${i}-video`} value={l.video_url ?? ''} onChange={(e) => setL(i, 'video_url', e.target.value || null)} /></Field>
              {l.video_url && <Field label="Transcript" error={err?.fields[`lessons.${i}.transcript`]}><textarea name={`lesson-${i}-transcript`} value={l.transcript ?? ''} onChange={(e) => setL(i, 'transcript', e.target.value)} /></Field>}
              <Field label="Scenario to think about" optional><textarea name={`lesson-${i}-scenario`} value={l.scenario ?? ''} onChange={(e) => setL(i, 'scenario', e.target.value || null)} /></Field>
              <Field label="Key points" optional hint="One per line."><textarea name={`lesson-${i}-points`} rows={3} value={(l.key_points ?? []).join('\n')} onChange={(e) => setL(i, 'key_points', e.target.value ? e.target.value.split('\n') : undefined)} /></Field>
              {l.checks?.length > 0 && <p className="small muted">{l.checks.length} practice question{l.checks.length === 1 ? '' : 's'} in this lesson.</p>}
              {edit && <div className="row">
                <Button variant="ghost" disabled={i === 0} onClick={() => setC({ ...c, lessons: move(c.lessons, i, -1) })}>Move up</Button>
                <Button variant="ghost" disabled={i === c.lessons.length - 1} onClick={() => setC({ ...c, lessons: move(c.lessons, i, 1) })}>Move down</Button>
                <Button variant="ghost" onClick={() => setC({ ...c, lessons: [...c.lessons.slice(0, i + 1), { ...l, title: `${l.title} (copy)` }, ...c.lessons.slice(i + 1)] })}>Duplicate</Button>
                <Button variant="ghost" onClick={() => setC({ ...c, lessons: c.lessons.filter((_: any, j: number) => j !== i) })}>Remove</Button>
              </div>}
            </details>
          ))}
        </section>

        <section className="card" aria-labelledby="q-h">
          <div className="row between"><h2 id="q-h">Quiz questions ({c.questions.length})</h2>
            {edit && <AddQuestion onAdd={(t) => setC({ ...c, questions: [...c.questions, blankQuestion(t)] })} />}</div>
          {c.questions.length === 0 && <p className="muted">No quiz. Learners complete the course by confirming they have read it after the last lesson.</p>}
          {c.questions.map((qn: any, i: number) => (
            <details key={qn.id} className="card" open>
              <summary><strong>Question {i + 1}</strong> — {label(qn.type)} · {qn.marks} mark{qn.marks > 1 ? 's' : ''}</summary>
              <Field label="Question" error={err?.fields[`questions.${i}.prompt`]}><textarea name={`q-${i}-prompt`} value={qn.prompt} onChange={(e) => setQ(i, 'prompt', e.target.value)} /></Field>
              <Field label="Marks"><input name={`q-${i}-marks`} type="number" min={1} max={20} value={qn.marks} onChange={(e) => setQ(i, 'marks', Number(e.target.value))} style={{ maxWidth: 120 }} /></Field>
              <FilePicker label="Image" accept="image/jpeg,image/png,image/webp" instant compact busy={img.busy} buttonText={qn.image_file_id ? 'Replace image' : undefined} onChange={(fs) => img.run('questions', i, fs[0])} />
              {qn.image_file_id && <Field label="Describe the image (alternative text)" error={err?.fields[`questions.${i}.image_alt`]}><input name={`q-${i}-alt`} value={qn.image_alt ?? ''} onChange={(e) => setQ(i, 'image_alt', e.target.value)} /></Field>}
              <Field label="Scenario" optional hint="A workplace situation shown above the question."><textarea name={`q-${i}-scenario`} rows={2} value={qn.scenario ?? ''} onChange={(e) => setQ(i, 'scenario', e.target.value || null)} /></Field>
              {CHOICE_TYPES.includes(qn.type) && (
                <fieldset style={{ border: 0, padding: 0 }} aria-describedby={err?.fields[`questions.${i}.options`] ? `q-${i}-opt-err` : undefined}>
                  <legend style={{ fontWeight: 600 }}>Answers (tick the correct {qn.type === 'multiple' ? 'ones' : 'one'})</legend>
                  {err?.fields[`questions.${i}.options`] && <span className="err" id={`q-${i}-opt-err`}>Error: {err.fields[`questions.${i}.options`]}</span>}
                  {qn.options.map((o: any, k: number) => (
                    <div key={o.id} className="row" style={{ marginBottom: 8 }}>
                      <input type="checkbox" aria-label={`Answer ${k + 1} is correct`} checked={o.correct} onChange={(e) => setQ(i, 'options', qn.options.map((x: any, j: number) => (j === k ? { ...x, correct: e.target.checked } : qn.type !== 'multiple' && e.target.checked ? { ...x, correct: false } : x)))} />
                      <input aria-label={`Answer ${k + 1}`} value={o.text} disabled={qn.type === 'true_false' || !edit} onChange={(e) => setQ(i, 'options', qn.options.map((x: any, j: number) => (j === k ? { ...x, text: e.target.value } : x)))} style={{ flex: 1 }} />
                      {qn.type !== 'true_false' && edit && <Button variant="ghost" onClick={() => setQ(i, 'options', qn.options.filter((_: any, j: number) => j !== k))} aria-label={`Remove answer ${k + 1}`}>Remove</Button>}
                    </div>
                  ))}
                  {qn.type !== 'true_false' && edit && <Button variant="ghost" onClick={() => setQ(i, 'options', [...qn.options, { id: Math.random().toString(36).slice(2, 6), text: '', correct: false }])}>Add an answer</Button>}
                </fieldset>
              )}
              {qn.type === 'matching' && <ListEditor title="Pairs (left matches right)" error={err?.fields[`questions.${i}.pairs`]} rows={qn.pairs ?? []} edit={edit}
                cols={[['left', 'Left'], ['right', 'Matches']]} onChange={(v) => setQ(i, 'pairs', v)} blank={() => ({ id: rid(), left: '', right: '' })} />}
              {qn.type === 'ordering' && <ListEditor title="Steps, in the right order (learners see them shuffled)" error={err?.fields[`questions.${i}.items`]} rows={qn.items ?? []} edit={edit}
                cols={[['text', 'Step']]} onChange={(v) => setQ(i, 'items', v)} blank={() => ({ id: rid(), text: '' })} />}
              {qn.type === 'fill_blank' && <Field label="Accepted answers" hint="One per line. Capitals and extra spaces are ignored." error={err?.fields[`questions.${i}.accepted`]}>
                <textarea name={`q-${i}-accepted`} rows={2} value={(qn.accepted ?? []).join('\n')} onChange={(e) => setQ(i, 'accepted', e.target.value.split('\n'))} /></Field>}
              {qn.type === 'written' && <Field label="Answer length"><select name={`q-${i}-length`} value={qn.length ?? 'short'} onChange={(e) => setQ(i, 'length', e.target.value)}><option value="short">Short</option><option value="long">Long (case study or reflection)</option></select></Field>}
              {MANUAL_NOTE[qn.type] && <p className="muted small">{MANUAL_NOTE[qn.type]}</p>}
              <div className="form-grid">
                <Field label="Explanation" optional hint="Shown after submitting, when feedback is on."><textarea name={`q-${i}-explanation`} rows={2} value={qn.explanation ?? ''} onChange={(e) => setQ(i, 'explanation', e.target.value || null)} /></Field>
                <Field label="Lesson to revisit if wrong" optional><select name={`q-${i}-lesson`} value={qn.lesson_ref ?? ''} onChange={(e) => setQ(i, 'lesson_ref', e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">None</option>{c.lessons.map((l: any, k: number) => <option key={k} value={k}>{k + 1}. {l.title}</option>)}</select></Field>
              </div>
              {edit && <div className="row">
                <Button variant="ghost" disabled={i === 0} onClick={() => setC({ ...c, questions: move(c.questions, i, -1) })}>Move up</Button>
                <Button variant="ghost" disabled={i === c.questions.length - 1} onClick={() => setC({ ...c, questions: move(c.questions, i, 1) })}>Move down</Button>
                <Button variant="ghost" onClick={() => setC({ ...c, questions: [...c.questions.slice(0, i + 1), { ...qn, id: Math.random().toString(36).slice(2, 8) }, ...c.questions.slice(i + 1)] })}>Duplicate</Button>
                <Button variant="ghost" onClick={() => setC({ ...c, questions: c.questions.filter((_: any, j: number) => j !== i) })}>Remove</Button>
              </div>}
            </details>
          ))}
        </section>
      </fieldset>
      <Dialog open={preview} onClose={() => setPreview(false)} title={`Preview: ${c.title}`}>
        <p className="notice">This is how learners will see it. Nothing is saved from the preview.</p>
        {c.lessons.map((l: any, i: number) => <section key={i} style={{ marginBottom: 24 }}><h3>{i + 1}. {l.title}</h3><Paragraphs text={l.body} />{l.image_file_id && <FileImage id={l.image_file_id} alt={l.image_alt} />}{l.scenario && <div className="notice warn">{l.scenario}</div>}</section>)}
        {c.questions.length > 0 && <><h3>Quiz</h3><ol>{c.questions.map((qn: any) => <li key={qn.id}>{qn.prompt}{qn.type !== 'written' && <ul>{qn.options.map((o: any) => <li key={o.id}>{o.text}</li>)}</ul>}</li>)}</ol></>}
      </Dialog>
    </>
  );
}

// ── Manage: matrix, requirements, assignments, equivalences, marking, verification ──
function Manage() {
  const hub = useHub();
  const toast = useToast();
  const manage = hub.me.companies.filter((c) => c.perms.includes('training.manage'));
  const matrix = useApi<any[]>(`/training/matrix${hub.q()}`);
  const reqs = useApi<any[]>(`/training/requirements${hub.q()}`);
  const courses = useApi<any[]>('/courses');
  const marking = useApi<any[]>(manage.length ? `/marking${hub.q()}` : null);
  const verify = useApi<any[]>(manage.length ? `/training/verify-queue${hub.q()}` : null);
  const [dlg, setDlg] = useState<null | 'req' | 'assign' | 'equiv' | 'cert'>(null);
  const [f, setF] = useState<any>({});
  const [mark, setMark] = useState<any>(null);
  const people = useApi<any[]>((dlg === 'assign' || dlg === 'cert') && f.company_id ? `/people?company=${f.company_id}` : null);
  const published = (courses.data ?? []).filter((c) => c.status === 'published' && (!f.company_id || !c.company_id || c.company_id === f.company_id));
  const done = (msg: string) => { setDlg(null); toast(msg); matrix.reload(); reqs.reload(); };
  const addReq = useSubmit(async () => { await post('/training/requirements', { company_id: f.company_id, course_root_id: f.course_root_id, job_title: f.job_title || null, due_within_days: Number(f.due_within_days), refresher_months: f.refresher_months ? Number(f.refresher_months) : null }); done('Requirement added.'); });
  const retire = useSubmit(async (rid: string) => { await post(`/training/requirements/${rid}/retire`); done('Requirement removed. Past records are kept.'); });
  const assign = useSubmit(async () => { await post('/training/assignments', f); done('Training assigned.'); });
  const equiv = useSubmit(async () => { await post('/training/equivalences', f); done('Equivalent course accepted.'); });
  const nav = useNavigate();
  const award = useSubmit(async () => { const r = await post('/training/certificates', f); done('Certificate given.'); nav(`/training/certificates/${r.id}`); });
  const openMark = useSubmit(async (m: any) => { setMark({ ...(await api('GET', `/attempts/${m.id}`)), person_name: m.person_name, marks: {} }); });
  const saveMark = useSubmit(async () => {
    if (mark.status === 'awaiting_approval') {
      if (!mark.note?.trim()) throw new ApiError(400, 'validation', 'Say what you checked before approving or declining.');
      await post(`/attempts/${mark.id}/approve`, { approve: mark.approve, note: mark.note }); toast(mark.approve ? 'Approved: the course is complete.' : 'Not approved. The learner has been told.');
    } else { const r = await post(`/attempts/${mark.id}/mark`, { marks: mark.marks, feedback: mark.feedback ?? {} }); toast(r.status === 'awaiting_approval' ? 'Marked: passed, waiting for approval.' : r.passed ? 'Marked: passed.' : 'Marked: not passed.'); }
    setMark(null); marking.reload(); matrix.reload();
  });
  const decide = useSubmit(async (rid: string, approve: boolean) => { await post(`/training/records/${rid}/verify`, { approve }); toast(approve ? 'Certificate verified.' : 'Certificate rejected.'); verify.reload(); matrix.reload(); });
  const rows = matrix.data ?? [];
  const coursesIn = [...new Map(rows.map((r) => [r.course_root_id, r.course_title])).entries()];
  const peopleIn = [...new Map(rows.map((r) => [`${r.person_id}${r.company_id}`, r])).values()];
  return (
    <div className="stack">
      <ErrorSummary error={retire.error ?? decide.error ?? openMark.error} />
      {(marking.data ?? []).length + (verify.data ?? []).length > 0 && (
        <section className="card" aria-labelledby="todo-h">
          <h2 id="todo-h">Waiting for you</h2>
          <ul className="list">
            {marking.data?.map((m) => <li key={m.id}><span>{m.status === 'awaiting_approval' ? 'Pass to approve' : 'Answers to mark'} from <strong>{m.person_name}</strong> — {m.title}<br /><span className="muted small">Submitted {fmtDate(m.submitted_at)}{m.status === 'awaiting_approval' ? ` · scored ${m.score} of ${m.max_score}` : ''}</span></span><Button variant="secondary" busy={openMark.busy} onClick={() => openMark.run(m)}>{m.status === 'awaiting_approval' ? 'Review' : 'Mark'}</Button></li>)}
            {verify.data?.map((r) => <li key={r.id}><span>Certificate from <strong>{r.person_name}</strong> — {r.title}<br /><span className="muted small">{r.provider ?? 'Provider not given'} · completed {fmtDate(r.completed_on)}</span></span>
              <span className="row">{r.certificate_file_id ? <Button variant="ghost" onClick={() => download(`/files/${r.certificate_file_id}`, `${r.title}.pdf`)}>View certificate</Button> : <span className="small muted">No file</span>}<Button variant="go" disabled={decide.busy} onClick={() => decide.run(r.id, true)}>Verify</Button><Button variant="secondary" disabled={decide.busy} onClick={() => decide.run(r.id, false)}>Reject</Button></span></li>)}
          </ul>
        </section>
      )}
      <section className="card" aria-labelledby="mx-h">
        <h2 id="mx-h">Training matrix</h2>
        {matrix.loading && !matrix.data ? <Skeleton /> : rows.length === 0 ? <Empty>No requirements yet.</Empty> : (
          <div className="table-wrap"><table>
            <caption className="sr-only">Training status by person and course</caption>
            <thead><tr><th>Person</th>{coursesIn.map(([rid, t]) => <th key={rid}>{t ?? 'Unpublished course'}</th>)}</tr></thead>
            <tbody>{peopleIn.map((p) => <tr key={`${p.person_id}${p.company_id}`}><td>{p.person_name} <CompanyBadge code={p.company_code} name={p.company_name} /></td>
              {coursesIn.map(([rid]) => { const m = rows.find((r) => r.person_id === p.person_id && r.company_id === p.company_id && r.course_root_id === rid); if (!m) return <td key={rid}><span className="muted">Not required</span></td>; const [s, t] = MATRIX_STATUS[m.status]; return <td key={rid}><Status s={s} text={t} /><div className="small muted">{m.completed_on ? fmtDate(m.completed_on) : `due ${fmtDate(m.due_on)}`}</div></td>; })}</tr>)}</tbody>
          </table></div>
        )}
      </section>
      {manage.length > 0 && (
        <section className="card" aria-labelledby="rq-h">
          <div className="row between"><h2 id="rq-h">Requirements</h2><div className="row">
            <Button variant="secondary" onClick={() => { setF({ company_id: manage[0].id, course_root_id: '', job_title: '', due_within_days: 28, refresher_months: 12 }); setDlg('req'); }}>Add requirement</Button>
            <Button variant="secondary" onClick={() => { setF({ company_id: manage[0].id, person_id: '', course_root_id: '', due_on: londonToday() }); setDlg('assign'); }}>Assign to a person</Button>
            <Button variant="secondary" onClick={() => { setF({ company_id: manage[0].id, person_id: '', course_root_id: '', completed_on: londonToday() }); setDlg('cert'); }}>Give a certificate</Button>
            <Button variant="ghost" onClick={() => { setF({ company_id: manage[0].id, course_root_id: '', equivalent_root_id: '' }); setDlg('equiv'); }}>Accept an equivalent course</Button></div></div>
          {(reqs.data ?? []).length === 0 ? <Empty>No requirements.</Empty> : <ul className="list">{reqs.data!.map((r) => <li key={r.id}><span><strong>{r.course_title}</strong> <CompanyBadge code={r.company_code} /><br /><span className="muted small">{r.job_title ? `Job title: ${r.job_title}` : 'Everyone'} · within {r.due_within_days} days of starting{r.refresher_months && ` · refresh every ${r.refresher_months} months`}</span></span>
            {hub.can('training.manage', r.company_id) && <Button variant="ghost" busy={retire.busy} onClick={() => retire.run(r.id)}>Remove</Button>}</li>)}</ul>}
        </section>
      )}
      <Dialog open={dlg === 'req'} onClose={() => setDlg(null)} title="Add a training requirement" footer={<Button busy={addReq.busy} onClick={() => addReq.run()}>Add</Button>}>
        <p className="small muted">Requiring a shared course, or one from another company, counts as this company accepting it.</p>
        <ErrorSummary error={addReq.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{manage.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Course"><select name="course_root_id" value={f.course_root_id} onChange={(e) => setF({ ...f, course_root_id: e.target.value })}><option value="">Choose…</option>{published.map((c) => <option key={c.root_id} value={c.root_id}>{c.title}</option>)}</select></Field>
        <Field label="Only for this job title" optional hint="Leave blank for everyone in the company."><input name="job_title" value={f.job_title ?? ''} onChange={(e) => setF({ ...f, job_title: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label="Days to complete after starting"><input name="due_within_days" type="number" min={0} max={365} value={f.due_within_days ?? ''} onChange={(e) => setF({ ...f, due_within_days: e.target.value })} /></Field>
          <Field label="Refresh every (months)" optional><input name="refresher_months" type="number" min={1} max={120} value={f.refresher_months ?? ''} onChange={(e) => setF({ ...f, refresher_months: e.target.value })} /></Field>
        </div>
      </Dialog>
      <Dialog open={dlg === 'assign'} onClose={() => setDlg(null)} title="Assign training" footer={<Button busy={assign.busy} onClick={() => assign.run()}>Assign</Button>}>
        <ErrorSummary error={assign.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, person_id: '' })}>{manage.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Person"><select name="person_id" value={f.person_id ?? ''} onChange={(e) => setF({ ...f, person_id: e.target.value })}><option value="">Choose…</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
        <Field label="Course"><select name="course_root_id" value={f.course_root_id} onChange={(e) => setF({ ...f, course_root_id: e.target.value })}><option value="">Choose…</option>{published.map((c) => <option key={c.root_id} value={c.root_id}>{c.title}</option>)}</select></Field>
        <Field label="Due" error={assign.error?.fields.due_on}><input name="due_on" type="date" value={f.due_on ?? ''} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'cert'} onClose={() => setDlg(null)} title="Give a certificate" footer={<Button busy={award.busy} onClick={() => award.run()}>Give certificate</Button>}>
        <p className="small muted">For training you delivered or watched, for example face to face. It counts as completing the course, and the person can open and print the certificate from their training record.</p>
        <ErrorSummary error={award.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, person_id: '' })}>{manage.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Person" error={award.error?.fields.person_id}><select name="person_id" value={f.person_id ?? ''} onChange={(e) => setF({ ...f, person_id: e.target.value })}><option value="">Choose…</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
        <Field label="Course" error={award.error?.fields.course_root_id}><select name="course_root_id" value={f.course_root_id} onChange={(e) => setF({ ...f, course_root_id: e.target.value })}><option value="">Choose…</option>{published.map((c) => <option key={c.root_id} value={c.root_id}>{c.title}</option>)}</select></Field>
        <Field label="Completed on" error={award.error?.fields.completed_on}><input name="completed_on" type="date" max={londonToday()} value={f.completed_on ?? ''} onChange={(e) => setF({ ...f, completed_on: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'equiv'} onClose={() => setDlg(null)} title="Accept an equivalent course" footer={<Button busy={equiv.busy} onClick={() => equiv.run()}>Accept</Button>}>
        <p className="small muted">People who completed the equivalent course will count as up to date for the required one, in this company only.</p>
        <ErrorSummary error={equiv.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{manage.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Required course"><select name="course_root_id" value={f.course_root_id} onChange={(e) => setF({ ...f, course_root_id: e.target.value })}><option value="">Choose…</option>{published.map((c) => <option key={c.root_id} value={c.root_id}>{c.title}</option>)}</select></Field>
        <Field label="Accept this course as equivalent"><select name="equivalent_root_id" value={f.equivalent_root_id} onChange={(e) => setF({ ...f, equivalent_root_id: e.target.value })}><option value="">Choose…</option>{(courses.data ?? []).filter((c) => c.status === 'published').map((c) => <option key={c.root_id} value={c.root_id}>{c.title}{c.company_code ? ` (${c.company_code})` : ' (shared)'}</option>)}</select></Field>
      </Dialog>
      <Dialog open={!!mark} onClose={() => setMark(null)} title={mark?.status === 'awaiting_approval' ? 'Approve completion' : 'Mark answers'}
        footer={<Button busy={saveMark.busy} onClick={() => saveMark.run()}>{mark?.status === 'awaiting_approval' ? 'Save decision' : 'Save marks'}</Button>}>
        {mark && <>
          <ErrorSummary error={saveMark.error} />
          {mark.status === 'awaiting_approval' ? <>
            <p>{mark.person_name ?? 'The learner'} reached the pass mark ({mark.score} of {mark.max_score}). This course needs a manager's approval before it counts as complete, for example after watching them in practice.</p>
            <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Decision</legend>
              <label className="check"><input type="radio" name="approve" checked={mark.approve !== false} onChange={() => setMark({ ...mark, approve: true })} /> Approve: the course is complete</label>
              <label className="check"><input type="radio" name="approve" checked={mark.approve === false} onChange={() => setMark({ ...mark, approve: false })} /> Do not approve yet</label></fieldset>
            <Field label="What you checked"><textarea name="note" value={mark.note ?? ''} onChange={(e) => setMark({ ...mark, note: e.target.value, approve: mark.approve ?? true })} /></Field>
          </> : <>
            {mark.questions.filter((x: any) => MANUAL_NOTE[x.type]).map((qn: any) => (
              <section key={qn.id} style={{ marginBottom: 16 }}><h3 style={{ fontSize: '1rem' }}>{qn.prompt}</h3>
                {qn.type === 'written' && <blockquote className="notice" style={{ whiteSpace: 'pre-wrap' }}>{mark.answers[qn.id] || <em>No answer given</em>}</blockquote>}
                {qn.type === 'file' && (mark.answers[qn.id] ? <Button variant="secondary" onClick={() => download(`/files/${mark.answers[qn.id]}`, 'evidence')}>Open the evidence</Button> : <p className="notice"><em>No file uploaded</em></p>)}
                {qn.type === 'observation' && <p className="muted small">Mark from what you observed in practice.</p>}
                <Field label={`Marks (0 to ${qn.marks})`}><input name={`mark-${qn.id}`} type="number" min={0} max={qn.marks} value={mark.marks[qn.id] ?? ''} onChange={(e) => setMark({ ...mark, marks: { ...mark.marks, [qn.id]: e.target.value === '' ? undefined : Number(e.target.value) } })} style={{ maxWidth: 120 }} /></Field>
                <Field label="Feedback for the learner" optional><textarea name={`fb-${qn.id}`} rows={2} value={mark.feedback?.[qn.id] ?? ''} onChange={(e) => setMark({ ...mark, feedback: { ...mark.feedback, [qn.id]: e.target.value } })} /></Field>
              </section>
            ))}
            <p className="small muted">Other questions were marked automatically: {mark.auto_marks} mark(s).</p>
          </>}
        </>}
      </Dialog>
    </div>
  );
}
