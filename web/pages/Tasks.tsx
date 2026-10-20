import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, download, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { addDays, fmtDate, fmtDateTime, label, londonToday, weekStart } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

const STATUSES: [string, string][] = [['not_started', 'Not Started'], ['in_progress', 'In Progress'], ['submitted', 'Submitted'], ['changes_requested', 'Changes Requested'], ['completed', 'Completed']];
type View = 'list' | 'board' | 'calendar' | 'property';

export function Tasks() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('list');
  const mine = params.get('mine') === 'true';
  const list = useApi<any[]>(`/tasks${hub.q({ mine: mine ? 'true' : undefined })}`);
  const toast = useToast();
  const move = useSubmit(async (t: any, status: string) => { await patch(`/tasks/${t.id}`, { status }); toast(`Moved to ${label(status)}.`); list.reload(); });
  const creating = params.get('new') === '1';
  const rows = list.data ?? [];

  return (
    <>
      <PageHead title="Tasks" intro="Every task shows its company, owner, reviewer and deadline." actions={<Button onClick={() => setParams({ ...Object.fromEntries(params), new: '1' })}>New task</Button>} />
      <div className="row between" style={{ marginBottom: 16 }}>
        <Chips label="Whose tasks" value={mine ? 'mine' : 'all'} onChange={(v) => setParams(v === 'mine' ? { mine: 'true' } : {})} options={[['mine', 'Mine'], ['all', 'All I can see']]} />
        <Chips label="View" value={view} onChange={setView} options={[['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar'], ['property', 'By property']]} />
      </div>
      <ErrorSummary error={move.error} />
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading && !list.data ? <Skeleton lines={6} /> : rows.length === 0 ? <Empty>No tasks here.</Empty> : view === 'list' ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Task</th><th>Company</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id}>
              <td><Link to={`/tasks/${t.id}`}>{t.title}</Link>{t.property_name && <div className="muted small">{t.property_name}</div>}</td>
              <td><CompanyBadge code={t.company_code} name={t.company_name} /></td>
              <td>{t.owner_name ?? '—'}{t.reviewer_name && <div className="muted small">Reviewer: {t.reviewer_name}</div>}</td>
              <td>{fmtDate(t.due_on)}{t.overdue && <div><Status s="action" text="Overdue" /></div>}</td>
              <td><Status s={t.priority} /></td><td><Status s={t.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : view === 'board' ? (
        <div className="board">
          {STATUSES.map(([s, title], i) => {
            const col = rows.filter((t) => t.status === s);
            return (
              <section key={s} className="board-col" aria-labelledby={`col-${s}`}>
                <h3 id={`col-${s}`}>{title}<span className="muted">{col.length}</span></h3>
                {col.map((t) => (
                  <article key={t.id} className="board-card">
                    <Link to={`/tasks/${t.id}`}><strong>{t.title}</strong></Link>
                    <div className="row" style={{ margin: '6px 0', gap: 6 }}><CompanyBadge code={t.company_code} name={t.company_name} />{t.overdue && <Status s="action" text="Overdue" />}</div>
                    <div className="muted small">{t.owner_name ?? 'Unassigned'} · {fmtDate(t.due_on)}</div>
                    <div className="row" style={{ marginTop: 8, gap: 6 }}>
                      {i > 0 && <Button variant="ghost" disabled={move.busy} onClick={() => move.run(t, STATUSES[i - 1][0])} aria-label={`Move ${t.title} back to ${STATUSES[i - 1][1]}`}>‹ Back</Button>}
                      {i < STATUSES.length - 1 && <Button variant="ghost" disabled={move.busy} onClick={() => move.run(t, STATUSES[i + 1][0])} aria-label={`Move ${t.title} to ${STATUSES[i + 1][1]}`}>Next ›</Button>}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      ) : view === 'calendar' ? <TaskCalendar rows={rows} /> : (
        <div className="grid-2">
          {Object.entries(rows.reduce((g: Record<string, any[]>, t) => { (g[t.property_name ?? 'No property'] ??= []).push(t); return g; }, {})).map(([p, ts]) => (
            <section key={p} className="card"><h3>{p}</h3><ul className="list">{ts.map((t) => <li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link><Status s={t.status} /></li>)}</ul></section>
          ))}
        </div>
      )}
      {creating && <NewTask onClose={() => { params.delete('new'); setParams(params); }} onSaved={() => { params.delete('new'); setParams(params); list.reload(); }} />}
    </>
  );
}

function TaskCalendar({ rows }: { rows: any[] }) {
  const [month, setMonth] = useState(londonToday().slice(0, 7));
  const first = `${month}-01`;
  const start = weekStart(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const mLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${first}T12:00Z`));
  const undated = rows.filter((t) => !t.due_on);
  return (
    <section aria-labelledby="cal-h">
      <div className="row" style={{ marginBottom: 12 }}>
        <Button variant="secondary" onClick={() => setMonth(addDays(`${month}-15`, -30).slice(0, 7))}>‹ Previous</Button>
        <h2 id="cal-h" style={{ margin: 0 }} aria-live="polite">{mLabel}</h2>
        <Button variant="secondary" onClick={() => setMonth(addDays(`${month}-15`, 30).slice(0, 7))}>Next ›</Button>
      </div>
      <div className="cal hide-mobile" aria-hidden="true">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="head">{d}</div>)}
        {days.map((d) => <div key={d} className={d.startsWith(month) ? '' : 'out'}><strong>{Number(d.slice(8))}</strong>{rows.filter((t) => t.due_on === d).map((t) => <div key={t.id}><Link to={`/tasks/${t.id}`} tabIndex={-1}>{t.title}</Link></div>)}</div>)}
      </div>
      {/* The accessible equivalent (and the mobile view): a list by due date */}
      <ul className="list card" style={{ marginTop: 16 }} aria-label={`Tasks due in ${mLabel}`}>
        {rows.filter((t) => t.due_on?.startsWith(month)).sort((a, b) => a.due_on.localeCompare(b.due_on)).map((t) => <li key={t.id}><span>{fmtDate(t.due_on)} — <Link to={`/tasks/${t.id}`}>{t.title}</Link></span><Status s={t.status} /></li>)}
        {undated.length > 0 && <li className="muted">{undated.length} task(s) have no due date.</li>}
      </ul>
    </section>
  );
}

function NewTask({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const [params] = useSearchParams();
  const toast = useToast();
  const [f, setF] = useState<any>({ company_id: params.get('company') ?? (hub.company !== 'all' ? hub.company : hub.me.companies.length === 1 ? hub.me.companies[0].id : ''), property_id: params.get('property') ?? '', title: '', description: '', owner_id: '', reviewer_id: '', due_on: '', priority: 'normal', recurrence: 'none', checklist: '' });
  const manage = f.company_id && hub.can('tasks.manage', f.company_id);
  const people = useApi<any[]>(manage ? `/people?company=${f.company_id}` : null);
  const props = useApi<any[]>(f.company_id ? `/properties?company=${f.company_id}` : null);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    if (!f.company_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { company_id: 'Choose the company' } });
    await post('/tasks', { company_id: f.company_id, property_id: f.property_id || null, title: f.title, description: f.description || null, owner_id: f.owner_id || null, reviewer_id: f.reviewer_id || null, due_on: f.due_on || null, priority: f.priority, recurrence: f.recurrence,
      checklist: f.checklist.split('\n').map((s: string) => s.trim()).filter(Boolean).map((text: string) => ({ text, done: false })) });
    toast('Task created.');
    onSaved();
  });
  const e = save.error?.fields ?? {};
  const active = (people.data ?? []).filter((p) => p.appointments.some((a: any) => a.company_id === f.company_id && a.status === 'active'));
  return (
    <Dialog open onClose={onClose} title="New task" footer={<Button busy={save.busy} onClick={() => save.run()}>Create task</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Company" error={e.company_id} hint="The task is saved under this company."><select name="company_id" value={f.company_id} onChange={(ev) => setF({ ...f, company_id: ev.target.value, property_id: '', owner_id: '', reviewer_id: '' })}><option value="">Choose…</option>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Title" error={e.title}><input name="title" value={f.title} onChange={set('title')} /></Field>
      <Field label="Details" optional><textarea name="description" value={f.description} onChange={set('description')} /></Field>
      <Field label="Property" optional><select name="property_id" value={f.property_id} onChange={set('property_id')}><option value="">None</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ref})</option>)}</select></Field>
      {manage ? (
        <div className="form-grid">
          <Field label="Owner" hint="Defaults to you" error={e.owner_id}><select name="owner_id" value={f.owner_id} onChange={set('owner_id')}><option value="">Me</option>{active.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Reviewer" optional><select name="reviewer_id" value={f.reviewer_id} onChange={set('reviewer_id')}><option value="">No reviewer</option>{active.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
        </div>
      ) : <p className="small muted">You can create tasks for yourself. Managers can assign tasks to others.</p>}
      <div className="form-grid">
        <Field label="Due date" optional error={e.due_on}><input name="due_on" type="date" value={f.due_on} onChange={set('due_on')} /></Field>
        <Field label="Priority"><select name="priority" value={f.priority} onChange={set('priority')}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
        <Field label="Repeats"><select name="recurrence" value={f.recurrence} onChange={set('recurrence')}>{['none', 'daily', 'weekly', 'monthly'].map((p) => <option key={p} value={p}>{p === 'none' ? 'Does not repeat' : label(p)}</option>)}</select></Field>
      </div>
      <Field label="Checklist" optional hint="One item per line."><textarea name="checklist" value={f.checklist} onChange={set('checklist')} /></Field>
    </Dialog>
  );
}

export function TaskPage() {
  const { id } = useParams();
  const d = useApi<any>(`/tasks/${id}`);
  const toast = useToast();
  const nav = useNavigate();
  const [comment, setComment] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [returning, setReturning] = useState(false);
  const update = useSubmit(async (body: any, msg: string) => {
    await patch(`/tasks/${id}`, { ...body, expected_updated_at: d.data.task.updated_at });
    toast(msg); setComment(''); setReturning(false); d.reload();
  });
  const addComment = useSubmit(async () => { await post(`/tasks/${id}/comments`, { body: comment }); setComment(''); d.reload(); });
  const addFile = useSubmit(async (file: File) => { setProgress(0); try { await upload(`/tasks/${id}/files`, file, file.name, setProgress); toast('Evidence uploaded.'); d.reload(); } finally { setProgress(null); } });

  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { task: t, comments, files, can } = d.data;
  const toggle = (i: number) => update.run({ checklist: t.checklist.map((c: any, j: number) => (j === i ? { ...c, done: !c.done } : c)) }, 'Checklist updated.');
  const done = t.checklist.filter((c: any) => c.done).length;

  return (
    <>
      <PageHead title={t.title} crumbs={[['Tasks', '/tasks'], [t.title]]} intro={<><CompanyBadge code={t.company_code} name={t.company_name} /> {t.company_name}{t.property_name && ` · ${t.property_name}`}</>} actions={<Status s={t.status} />} />
      <ErrorSummary error={update.error} />
      <div className="grid-2">
        <section className="card" aria-labelledby="t-h">
          <h2 id="t-h">About this task</h2>
          <dl className="facts">
            <dt>Owner</dt><dd>{t.owner_name ?? 'Unassigned'}</dd>
            <dt>Reviewer</dt><dd>{t.reviewer_name ?? 'None — the owner completes it'}</dd>
            <dt>Due</dt><dd>{fmtDate(t.due_on)}</dd>
            <dt>Priority</dt><dd><Status s={t.priority} /></dd>
            <dt>Repeats</dt><dd>{t.recurrence === 'none' ? 'No' : label(t.recurrence)}</dd>
            <dt>Created by</dt><dd>{t.created_by_name}</dd>
          </dl>
          {t.description && <p style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>{t.description}</p>}
          <h3 style={{ marginTop: 24 }}>What happens next</h3>
          <div className="row">
            {can.work && t.status === 'not_started' && <Button busy={update.busy} onClick={() => update.run({ status: 'in_progress' }, 'Task started.')}>Start task</Button>}
            {can.work && ['in_progress', 'changes_requested'].includes(t.status) && (t.reviewer_id ? <Button variant="go" busy={update.busy} onClick={() => update.run({ status: 'submitted' }, 'Sent for review.')}>Submit for review</Button> : <Button variant="go" busy={update.busy} onClick={() => update.run({ status: 'completed' }, 'Task completed.')}>Mark completed</Button>)}
            {can.review && t.status === 'submitted' && <><Button variant="go" busy={update.busy} onClick={() => update.run({ status: 'completed' }, 'Task completed.')}>Approve and complete</Button><Button variant="secondary" onClick={() => setReturning(true)}>Request changes</Button></>}
            {t.status === 'completed' && <p className="muted">Completed {fmtDateTime(t.completed_at)}.</p>}
          </div>
        </section>
        <section className="card" aria-labelledby="cl-h">
          <h2 id="cl-h">Checklist {t.checklist.length > 0 && <span className="muted small">({done} of {t.checklist.length} done)</span>}</h2>
          {t.checklist.length === 0 ? <p className="muted">No checklist.</p> : (
            <ul className="list">{t.checklist.map((c: any, i: number) => (
              <li key={i}><label className="check"><input type="checkbox" checked={c.done} disabled={!can.work || update.busy || t.status === 'completed'} onChange={() => toggle(i)} /> {c.text}</label></li>
            ))}</ul>
          )}
          <h3 style={{ marginTop: 24 }}>Evidence</h3>
          {files.length === 0 ? <p className="muted">No files yet.</p> : <ul className="list">{files.map((f: any) => <li key={f.id}><button type="button" className="btn ghost" onClick={() => download(`/files/${f.id}`, f.original_name)}>{f.original_name}</button><span className="muted small">{f.uploaded_by_name}, {fmtDate(f.uploaded_at)}</span></li>)}</ul>}
          {(can.work || can.manage) && t.status !== 'completed' && (
            <div style={{ marginTop: 12 }}>
              <FilePicker label="Add photos or PDFs" hint="JPEG, PNG, WebP or PDF, up to 10 MB each. Do not photograph residents or their belongings." accept="image/jpeg,image/png,image/webp,application/pdf" multiple instant busy={progress !== null} progress={progress} buttonText="Choose photos or files" onChange={async (fs) => { for (const f of fs) await addFile.run(f); }} />
              <ErrorSummary error={addFile.error} />
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="c-h">
          <h2 id="c-h">Comments</h2>
          {comments.length === 0 ? <p className="muted">No comments yet.</p> : <ul className="list">{comments.map((c: any) => <li key={c.id}><div><strong>{c.author_name}</strong> <span className="muted small">{fmtDateTime(c.created_at)}</span><p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{c.body}</p></div></li>)}</ul>}
          <form noValidate onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.run(); }}>
            <ErrorSummary error={addComment.error} />
            <Field label="Add a comment" hint="Work matters only. Raise personal or confidential concerns privately with HR."><textarea name="body" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <Button type="submit" variant="secondary" busy={addComment.busy} disabled={!comment.trim()}>Post comment</Button>
          </form>
        </section>
      </div>
      <Dialog open={returning} onClose={() => setReturning(false)} title="Request changes" variant="modal" footer={<Button busy={update.busy} disabled={!comment.trim()} onClick={() => update.run({ status: 'changes_requested', comment }, 'Changes requested.')}>Send back</Button>}>
        <Field label="What needs to change?"><textarea name="comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Dialog>
      <p><Button variant="ghost" onClick={() => nav(-1)}>‹ Back</Button></p>
    </>
  );
}
