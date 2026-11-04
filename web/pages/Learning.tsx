// Learning platform (stage 1): learner dashboard, course library, course pages and the lesson player.
// Every figure comes from the learner's records; time left in a course is the only estimate and says so.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Award, BookOpen, Bookmark, BookmarkCheck, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, ClipboardCheck, Clock, GraduationCap,
  HardHat, HeartHandshake, Lock, Menu, MessagesSquare, PlayCircle, Repeat, Search, ShieldCheck, Sparkles, Target, Timer, Users, type LucideIcon } from 'lucide-react';
import { api, post, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';
import { FileImage, Paragraphs, Quiz, QuizResult } from './Training.tsx';

export const CATEGORY: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  fundamentals: { label: 'Supported accommodation', icon: HeartHandshake, tone: 'c-teal' },
  safeguarding: { label: 'Safeguarding & welfare', icon: ShieldCheck, tone: 'c-navy' },
  health_safety: { label: 'Health, safety & property', icon: HardHat, tone: 'c-amber' },
  practice: { label: 'Professional practice', icon: MessagesSquare, tone: 'c-violet' },
  leadership: { label: 'Leadership & quality', icon: Users, tone: 'c-green' },
  other: { label: 'Other learning', icon: BookOpen, tone: 'c-slate' },
};
const cat = (k?: string | null) => CATEGORY[k ?? 'other'] ?? CATEGORY.other;
const DIFFICULTY: Record<string, string> = { foundation: 'Foundation', intermediate: 'Intermediate', advanced: 'Advanced' };
const mins = (m?: number | null) => (m == null ? null : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const pct = (done: number, total: number) => (total ? Math.round((100 * done) / total) : 0);

export function CourseCover({ category, title, small }: { category?: string | null; title: string; small?: boolean }) {
  const c = cat(category);
  const I = c.icon;
  return <div className={`lx-cover ${c.tone}${small ? ' small' : ''}`} aria-hidden="true"><I size={small ? 28 : 44} strokeWidth={1.6} /><span>{title}</span></div>;
}
function ProgressBar({ value, label: l }: { value: number; label: string }) {
  return <div className="lx-progress" role="progressbar" aria-label={l} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${value}%` }} /></div>;
}

// ── Dashboard ──
export function LearningHome({ onTab }: { onTab: (t: string) => void }) {
  const hub = useHub();
  const d = useApi<any>('/learning/me');
  const first = (hub.me.person.preferred_name ?? hub.me.person.full_name).split(' ')[0];
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  const k = d.data?.kpis;
  const next = d.data?.continuing[0];
  const tiles: [LucideIcon, string, React.ReactNode, string?, string?][] = k ? [
    [Target, 'Assigned to you', k.assigned, 'required or assigned courses'],
    [CheckCircle2, 'Courses completed', k.completed, undefined, 'ok'],
    [PlayCircle, 'In progress', k.in_progress],
    [ShieldCheck, 'Required training up to date', `${k.mandatory_done} of ${k.assigned}`, undefined, k.assigned && k.mandatory_done < k.assigned ? 'warn' : 'ok'],
    [Timer, 'Learning time recorded', k.seconds < 3600 ? `${Math.round(k.seconds / 60)} min` : `${(k.seconds / 3600).toFixed(1)} h`, 'time with lessons open'],
    [Award, 'Verified certificates', k.certificates, k.awaiting_verification ? `${k.awaiting_verification} awaiting verification` : undefined],
    [Repeat, 'Needs renewal', k.renewal, 'expiring or expired', k.renewal ? 'warn' : undefined],
    [ClipboardCheck, 'Assessments outstanding', k.assessments, 'started or awaiting marking', k.assessments ? 'warn' : undefined],
    [Users, 'Next supervision due', k.next_supervision ? fmtDate(k.next_supervision) : '—', k.next_supervision ? undefined : 'none recorded'],
  ] : [];
  return (
    <div className="lx">
      <section className="lx-hero">
        <div>
          <p className="lx-eyebrow">Training & coaching</p>
          <h2>Welcome back, {first}</h2>
          <p>Continue building your skills and developing your career.</p>
        </div>
        <nav className="lx-actions" aria-label="Quick actions">
          <button type="button" onClick={() => onTab('courses')}><BookOpen size={18} aria-hidden="true" />Browse courses</button>
          {next ? <Link to={`/training/courses/${next.id}/learn`}><PlayCircle size={18} aria-hidden="true" />Continue learning</Link>
            : <button type="button" disabled><PlayCircle size={18} aria-hidden="true" />Continue learning</button>}
          <button type="button" onClick={() => onTab('record')}><Award size={18} aria-hidden="true" />My certificates & record</button>
          <Link to={`/people/${hub.me.person.id}?tab=development`}><Sparkles size={18} aria-hidden="true" />My development</Link>
        </nav>
      </section>
      {!d.data ? <Skeleton lines={6} /> : <>
        <ul className="lx-kpis" aria-label="Your learning figures">{tiles.map(([I, t, v, sub, tone]) => (
          <li key={t} className={`lx-kpi ${tone ?? ''}`}><span className="lx-kpi-icon"><I size={18} aria-hidden="true" /></span><span className="lx-kpi-v">{v}</span><span className="lx-kpi-l">{t}</span>{sub && <span className="lx-kpi-s">{sub}</span>}</li>))}</ul>

        <section aria-labelledby="cl-h">
          <h3 id="cl-h" className="lx-h">Continue learning</h3>
          {d.data.continuing.length === 0 ? <Empty>Nothing in progress. Start a course from the library or the recommendations below.</Empty> : (
            <ul className="lx-rail">{d.data.continuing.map((c: any) => {
              const p = pct(c.done, c.lessons);
              const left = c.duration_minutes ? Math.max(1, Math.round(c.duration_minutes * (1 - c.done / c.lessons))) : null;
              return <li key={c.id} className="lx-card">
                <CourseCover category={c.category} title={cat(c.category).label} small />
                <div className="lx-card-body">
                  <span className="lx-tag">{cat(c.category).label}</span>
                  <h4>{c.title}</h4>
                  <ProgressBar value={p} label={`${c.title}: ${p}% complete`} />
                  <p className="small muted">{p}% · {c.done} of {c.lessons} lessons · {c.modules_done} of {c.modules} modules{left ? ` · about ${mins(left)} left` : ''}<br />Last opened {fmtDateTime(c.last_opened_at)}</p>
                  <Link className="btn" to={`/training/courses/${c.id}/learn`}>Continue<span className="sr-only"> {c.title}</span></Link>
                </div>
              </li>;
            })}</ul>
          )}
        </section>

        <div className="lx-two">
          <section className="card" aria-labelledby="rq-h">
            <h3 id="rq-h" className="lx-h">Required and assigned</h3>
            {d.data.matrix.length === 0 ? <Empty>No training is required for your roles yet.</Empty> : (
              <ul className="list">{d.data.matrix.map((m: any) => {
                const s = ({ current: ['verified', 'Up to date'], expiring: ['submitted', 'Renew soon'], due: ['info', 'Due'], overdue: ['action', 'Overdue'] } as Record<string, [string, string]>)[m.status];
                return <li key={`${m.company_id}${m.course_root_id}`}><span><strong>{m.course_title ?? 'Course not yet published'}</strong> <CompanyBadge code={m.company_code} /><br />
                  <span className="small muted">{m.completed_on ? `Completed ${fmtDate(m.completed_on)}${m.renew_on ? ` · renew by ${fmtDate(m.renew_on)}` : ''}` : `Due ${fmtDate(m.due_on)}`}</span></span>
                  <span className="row"><Status s={s[0]} text={s[1]} />{m.course_id && m.status !== 'current' && <Link className="btn secondary" to={`/training/courses/${m.course_id}`}>Open<span className="sr-only"> {m.course_title}</span></Link>}</span></li>;
              })}</ul>
            )}
          </section>
          <section className="card" aria-labelledby="rc-h">
            <h3 id="rc-h" className="lx-h">Recommended for you</h3>
            <p className="small muted">Courses required for you first, then courses suited to your role{d.data.roles.length ? ` (${d.data.roles.map(label).join(', ').toLowerCase()})` : ''}.</p>
            {d.data.recommended.length === 0 ? <Empty>No recommendations right now.</Empty> : (
              <ul className="list">{d.data.recommended.map((c: any) => <li key={c.id}><span><Link to={`/training/courses/${c.id}`}>{c.title}</Link><br />
                <span className="small muted">{cat(c.category).label}{c.duration_minutes ? ` · ${mins(c.duration_minutes)}` : ''}{c.difficulty ? ` · ${DIFFICULTY[c.difficulty]}` : ''}</span></span>
                {c.required && <Status s="action" text="Required" />}</li>)}</ul>
            )}
          </section>
        </div>
      </>}
    </div>
  );
}

// ── Course library ──
type Filters = { q: string; category: string; difficulty: string; status: string; length: string; required: boolean; certificate: boolean; sort: string };
export function CourseLibrary({ onBuild }: { onBuild?: () => void }) {
  const hub = useHub();
  const list = useApi<any[]>(`/courses${hub.q()}`);
  const [f, setF] = useState<Filters>({ q: '', category: '', difficulty: '', status: '', length: '', required: false, certificate: false, sort: 'title' });
  const rows = useMemo(() => {
    const all = list.data ?? [];
    // One card per course: the published version for learners; managers also see a draft when there is no published one.
    const byRoot = new Map<string, any>();
    for (const c of all) { const cur = byRoot.get(c.root_id); if (!cur || (cur.status !== 'published' && c.status === 'published')) byRoot.set(c.root_id, c); }
    const t = f.q.trim().toLowerCase();
    return [...byRoot.values()].map((c) => ({ ...c, pct: pct(c.my_lessons_done, c.lesson_count), state: c.my_completed_on ? 'completed' : c.my_lessons_done || c.my_lesson ? 'in_progress' : 'not_started' }))
      .filter((c) => (!t || `${c.title} ${c.summary ?? ''}`.toLowerCase().includes(t)) && (!f.category || (c.category ?? 'other') === f.category) && (!f.difficulty || c.difficulty === f.difficulty)
        && (!f.status || c.state === f.status) && (!f.required || c.mandatory) && (!f.certificate || c.certificate_eligible)
        && (!f.length || (f.length === 'short' ? (c.duration_minutes ?? 0) <= 45 : f.length === 'medium' ? c.duration_minutes > 45 && c.duration_minutes <= 90 : c.duration_minutes > 90)))
      .sort((a, b) => f.sort === 'length' ? (a.duration_minutes ?? 999) - (b.duration_minutes ?? 999) : f.sort === 'progress' ? b.pct - a.pct : a.title.localeCompare(b.title));
  }, [list.data, f]);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  return (
    <div className="lx">
      <div className="rp-head"><div><h2>Course library</h2><p className="muted small">{list.data ? `${rows.length} course${rows.length === 1 ? '' : 's'} shown` : ' '}</p></div>{onBuild && <div className="rp-head-actions"><Button onClick={onBuild}>Build a course</Button></div>}</div>
      <div className="lx-filters">
        <label className="rp-search"><Search size={18} aria-hidden="true" /><input type="search" placeholder="Search courses…" aria-label="Search courses" value={f.q} onChange={set('q')} /></label>
        <select aria-label="Category" value={f.category} onChange={set('category')}><option value="">All categories</option>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select aria-label="Level" value={f.difficulty} onChange={set('difficulty')}><option value="">Any level</option>{Object.entries(DIFFICULTY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Progress" value={f.status} onChange={set('status')}><option value="">Any progress</option><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select>
        <select aria-label="Length" value={f.length} onChange={set('length')}><option value="">Any length</option><option value="short">Up to 45 min</option><option value="medium">45–90 min</option><option value="long">Over 90 min</option></select>
        <select aria-label="Sort" value={f.sort} onChange={set('sort')}><option value="title">A–Z</option><option value="length">Shortest first</option><option value="progress">Most progress</option></select>
        <label className="check"><input type="checkbox" checked={f.required} onChange={set('required')} /> Required for me</label>
        <label className="check"><input type="checkbox" checked={f.certificate} onChange={set('certificate')} /> Certificate on completion</label>
      </div>
      {list.error ? <LoadError error={list.error} retry={list.reload} /> : !list.data ? <Skeleton lines={6} /> : rows.length === 0 ? <Empty>No courses match.</Empty> : (
        <ul className="lx-grid">{rows.map((c) => (
          <li key={c.id} className="lx-card">
            <CourseCover category={c.category} title={cat(c.category).label} />
            <div className="lx-card-body">
              <div className="row between"><span className="lx-tag">{cat(c.category).label}</span>{c.mandatory && <Status s="action" text="Required" />}</div>
              <h4><Link to={`/training/courses/${c.id}`}>{c.title}</Link></h4>
              {c.summary && <p className="small muted lx-clamp">{c.summary}</p>}
              <p className="lx-meta">{c.duration_minutes && <span><Clock size={14} aria-hidden="true" />{mins(c.duration_minutes)}</span>}<span><BookOpen size={14} aria-hidden="true" />{c.lesson_count} lessons{c.module_count > 1 ? ` · ${c.module_count} modules` : ''}</span>
                {c.difficulty && <span><GraduationCap size={14} aria-hidden="true" />{DIFFICULTY[c.difficulty]}</span>}{c.certificate_eligible && <span><Award size={14} aria-hidden="true" />Certificate</span>}</p>
              {c.status === 'draft' ? <Status s="planned" text={c.review_status === 'pending_review' ? 'Draft · content awaiting review' : 'Draft'} /> : c.state === 'completed' ? <Status s="verified" text={`Completed ${fmtDate(c.my_completed_on)}`} />
                : c.state === 'in_progress' ? <ProgressBar value={c.pct} label={`${c.title}: ${c.pct}% complete`} /> : null}
              <div className="row">
                {c.status === 'published' && <Link className="btn secondary" to={c.state === 'not_started' ? `/training/courses/${c.id}` : `/training/courses/${c.id}/learn`}>{c.state === 'not_started' ? 'View course' : c.state === 'completed' ? 'Revisit' : 'Continue'}<span className="sr-only"> {c.title}</span></Link>}
                {c.can_manage && <Link className="btn ghost" to={`/training/courses/${c.id}/edit`}>{c.status === 'draft' ? 'Edit' : 'Manage'}<span className="sr-only"> {c.title}</span></Link>}
              </div>
            </div>
          </li>
        ))}</ul>
      )}
    </div>
  );
}

// Lessons grouped by module, in order.
function modulesOf(lessons: any[]) {
  const out: { name: string; items: { l: any; i: number }[] }[] = [];
  lessons.forEach((l, i) => { const name = l.module ?? ''; const last = out[out.length - 1]; if (last && last.name === name) last.items.push({ l, i }); else out.push({ name, items: [{ l, i }] }); });
  return out;
}

// ── Course page ──
export function CourseDetail() {
  const { id } = useParams();
  const d = useApi<any>(`/courses/${id}`);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={10} />;
  const { course: c, lessons: lp, completed_on, can, attempts } = d.data;
  const done = new Set(lp.filter((x: any) => x.completed_at).map((x: any) => x.lesson_index));
  const p = pct(done.size, c.lessons.length);
  const started = lp.length > 0;
  const firstOpen = c.lessons.findIndex((_: any, i: number) => !done.has(i));
  return (
    <div className="lx">
      <PageHead title={c.title} crumbs={[['Training & coaching', '/training'], ['Course library', '/training?tab=courses'], [c.title]]} />
      <section className="lx-detail-hero">
        <CourseCover category={c.category} title={cat(c.category).label} />
        <div>
          <span className="lx-tag">{cat(c.category).label}</span>
          {c.summary && <p className="lx-lead">{c.summary}</p>}
          <p className="lx-meta">{c.duration_minutes && <span><Clock size={14} aria-hidden="true" />{mins(c.duration_minutes)}</span>}<span><BookOpen size={14} aria-hidden="true" />{c.lessons.length} lessons</span>
            {c.difficulty && <span><GraduationCap size={14} aria-hidden="true" />{DIFFICULTY[c.difficulty]}</span>}{c.questions.length > 0 && <span><ClipboardCheck size={14} aria-hidden="true" />Final assessment · pass mark {c.pass_mark}%</span>}
            {c.certificate_eligible && <span><Award size={14} aria-hidden="true" />Certificate on completion</span>}</p>
          {completed_on && <p><Status s="verified" text={`You completed this on ${fmtDate(completed_on)}`} /></p>}
          {started && !completed_on && <ProgressBar value={p} label={`${p}% complete`} />}
          <div className="row">
            {c.status === 'published' ? <Link className="btn" to={`/training/courses/${c.id}/learn${firstOpen > 0 ? `?lesson=${firstOpen}` : ''}`}>{completed_on ? 'Revisit the course' : started ? 'Continue' : 'Start the course'}</Link>
              : <span className="notice warn">This version is not published.</span>}
            {can.manage && <Link className="btn ghost" to={`/training/courses/${c.id}/edit`}>Manage course</Link>}
          </div>
          <p className="small muted">Version {c.version}{c.published_at ? ` · published ${fmtDate(c.published_at)}` : ''}{c.content_owner ? ` · content owner: ${c.content_owner}` : ''}{c.review_on ? ` · next review ${fmtDate(c.review_on)}` : ''}</p>
        </div>
      </section>
      {c.review_status === 'pending_review' && <div className="notice warn">This content is waiting for a specialist review and is not yet approved for use.</div>}
      <div className="lx-two">
        <div className="stack">
          {c.objectives?.length > 0 && <section className="card" aria-labelledby="ob-h"><h2 id="ob-h">What you will learn</h2><ul className="lx-ticks">{c.objectives.map((o: string) => <li key={o}><Check size={16} aria-hidden="true" />{o}</li>)}</ul></section>}
          <section className="card" aria-labelledby="cu-h">
            <h2 id="cu-h">Course content</h2>
            {modulesOf(c.lessons).map((m, mi) => (
              <details key={mi} className="lx-module" open={modulesOf(c.lessons).length < 4}>
                <summary><strong>{m.name || `Lessons`}</strong> <span className="small muted">{m.items.filter((x) => done.has(x.i)).length} of {m.items.length} done</span></summary>
                <ol className="lx-curriculum">{m.items.map(({ l, i }) => <li key={i}>{done.has(i) ? <CheckCircle2 size={18} className="ok" aria-label="Done" /> : <CircleDashed size={18} aria-label="Not done" />}<span>{l.title}</span></li>)}</ol>
              </details>
            ))}
            {c.questions.length > 0 && <p className="small"><ClipboardCheck size={16} aria-hidden="true" /> Final assessment after the lessons{c.attempt_limit ? ` · ${c.attempt_limit} attempts` : ''}{c.time_limit_minutes ? ` · ${c.time_limit_minutes} minutes` : ''}.</p>}
          </section>
        </div>
        <div className="stack">
          {attempts?.some((a: any) => a.status !== 'in_progress') && <Attempts course={c} attempts={attempts.filter((a: any) => a.status !== 'in_progress')} />}
          {c.audience && <section className="card" aria-labelledby="au-h"><h2 id="au-h">Who it is for</h2><p>{c.audience}</p></section>}
          {c.source_refs?.length > 0 && <section className="card" aria-labelledby="sr-h"><h2 id="sr-h">Sources and guidance</h2><ul>{c.source_refs.map((r: any) => <li key={r.label}>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.label}</a> : r.label}</li>)}</ul></section>}
          <section className="card"><p className="small muted">Completing a course shows learning, not practical competence. Competence is assessed separately by an observer. Certificates are issued by your organisation and are not external qualifications.</p></section>
        </div>
      </div>
    </div>
  );
}

// Lesson text: blank lines split paragraphs; "## " starts a heading; "- " lines form a list.
export function LessonBody({ text }: { text?: string | null }) {
  const blocks = (text ?? '').split(/\n{2,}/).filter(Boolean);
  return <>{blocks.map((b, i) => {
    const lines = b.split('\n');
    return <Fragment key={i}>{lines[0].startsWith('## ') && <h3>{lines[0].slice(3)}</h3>}
      {(() => { const rest = lines[0].startsWith('## ') ? lines.slice(1) : lines;
        if (!rest.length) return null;
        if (rest.every((l) => l.startsWith('- '))) return <ul>{rest.map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul>;
        return <p style={{ whiteSpace: 'pre-wrap' }}>{rest.join('\n')}</p>; })()}</Fragment>;
  })}</>;
}

function KnowledgeCheck({ check, n }: { check: any; n: number }) {
  const [pick, setPick] = useState<number | null>(null);
  const chosen = pick !== null ? check.options[pick] : null;
  return (
    <fieldset className="lx-check">
      <legend><Sparkles size={16} aria-hidden="true" /> Check your understanding {n}: {check.prompt}</legend>
      {check.options.map((o: any, k: number) => (
        <label key={k} className={`lx-opt ${pick === k ? (o.correct ? 'right' : 'wrong') : ''}`}>
          <input type="radio" name={`check-${n}`} checked={pick === k} onChange={() => setPick(k)} />{o.text}
        </label>
      ))}
      <div aria-live="polite">{chosen && <p className={`lx-feedback ${chosen.correct ? 'right' : 'wrong'}`}><strong>{chosen.correct ? 'Good answer.' : 'Not quite.'}</strong> {chosen.feedback ?? ''}</p>}</div>
    </fieldset>
  );
}

// ── Lesson player ──
export function LessonPlayer() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const d = useApi<any>(`/courses/${id}`);
  const [lp, setLp] = useState<Map<number, any>>(new Map());
  const [mode, setMode] = useState<'lesson' | 'finish' | 'quiz' | 'done'>('lesson');
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState<any[]>([]);
  const [marks, setMarks] = useState<Set<number>>(new Set());
  const [declared, setDeclared] = useState(false);
  const [now, setNow] = useState(Date.now());
  const opened = useRef<number>(Date.now());
  const c = d.data?.course;
  useEffect(() => {
    if (!d.data) return;
    setLp(new Map(d.data.lessons.map((x: any) => [x.lesson_index, x])));
    setNotes(d.data.notes); setMarks(new Set(d.data.bookmarks));
  }, [d.data]);
  const n = c ? c.lessons.length : 0;
  const i = c ? Math.min(Math.max(0, Number(params.get('lesson') ?? d.data.progress ?? 0) || 0), n - 1) : 0;
  const lesson = c?.lessons[i];
  const done = (k: number) => !!lp.get(k)?.completed_at;
  const doneCount = c ? c.lessons.filter((_: any, k: number) => done(k)).length : 0;

  // Open the lesson, then send a beat every 30 s while the page is visible.
  useEffect(() => {
    if (!c || c.status !== 'published' || mode !== 'lesson') return;
    opened.current = Date.now();
    const call = (action: string) => api('PUT', `/courses/${id}/lessons/${i}`, { action }).then((r: any) => setLp((m) => new Map(m).set(i, r))).catch(() => {});
    call('open');
    const beat = setInterval(() => { if (document.visibilityState === 'visible') call('beat'); }, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(beat); clearInterval(tick); };
  }, [c, id, i, mode]);
  useEffect(() => { document.getElementById('lesson-h')?.focus(); window.scrollTo({ top: 0 }); }, [i, mode]);

  const go = (k: number) => { setMode('lesson'); setMenu(false); setParams({ lesson: String(k) }); };
  const complete = useSubmit(async () => {
    const r = await api('PUT', `/courses/${id}/lessons/${i}`, { action: 'complete' });
    setLp((m) => new Map(m).set(i, r));
    if (i < n - 1) go(i + 1); else setMode('finish');
  });
  const finishCourse = useSubmit(async () => { await post(`/courses/${id}/complete`, { declaration: declared }); toast('Course completed.'); setMode('done'); d.reload(); });
  const addNote = useSubmit(async () => { const r = await post(`/courses/${id}/notes`, { lesson_index: i, body: note }); setNotes([...notes, r]); setNote(''); });
  const toggleMark = async () => { const on = !marks.has(i); await api('PUT', `/courses/${id}/bookmarks/${i}`, { on }); const s = new Set(marks); if (on) s.add(i); else s.delete(i); setMarks(s); };

  if (d.error) return <LoadError error={d.error} />;
  if (!c) return <Skeleton lines={10} />;
  if (c.status !== 'published') return <><PageHead title={c.title} /><div className="notice warn">This version is not published. <Link to={`/training/courses/${id}/edit`}>Open the editor</Link></div></>;
  if (mode === 'quiz') return <Quiz course={c} onDone={() => { setMode('done'); d.reload(); }} />;
  const need = d.data.min_seconds[i] ?? 5;
  const waited = Math.floor((now - opened.current) / 1000);
  const wait = done(i) ? 0 : Math.max(0, need - Math.max(waited, lp.get(i)?.seconds ?? 0));
  const p = pct(doneCount, n);
  const nav_ = (
    <nav className="lx-nav" aria-label="Course lessons">
      <p className="small"><strong>{p}% complete</strong> · {doneCount} of {n} lessons</p>
      <ProgressBar value={p} label={`Course ${p}% complete`} />
      {modulesOf(c.lessons).map((m, mi) => (
        <div key={mi}>
          {m.name && <p className="lx-nav-mod">{m.name}</p>}
          <ol>{m.items.map(({ l, i: k }) => (
            <li key={k}><button type="button" className={k === i && mode === 'lesson' ? 'current' : ''} aria-current={k === i && mode === 'lesson' ? 'step' : undefined} onClick={() => go(k)}>
              {done(k) ? <CheckCircle2 size={18} className="ok" aria-label="Done" /> : <CircleDashed size={18} aria-label="Not done" />}<span>{l.title}</span>{marks.has(k) && <BookmarkCheck size={14} aria-label="Bookmarked" />}
            </button></li>))}</ol>
        </div>
      ))}
      {c.questions.length > 0 && <p className="lx-nav-mod"><button type="button" className="linkish" disabled={doneCount < n} onClick={() => setMode('finish')}>{doneCount < n ? <Lock size={14} aria-hidden="true" /> : <ClipboardCheck size={14} aria-hidden="true" />} Final assessment</button></p>}
    </nav>
  );
  return (
    <div className="lx-player">
      <header className="lx-player-head">
        <Link to={`/training/courses/${id}`} className="linkish"><ChevronLeft size={16} aria-hidden="true" />{c.title}</Link>
        <button type="button" className="btn ghost lx-menu-btn" aria-expanded={menu} onClick={() => setMenu(!menu)}><Menu size={18} aria-hidden="true" />Lessons</button>
      </header>
      <div className="lx-player-grid">
        <aside className={`lx-side ${menu ? 'open' : ''}`}>{nav_}</aside>
        <main className="lx-main">
          {mode === 'done' ? (
            <div className="card lx-done"><CheckCircle2 size={48} className="ok" aria-hidden="true" /><h1 id="lesson-h" tabIndex={-1}>Well done</h1><p>Your result is saved in your training record.</p><Link className="btn" to="/training">Back to Training & coaching</Link></div>
          ) : mode === 'finish' ? (
            <div className="card">
              <h1 id="lesson-h" tabIndex={-1}>{c.questions.length ? 'Final assessment' : 'Complete the course'}</h1>
              {doneCount < n ? <p>Complete every lesson first ({n - doneCount} left).</p> : c.questions.length ? <>
                <p>{c.questions.length > (c.draw_count ?? c.questions.length) ? c.draw_count : c.questions.length} questions · pass mark {c.pass_mark}%{c.time_limit_minutes ? ` · ${c.time_limit_minutes} minutes` : ''}{c.attempt_limit ? ` · ${c.attempt_limit} attempts` : ''}. Your answers save as you go.</p>
                <Button variant="go" onClick={() => setMode('quiz')}>Start the assessment</Button></> : <>
                <ErrorSummary error={finishCourse.error} />
                <label className="check"><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} /> I have read and understood this course</label>
                <Button variant="go" busy={finishCourse.busy} disabled={!declared} onClick={() => finishCourse.run()}>Complete course</Button></>}
            </div>
          ) : (
            <article className="lx-lesson" aria-labelledby="lesson-h">
              <p className="lx-eyebrow">{lesson.module ? `${lesson.module} · ` : ''}Lesson {i + 1} of {n}</p>
              <div className="row between"><h1 id="lesson-h" tabIndex={-1}>{lesson.title}</h1>
                <button type="button" className="btn ghost" aria-pressed={marks.has(i)} onClick={toggleMark}>{marks.has(i) ? <BookmarkCheck size={18} aria-hidden="true" /> : <Bookmark size={18} aria-hidden="true" />}{marks.has(i) ? 'Bookmarked' : 'Bookmark'}</button></div>
              <div className="lx-text"><LessonBody text={lesson.body} /></div>
              {lesson.image_file_id && <FileImage id={lesson.image_file_id} alt={lesson.image_alt} />}
              {lesson.video_url && <div className="notice"><a href={lesson.video_url} target="_blank" rel="noopener noreferrer">Watch the video (opens in a new tab)</a><details style={{ marginTop: 8 }}><summary>Read the transcript</summary><Paragraphs text={lesson.transcript} /></details></div>}
              {lesson.scenario && <aside className="lx-scenario"><strong>In practice</strong><LessonBody text={lesson.scenario} /></aside>}
              {lesson.checks?.map((ch: any, k: number) => <KnowledgeCheck key={`${i}-${k}`} check={ch} n={k + 1} />)}
              {lesson.key_points?.length > 0 && <aside className="lx-keypoints"><strong>Key points</strong><ul>{lesson.key_points.map((k: string) => <li key={k}>{k}</li>)}</ul></aside>}
              {lesson.resources?.length > 0 && <><h3>Resources</h3><ul>{lesson.resources.map((r: any) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener noreferrer">{r.label}</a></li>)}</ul></>}
              <ErrorSummary error={complete.error} />
              <div className="lx-pager">
                <Button variant="secondary" disabled={i === 0} onClick={() => go(i - 1)}><ChevronLeft size={18} aria-hidden="true" />Previous</Button>
                <Button variant="ghost" onClick={() => nav('/training')}>Save and exit</Button>
                {done(i) ? <Button onClick={() => (i < n - 1 ? go(i + 1) : setMode('finish'))}>{i < n - 1 ? 'Next lesson' : c.questions.length ? 'Go to the assessment' : 'Finish'}<ChevronRight size={18} aria-hidden="true" /></Button>
                  : <Button busy={complete.busy} disabled={wait > 0} onClick={() => complete.run()}>{wait > 0 ? `Keep reading (${wait}s)` : i < n - 1 ? 'Mark done and continue' : 'Mark done'}<ChevronRight size={18} aria-hidden="true" /></Button>}
              </div>
            </article>
          )}
        </main>
        <aside className="lx-panel" aria-label="Notes">
          <section>
            <h2 className="lx-h">My notes</h2>
            <p className="small muted">Only you can see these.</p>
            <ul className="lx-notes">{notes.filter((x) => x.lesson_index === i).map((x) => <li key={x.id}><p>{x.body}</p><button type="button" className="linkish small" onClick={async () => { await api('DELETE', `/learning-notes/${x.id}`); setNotes(notes.filter((y) => y.id !== x.id)); }}>Delete<span className="sr-only"> note</span></button></li>)}</ul>
            <label className="sr-only" htmlFor="note-new">Add a note to this lesson</label>
            <textarea id="note-new" rows={3} placeholder="Add a note to this lesson…" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button variant="secondary" disabled={!note.trim()} busy={addNote.busy} onClick={() => addNote.run()}>Save note</Button>
            {notes.some((x) => x.lesson_index !== i) && <p className="small muted">{notes.filter((x) => x.lesson_index !== i).length} note(s) on other lessons.</p>}
          </section>
          {marks.size > 0 && <section><h2 className="lx-h">Bookmarks</h2><ul className="lx-marks">{[...marks].sort((a, b) => a - b).map((k) => <li key={k}><button type="button" className="linkish" onClick={() => go(k)}>{c.lessons[k]?.title}</button></li>)}</ul></section>}
        </aside>
      </div>
    </div>
  );
}

const ATTEMPT_STATUS: Record<string, string> = { awaiting_marking: 'Waiting for a trainer', awaiting_approval: 'Waiting for approval' };
function Attempts({ course, attempts }: { course: any; attempts: any[] }) {
  const [open, setOpen] = useState<any>(null);
  const load = useSubmit(async (id: string) => setOpen(await api('GET', `/attempts/${id}`)));
  return (
    <section className="card" aria-labelledby="at-h">
      <h2 id="at-h">Your assessment attempts</h2>
      <ErrorSummary error={load.error} />
      <ul className="list">{attempts.map((a) => (
        <li key={a.id}><span>{fmtDate(a.submitted_at)}<br /><span className="small muted">{ATTEMPT_STATUS[a.status] ?? `${a.score} of ${a.max_score} · ${a.passed ? 'passed' : 'not passed'}`}</span></span>
          {a.status === 'marked' && <Button variant="secondary" busy={load.busy} onClick={() => load.run(a.id)}>See feedback</Button>}</li>))}</ul>
      {open && <Dialog open onClose={() => setOpen(null)} title="Your result">
        <QuizResult inDialog course={course} questions={open.questions} result={{ ...open, max: open.max_score }} onDone={() => setOpen(null)} />
      </Dialog>}
    </section>
  );
}
