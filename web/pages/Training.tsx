import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, blobUrl, download, patch, post, serverNow, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtElapsed, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

const MATRIX_STATUS: Record<string, [string, string]> = { current: ['verified', 'Up to date'], expiring: ['submitted', 'Renew soon'], due: ['info', 'Due'], overdue: ['action', 'Overdue'] };

export function Paragraphs({ text }: { text?: string | null }) {
  return <>{(text ?? '').split(/\n{2,}/).filter(Boolean).map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}</>;
}
export function FileImage({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let u: string | null = null; blobUrl(`/files/${id}`).then((x) => { u = x; setSrc(x); }); return () => { if (u) URL.revokeObjectURL(u); }; }, [id]);
  return src ? <img src={src} alt={alt} style={{ maxHeight: 360, borderRadius: 8, margin: '8px 0' }} /> : <div className="skeleton" style={{ height: 120 }} aria-label={alt} />;
}

type Tab = 'mine' | 'courses' | 'manage';
export function Training() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const manager = hub.can('training.manage') || hub.can('training.view_all');
  const tab = (params.get('tab') as Tab) ?? 'mine';
  const tabs: [Tab, string][] = [['mine', 'My training'], ['courses', 'Courses'], ...(manager ? [['manage', 'Manage training'] as [Tab, string]] : [])];
  return (
    <>
      <PageHead title="Training centre" intro="Required training, courses and quizzes. Completing training shows learning, not competence; competence is assessed separately." />
      <Tabs label="Training sections" tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'mine' && <MyTraining />}
      {tab === 'courses' && <Catalogue />}
      {tab === 'manage' && manager && <Manage />}
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

function Catalogue() {
  const hub = useHub();
  const nav = useNavigate();
  const list = useApi<any[]>(`/courses${hub.q()}`);
  const [creating, setCreating] = useState(false);
  const canCreate = hub.me.companies.some((c) => c.perms.includes('training.manage')) || hub.me.superAdmin;
  const rows = list.data ?? [];
  const latest = rows.filter((c, i) => rows.findIndex((x) => x.root_id === c.root_id && x.status === c.status) === i);
  return (
    <>
      {canCreate && <p><Button onClick={() => setCreating(true)}>Build a course</Button></p>}
      {list.loading && !list.data ? <Skeleton /> : latest.length === 0 ? <Empty>No courses yet.</Empty> : (
        <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>{latest.map((c) => (
          <li key={c.id} className="card">
            <div className="row between"><h3 style={{ margin: 0 }}>{c.title}</h3>{c.company_code ? <CompanyBadge code={c.company_code} name={c.company_name} /> : <span className="badge co">Shared</span>}</div>
            <p className="muted small">{c.summary}</p>
            <p className="small">{c.lesson_count} lessons{c.question_count > 0 && ` · quiz (pass mark ${c.pass_mark}%${c.time_limit_minutes ? `, ${c.time_limit_minutes} min` : ''})`} · version {c.version}</p>
            <div className="row">
              {c.status === 'draft' ? <Status s="planned" text="Draft" /> : c.my_completed_on ? <Status s="verified" text={`Completed ${fmtDate(c.my_completed_on)}`} /> : null}
              {c.status === 'published' && <Link className="btn secondary" to={`/training/courses/${c.id}`}>{c.my_lesson ? 'Resume' : 'Start'}<span className="sr-only"> {c.title}</span></Link>}
              {c.can_manage && <Link className="btn ghost" to={`/training/courses/${c.id}/edit`}>{c.status === 'draft' ? 'Edit' : 'Manage'}<span className="sr-only"> {c.title}</span></Link>}
            </div>
          </li>
        ))}</ul>
      )}
      {creating && <NewCourse onClose={() => setCreating(false)} onSaved={(id) => nav(`/training/courses/${id}/edit`)} />}
    </>
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

// ── Course player: lessons with Previous / Next / Save and exit, then quiz or declaration ──
export function CoursePlayer() {
  const { id } = useParams();
  const nav = useNavigate();
  const d = useApi<any>(`/courses/${id}`);
  const [i, setI] = useState<number | null>(null);
  const [mode, setMode] = useState<'lessons' | 'quiz' | 'done'>('lessons');
  const [declared, setDeclared] = useState(false);
  const toast = useToast();
  const c = d.data?.course;
  useEffect(() => { if (d.data && i === null) setI(Math.min(d.data.progress, d.data.course.lessons.length - 1)); }, [d.data, i]);
  const go = async (n: number) => { setI(n); document.getElementById('page-title')?.focus(); try { await api('PUT', `/courses/${id}/progress`, { lesson_index: n }); } catch { /* progress is a convenience; navigation still works */ } };
  const complete = useSubmit(async () => { await post(`/courses/${id}/complete`, { declaration: declared }); toast('Course completed.'); setMode('done'); });
  if (d.error) return <LoadError error={d.error} />;
  if (!c || i === null) return <Skeleton lines={8} />;
  if (c.status !== 'published') return <><PageHead title={c.title} /><div className="notice warn">This version is not published. <Link to={`/training/courses/${id}/edit`}>Open the editor</Link></div></>;
  const lesson = c.lessons[i];
  const last = i === c.lessons.length - 1;
  if (mode === 'quiz') return <Quiz course={c} onDone={() => { setMode('done'); d.reload(); }} />;
  if (mode === 'done') return (
    <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
      <h1 id="page-title" tabIndex={-1}>{c.title}</h1><p>Your result is saved in your training record.</p><Link className="btn" to="/training">Back to the Training centre</Link>
    </div>
  );
  return (
    <>
      <PageHead title={c.title} crumbs={[['Training centre', '/training'], [c.title]]} intro={`Lesson ${i + 1} of ${c.lessons.length}`} />
      <article className="card" style={{ maxWidth: 820 }} aria-labelledby="lesson-h">
        <div className="bar" aria-hidden="true" style={{ marginBottom: 16 }}><span style={{ width: `${((i + 1) / c.lessons.length) * 100}%` }} /></div>
        <h2 id="lesson-h">{lesson.title}</h2>
        <Paragraphs text={lesson.body} />
        {lesson.image_file_id && <FileImage id={lesson.image_file_id} alt={lesson.image_alt} />}
        {lesson.video_url && <div className="notice"><a href={lesson.video_url} target="_blank" rel="noopener noreferrer">Watch the video (opens in a new tab)</a><details style={{ marginTop: 8 }}><summary>Read the transcript</summary><Paragraphs text={lesson.transcript} /></details></div>}
        {lesson.scenario && <div className="notice warn"><strong>Think about it:</strong> {lesson.scenario}</div>}
        {lesson.resources?.length > 0 && <><h3>Resources</h3><ul>{lesson.resources.map((r: any) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener noreferrer">{r.label}</a></li>)}</ul></>}
        <div className="row between" style={{ marginTop: 24 }}>
          <Button variant="secondary" disabled={i === 0} onClick={() => go(i - 1)}>‹ Previous</Button>
          <Button variant="ghost" onClick={() => nav('/training')}>Save and exit</Button>
          {!last ? <Button onClick={() => go(i + 1)}>Next ›</Button> : c.questions.length ? <Button variant="go" onClick={() => setMode('quiz')}>Start the quiz</Button> : null}
        </div>
        {last && !c.questions.length && (
          <div style={{ marginTop: 24 }}>
            <ErrorSummary error={complete.error} />
            <label className="check"><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} /> I have read and understood this course</label>
            <Button variant="go" busy={complete.busy} disabled={!declared} onClick={() => complete.run()}>Complete course</Button>
          </div>
        )}
      </article>
    </>
  );
}

function Quiz({ course, onDone }: { course: any; onDone: () => void }) {
  const [at, setAt] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any>(null);
  const [now, setNow] = useState(serverNow());
  const start = useSubmit(async () => { const a = await post(`/courses/${course.id}/attempts`); setAt(a); setAnswers(a.answers ?? {}); });
  const submit = useSubmit(async () => { setResult(await post(`/attempts/${at.id}/submit`, { answers })); });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { start.run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!at?.deadline) return; const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, [at]);
  const set = (qid: string, v: any) => {
    const next = { ...answers, [qid]: v };
    setAnswers(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { api('PUT', `/attempts/${at.id}/answers`, { answers: next }).catch(() => {}); }, 800); // autosave; submit sends everything anyway
  };
  if (start.error) return <><PageHead title={`${course.title}: quiz`} /><ErrorSummary error={start.error} /><Link className="btn" to="/training">Back to the Training centre</Link></>;
  if (!at) return <Skeleton lines={6} />;
  if (result) return (
    <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 id="page-title" tabIndex={-1}>Quiz submitted</h1>
      {result.late && <div className="notice warn">The time limit had passed, so the answers saved before then were marked.</div>}
      {result.status === 'awaiting_marking' ? <p>Your written answers will be marked by a trainer. You will get a notification with the result.</p>
        : <p>You scored {result.score} out of {result.max}. {result.passed ? <strong>You passed.</strong> : `The pass mark is ${course.pass_mark}%. You can try again if attempts remain.`}</p>}
      <Button onClick={onDone}>Continue</Button>
    </div>
  );
  const remaining = at.deadline ? Date.parse(at.deadline) - now : null;
  return (
    <>
      <PageHead title={`${course.title}: quiz`} intro={`Pass mark ${course.pass_mark}%. Your answers are saved as you go.`} />
      {remaining !== null && <div className={`notice ${remaining < 120000 ? 'warn' : ''}`} role="timer" aria-live={remaining < 120000 ? 'polite' : 'off'}>Time left: <strong>{remaining > 0 ? fmtElapsed(remaining) : 'none — submit now'}</strong></div>}
      <form className="card" style={{ maxWidth: 820 }} noValidate onSubmit={(e) => { e.preventDefault(); submit.run(); }}>
        <ErrorSummary error={submit.error} />
        <ol style={{ paddingLeft: 20 }}>{at.questions.map((qn: any) => (
          <li key={qn.id} style={{ marginBottom: 24 }}>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontWeight: 600 }}>{qn.prompt} <span className="muted small">({qn.marks} mark{qn.marks > 1 ? 's' : ''}{qn.type === 'multiple' ? ', choose all that apply' : ''})</span></legend>
              {qn.image_file_id && <FileImage id={qn.image_file_id} alt={qn.image_alt} />}
              {qn.type === 'written' ? <textarea aria-label={`Answer: ${qn.prompt}`} value={answers[qn.id] ?? ''} onChange={(e) => set(qn.id, e.target.value)} /> :
                qn.options.map((o: any) => (
                  <label key={o.id} className="check">
                    <input type={qn.type === 'multiple' ? 'checkbox' : 'radio'} name={qn.id} checked={(answers[qn.id] ?? []).includes(o.id)}
                      onChange={(e) => set(qn.id, qn.type === 'multiple' ? (e.target.checked ? [...(answers[qn.id] ?? []), o.id] : (answers[qn.id] ?? []).filter((x: string) => x !== o.id)) : [o.id])} /> {o.text}
                  </label>
                ))}
            </fieldset>
          </li>
        ))}</ol>
        <Button type="submit" variant="go" busy={submit.busy} busyText="Submitting…">Submit answers</Button>
      </form>
    </>
  );
}

// ── Course editor: lessons and quiz builder, preview, publish, new version ──
const blankLesson = () => ({ title: 'New lesson', body: '' });
const blankQuestion = (type = 'single') => ({ id: Math.random().toString(36).slice(2, 8), type, prompt: '', marks: 1, options: type === 'written' ? [] : type === 'true_false' ? [{ id: 't', text: 'True', correct: true }, { id: 'f', text: 'False', correct: false }] : [{ id: 'a', text: '', correct: true }, { id: 'b', text: '', correct: false }] });
function move<T>(list: T[], i: number, by: number) { const out = [...list]; const j = i + by; if (j < 0 || j >= out.length) return out; [out[i], out[j]] = [out[j], out[i]]; return out; }

export function CourseEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const d = useApi<any>(`/courses/${id}`);
  const [c, setC] = useState<any>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (d.data) setC(d.data.course); }, [d.data]);
  const save = useSubmit(async () => {
    await patch(`/courses/${id}`, { title: c.title, summary: c.summary || null, lessons: c.lessons, questions: c.questions, draw_count: c.draw_count || null, pass_mark: c.pass_mark || null, attempt_limit: c.attempt_limit || null, time_limit_minutes: c.time_limit_minutes || null });
    toast('Draft saved.'); d.reload();
  });
  const publish = useSubmit(async () => { await save.run(); await post(`/courses/${id}/publish`); toast('Published. Earlier attempts stay linked to the version they used.'); d.reload(); });
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
      {!edit && <div className="notice">Published versions cannot change, so results stay tied to what people actually saw. Create a new version to make changes.</div>}
      <ErrorSummary error={err ?? img.error} />
      <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0 }}>
        <section className="card" aria-labelledby="set-h">
          <h2 id="set-h">Course settings</h2>
          <Field label="Title" error={err?.fields.title}><input name="title" value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} /></Field>
          <Field label="Summary" optional><textarea name="summary" value={c.summary ?? ''} onChange={(e) => setC({ ...c, summary: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label="Pass mark (%)" optional error={err?.fields.pass_mark}><input name="pass_mark" type="number" min={1} max={100} value={c.pass_mark ?? ''} onChange={(e) => setC({ ...c, pass_mark: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Attempt limit" optional><input name="attempt_limit" type="number" min={1} max={20} value={c.attempt_limit ?? ''} onChange={(e) => setC({ ...c, attempt_limit: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Time limit (minutes)" optional hint="Leave blank for no timer."><input name="time_limit_minutes" type="number" min={1} max={240} value={c.time_limit_minutes ?? ''} onChange={(e) => setC({ ...c, time_limit_minutes: e.target.value ? Number(e.target.value) : null })} /></Field>
            <Field label="Questions drawn per attempt" optional hint="Use the questions as a bank: each attempt gets this many at random." error={err?.fields.draw_count}><input name="draw_count" type="number" min={1} value={c.draw_count ?? ''} onChange={(e) => setC({ ...c, draw_count: e.target.value ? Number(e.target.value) : null })} /></Field>
          </div>
        </section>

        <section className="card" aria-labelledby="les-h">
          <div className="row between"><h2 id="les-h">Lessons ({c.lessons.length})</h2>{edit && <Button variant="secondary" onClick={() => setC({ ...c, lessons: [...c.lessons, blankLesson()] })}>Add lesson</Button>}</div>
          {c.lessons.map((l: any, i: number) => (
            <details key={i} className="card" open={c.lessons.length < 3}>
              <summary><strong>{i + 1}. {l.title}</strong></summary>
              <Field label="Lesson title" error={err?.fields[`lessons.${i}.title`]}><input name={`lesson-${i}-title`} value={l.title} onChange={(e) => setL(i, 'title', e.target.value)} /></Field>
              <Field label="Text" hint="Leave a blank line between paragraphs."><textarea name={`lesson-${i}-body`} rows={6} value={l.body ?? ''} onChange={(e) => setL(i, 'body', e.target.value)} /></Field>
              <FilePicker label="Image" accept="image/jpeg,image/png,image/webp" instant compact busy={img.busy} buttonText={l.image_file_id ? 'Replace image' : undefined} onChange={(fs) => img.run('lessons', i, fs[0])} />
              {l.image_file_id && <><FileImage id={l.image_file_id} alt={l.image_alt || 'Lesson image'} /><Field label="Describe the image (alternative text)" error={err?.fields[`lessons.${i}.image_alt`]}><input name={`lesson-${i}-alt`} value={l.image_alt ?? ''} onChange={(e) => setL(i, 'image_alt', e.target.value)} /></Field></>}
              <Field label="Video link" optional hint="https link. A transcript or captions text is required."><input name={`lesson-${i}-video`} value={l.video_url ?? ''} onChange={(e) => setL(i, 'video_url', e.target.value || null)} /></Field>
              {l.video_url && <Field label="Transcript" error={err?.fields[`lessons.${i}.transcript`]}><textarea name={`lesson-${i}-transcript`} value={l.transcript ?? ''} onChange={(e) => setL(i, 'transcript', e.target.value)} /></Field>}
              <Field label="Scenario to think about" optional><textarea name={`lesson-${i}-scenario`} value={l.scenario ?? ''} onChange={(e) => setL(i, 'scenario', e.target.value || null)} /></Field>
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
            {edit && <div className="row">{[['single', 'Single choice'], ['multiple', 'Multiple choice'], ['true_false', 'True/false'], ['written', 'Written']].map(([t, n]) => <Button key={t} variant="secondary" onClick={() => setC({ ...c, questions: [...c.questions, blankQuestion(t)] })}>Add {n.toLowerCase()}</Button>)}</div>}</div>
          {c.questions.length === 0 && <p className="muted">No quiz. Learners complete the course by confirming they have read it after the last lesson.</p>}
          {c.questions.map((qn: any, i: number) => (
            <details key={qn.id} className="card" open>
              <summary><strong>Question {i + 1}</strong> — {label(qn.type)} · {qn.marks} mark{qn.marks > 1 ? 's' : ''}</summary>
              <Field label="Question" error={err?.fields[`questions.${i}.prompt`]}><textarea name={`q-${i}-prompt`} value={qn.prompt} onChange={(e) => setQ(i, 'prompt', e.target.value)} /></Field>
              <Field label="Marks"><input name={`q-${i}-marks`} type="number" min={1} max={20} value={qn.marks} onChange={(e) => setQ(i, 'marks', Number(e.target.value))} style={{ maxWidth: 120 }} /></Field>
              <FilePicker label="Image" accept="image/jpeg,image/png,image/webp" instant compact busy={img.busy} buttonText={qn.image_file_id ? 'Replace image' : undefined} onChange={(fs) => img.run('questions', i, fs[0])} />
              {qn.image_file_id && <Field label="Describe the image (alternative text)" error={err?.fields[`questions.${i}.image_alt`]}><input name={`q-${i}-alt`} value={qn.image_alt ?? ''} onChange={(e) => setQ(i, 'image_alt', e.target.value)} /></Field>}
              {qn.type !== 'written' && (
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
              {qn.type === 'written' && <p className="muted small">A trainer marks written answers. The result waits until they do.</p>}
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
  const [dlg, setDlg] = useState<null | 'req' | 'assign' | 'equiv'>(null);
  const [f, setF] = useState<any>({});
  const [mark, setMark] = useState<any>(null);
  const people = useApi<any[]>(dlg === 'assign' && f.company_id ? `/people?company=${f.company_id}` : null);
  const published = (courses.data ?? []).filter((c) => c.status === 'published' && (!f.company_id || !c.company_id || c.company_id === f.company_id));
  const done = (msg: string) => { setDlg(null); toast(msg); matrix.reload(); reqs.reload(); };
  const addReq = useSubmit(async () => { await post('/training/requirements', { company_id: f.company_id, course_root_id: f.course_root_id, job_title: f.job_title || null, due_within_days: Number(f.due_within_days), refresher_months: f.refresher_months ? Number(f.refresher_months) : null }); done('Requirement added.'); });
  const retire = useSubmit(async (rid: string) => { await post(`/training/requirements/${rid}/retire`); done('Requirement removed. Past records are kept.'); });
  const assign = useSubmit(async () => { await post('/training/assignments', f); done('Training assigned.'); });
  const equiv = useSubmit(async () => { await post('/training/equivalences', f); done('Equivalent course accepted.'); });
  const openMark = useSubmit(async (aid: string) => { setMark({ ...(await api('GET', `/attempts/${aid}`)), marks: {} }); });
  const saveMark = useSubmit(async () => { const r = await post(`/attempts/${mark.id}/mark`, { marks: mark.marks }); setMark(null); toast(r.passed ? 'Marked: passed.' : 'Marked: not passed.'); marking.reload(); matrix.reload(); });
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
            {marking.data?.map((m) => <li key={m.id}><span>Written answers from <strong>{m.person_name}</strong> — {m.title}<br /><span className="muted small">Submitted {fmtDate(m.submitted_at)}</span></span><Button variant="secondary" busy={openMark.busy} onClick={() => openMark.run(m.id)}>Mark</Button></li>)}
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
      <Dialog open={dlg === 'equiv'} onClose={() => setDlg(null)} title="Accept an equivalent course" footer={<Button busy={equiv.busy} onClick={() => equiv.run()}>Accept</Button>}>
        <p className="small muted">People who completed the equivalent course will count as up to date for the required one, in this company only.</p>
        <ErrorSummary error={equiv.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{manage.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Required course"><select name="course_root_id" value={f.course_root_id} onChange={(e) => setF({ ...f, course_root_id: e.target.value })}><option value="">Choose…</option>{published.map((c) => <option key={c.root_id} value={c.root_id}>{c.title}</option>)}</select></Field>
        <Field label="Accept this course as equivalent"><select name="equivalent_root_id" value={f.equivalent_root_id} onChange={(e) => setF({ ...f, equivalent_root_id: e.target.value })}><option value="">Choose…</option>{(courses.data ?? []).filter((c) => c.status === 'published').map((c) => <option key={c.root_id} value={c.root_id}>{c.title}{c.company_code ? ` (${c.company_code})` : ' (shared)'}</option>)}</select></Field>
      </Dialog>
      <Dialog open={!!mark} onClose={() => setMark(null)} title="Mark written answers" footer={<Button busy={saveMark.busy} onClick={() => saveMark.run()}>Save marks</Button>}>
        {mark && <>
          <ErrorSummary error={saveMark.error} />
          {mark.questions.filter((x: any) => x.type === 'written').map((qn: any) => (
            <section key={qn.id} style={{ marginBottom: 16 }}><h3 style={{ fontSize: '1rem' }}>{qn.prompt}</h3>
              <blockquote className="notice" style={{ whiteSpace: 'pre-wrap' }}>{mark.answers[qn.id] || <em>No answer given</em>}</blockquote>
              <Field label={`Marks (0 to ${qn.marks})`}><input name={`mark-${qn.id}`} type="number" min={0} max={qn.marks} value={mark.marks[qn.id] ?? ''} onChange={(e) => setMark({ ...mark, marks: { ...mark.marks, [qn.id]: e.target.value === '' ? undefined : Number(e.target.value) } })} style={{ maxWidth: 120 }} /></Field>
            </section>
          ))}
          <p className="small muted">Choice questions were marked automatically: {mark.auto_marks} mark(s).</p>
        </>}
      </Dialog>
    </div>
  );
}
