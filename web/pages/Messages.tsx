import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, blobUrl, download, get, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

const ADMIN_NOTE = 'Administrators cannot read your conversations. If someone reports a message, a company administrator sees that message only, and that access is recorded.';

export function Messages() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reports' && hub.can('messaging.moderate') ? 'reports' : 'chats';
  const list = useApi<any[]>('/conversations');
  const [creating, setCreating] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  useEffect(() => { const t = setInterval(() => list.reload(), 20_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (term.trim().length < 2) { setHits(null); return; } const t = setTimeout(() => get<any[]>(`/messages/search?q=${encodeURIComponent(term)}`).then(setHits).catch(() => setHits([])), 300); return () => clearTimeout(t); }, [term]);
  return (
    <>
      <PageHead title="Messages" intro={ADMIN_NOTE} actions={<Button onClick={() => setCreating(true)}>New conversation</Button>} />
      {hub.can('messaging.moderate') && <Tabs label="Message sections" tabs={[['chats', 'Conversations'], ['reports', 'Reported messages']]} value={tab} onChange={(t) => setParams(t === 'chats' ? {} : { tab: t })} />}
      {tab === 'reports' ? <Reports /> : (
        <>
          <div className="field" style={{ maxWidth: 420 }}><label htmlFor="msg-q">Search your messages</label><input id="msg-q" type="search" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          {hits && <section className="card" aria-live="polite"><h2 style={{ fontSize: '1.125rem' }}>{hits.length} result{hits.length === 1 ? '' : 's'}</h2><ul className="list">{hits.map((h) => <li key={h.id}><span><Link to={`/messages/${h.conversation_id}`}>{h.title ?? 'Direct message'}</Link><br /><span className="small">{h.author_name}: {h.body}</span></span><span className="small muted">{fmtDateTime(h.created_at)}</span></li>)}</ul></section>}
          {list.loading && !list.data ? <Skeleton /> : (list.data ?? []).length === 0 ? <Empty>No conversations yet.</Empty> : (
            <ul className="list card">{list.data!.map((c) => {
              const others = c.members.filter((m: any) => m.id !== hub.me.person.id).map((m: any) => m.name).join(', ');
              return <li key={c.id}><span><Link to={`/messages/${c.id}`}><strong>{c.kind === 'direct' ? others : c.title}</strong></Link> <CompanyBadge code={c.company_code} name={c.company_name} />{c.kind !== 'direct' && <span className="small muted"> · {label(c.kind)} · {c.members.length} members</span>}
                {c.last && <><br /><span className="small muted">{c.last.author}: {c.last.body}</span></>}</span>
                {c.unread > 0 ? <span className="badge st-info">{c.unread} new</span> : c.last && <span className="small muted">{fmtDate(c.last.at)}</span>}</li>;
            })}</ul>
          )}
        </>
      )}
      {creating && <NewConversation onClose={() => setCreating(false)} />}
    </>
  );
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const [f, setF] = useState<any>({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies[0]?.id, kind: 'direct', title: '', property_id: '', member_ids: [] });
  const people = useApi<any[]>(f.company_id ? `/people?company=${f.company_id}` : null);
  const props = useApi<any[]>(f.kind === 'property' && f.company_id ? `/properties?company=${f.company_id}` : null);
  const create = useSubmit(async () => { const c = await post('/conversations', { ...f, title: f.title || null, property_id: f.property_id || null }); onClose(); location.assign(`/messages/${c.id}`); });
  const current = (people.data ?? []).filter((p) => p.id !== hub.me.person.id && p.appointments.some((a: any) => a.company_id === f.company_id && a.status === 'active'));
  return (
    <Dialog open onClose={onClose} title="New conversation" footer={<Button busy={create.busy} onClick={() => create.run()}>Start</Button>}>
      <ErrorSummary error={create.error} />
      <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, member_ids: [] })}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Type</legend><Chips label="Type" value={f.kind} onChange={(v) => setF({ ...f, kind: v, member_ids: v === 'direct' ? f.member_ids.slice(0, 1) : f.member_ids })} options={[['direct', 'One person'], ['team', 'Team'], ['property', 'Property']]} /></fieldset>
      {f.kind === 'team' && <Field label="Name" error={create.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>}
      {f.kind === 'property' && <Field label="Property"><select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">Choose…</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>{f.kind === 'direct' ? 'Who?' : 'Members'}</legend>
        {current.map((p) => <label key={p.id} className="check"><input type={f.kind === 'direct' ? 'radio' : 'checkbox'} name="members" checked={f.member_ids.includes(p.id)} onChange={(e) => setF({ ...f, member_ids: f.kind === 'direct' ? [p.id] : e.target.checked ? [...f.member_ids, p.id] : f.member_ids.filter((x: string) => x !== p.id) })} /> {p.full_name}</label>)}
      </fieldset>
    </Dialog>
  );
}

export function Conversation() {
  const { id } = useParams();
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any>(`/conversations/${id}/messages`);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pickerKey, setPickerKey] = useState(0); // remounts the picker to clear it after sending
  const [report, setReport] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const end = useRef<HTMLDivElement>(null);
  const people = useApi<any[]>(adding && d.data ? `/people?company=${d.data.conversation.company_id}` : null);
  useEffect(() => { const t = setInterval(() => d.reload(), 10_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [d.data?.messages.length]);
  const send = useSubmit(async () => {
    await upload(`/conversations/${id}/messages`, file, file?.name ?? '', undefined, { body, client_request_id: requestId.current });
    requestId.current = crypto.randomUUID(); setBody(''); setFile(null); setPickerKey((k) => k + 1); d.reload(); hub.reloadMe();
  });
  const doReport = useSubmit(async () => { await post(`/messages/${report.id}/report`, { reason: report.reason }); setReport(null); toast('Reported. A company administrator will look at this message.'); });
  const leave = useSubmit(async () => { await post(`/conversations/${id}/leave`); location.assign('/messages'); });
  const add = useSubmit(async (pid: string) => { await post(`/conversations/${id}/members`, { person_id: pid }); setAdding(false); toast('Added.'); });
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const c = d.data.conversation;
  return (
    <>
      <PageHead title={c.title ?? 'Direct message'} crumbs={[['Messages', '/messages'], [c.title ?? 'Conversation']]} intro={<><span className="badge co">{c.company_code}</span> {label(c.kind)} conversation. {ADMIN_NOTE}</>}
        actions={<>{c.kind !== 'direct' && <Button variant="secondary" onClick={() => setAdding(true)}>Add someone</Button>}<Button variant="ghost" busy={leave.busy} onClick={() => leave.run()}>Leave</Button></>} />
      <section className="card" aria-label="Messages" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {d.data.messages.length === 0 ? <Empty>No messages yet.</Empty> : <ol className="list" aria-live="polite">{d.data.messages.map((m: any) => (
          <li key={m.id}><div style={{ flex: 1 }}><strong>{m.author_id === hub.me.person.id ? 'You' : m.author_name}</strong> <span className="muted small">{fmtDateTime(m.created_at)}</span>
            <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{m.body}</p>
            {m.file_id && <button type="button" className="btn ghost" onClick={() => download(`/files/${m.file_id}`, m.file_name)}>{m.file_name}</button>}</div>
            {m.author_id !== hub.me.person.id && <Button variant="ghost" onClick={() => setReport({ id: m.id, reason: '' })}>Report<span className="sr-only"> message from {m.author_name}</span></Button>}</li>
        ))}</ol>}
        <div ref={end} />
      </section>
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.run(); }}>
        <ErrorSummary error={send.error} />
        <Field label="Message" hint="Do not share resident details here; use the support system for those."><textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <FilePicker key={pickerKey} label="Attach a file" accept="image/*,application/pdf" compact onChange={(fs) => setFile(fs[0] ?? null)} /><div className="row"><Button type="submit" busy={send.busy} busyText="Sending…" disabled={!body.trim()}>Send</Button></div>
      </form>
      <Dialog open={!!report} onClose={() => setReport(null)} title="Report this message" variant="modal" footer={<Button busy={doReport.busy} onClick={() => doReport.run()}>Report</Button>}>
        <p>A company administrator will see this message (and only this message) and decide what to do.</p>
        <ErrorSummary error={doReport.error} /><Field label="Why are you reporting it?"><textarea name="reason" value={report?.reason ?? ''} onChange={(e) => setReport({ ...report, reason: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add someone" variant="modal">
        <ErrorSummary error={add.error} />
        <ul className="list">{(people.data ?? []).filter((p) => p.id !== hub.me.person.id).map((p) => <li key={p.id}>{p.full_name}<Button variant="secondary" disabled={add.busy} onClick={() => add.run(p.id)}>Add</Button></li>)}</ul>
      </Dialog>
    </>
  );
}

function Reports() {
  const d = useApi<any[]>('/message-reports');
  const toast = useToast();
  const [f, setF] = useState<any>(null);
  const decide = useSubmit(async () => { await post(`/message-reports/${f.id}/decide`, { status: f.status, outcome: f.outcome }); setF(null); toast('Recorded.'); d.reload(); });
  return (
    <>
      <p className="muted">You see only the reported message, never the rest of the conversation. Opening this list is recorded.</p>
      {(d.data ?? []).length === 0 ? <Empty>No reported messages.</Empty> : <ul className="list card">{d.data!.map((r) => (
        <li key={r.id}><div><p style={{ margin: 0 }}>“{r.body}”</p><span className="small muted">By {r.author_name}, {fmtDateTime(r.message_at)} · reported by {r.reported_by_name}: {r.reason}</span>{r.outcome && <div className="small">Outcome: {r.outcome}</div>}</div>
          {r.status === 'open' ? <Button variant="secondary" onClick={() => setF({ id: r.id, status: 'actioned', outcome: '' })}>Decide</Button> : <Status s={r.status === 'actioned' ? 'verified' : 'ended'} text={label(r.status)} />}</li>
      ))}</ul>}
      <Dialog open={!!f} onClose={() => setF(null)} title="Decide on report" variant="modal" footer={<Button busy={decide.busy} onClick={() => decide.run()}>Save</Button>}>
        {f && <><ErrorSummary error={decide.error} /><Field label="Decision"><select name="status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="actioned">Action taken</option><option value="no_action">No action needed</option></select></Field>
          <Field label="What was done?"><textarea name="outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} /></Field></>}
      </Dialog>
    </>
  );
}

// ── News ──
function NewsImage({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let u: string | null = null; blobUrl(`/files/${id}`).then((x) => { u = x; setSrc(x); }); return () => { if (u) URL.revokeObjectURL(u); }; }, [id]);
  return src ? <img src={src} alt={alt} style={{ maxHeight: 280, borderRadius: 8, margin: '8px 0' }} /> : null;
}
export function News() {
  const hub = useHub();
  const toast = useToast();
  const d = useApi<any[]>(`/news${hub.q()}`);
  const [f, setF] = useState<any>(null);
  const cos = hub.me.companies.filter((c) => c.perms.includes('news.publish'));
  const save = useSubmit(async (publish: boolean) => {
    const body = { company_ids: f.company_ids, category: f.category, title: f.title, body: f.body, pinned: f.pinned };
    const n = f.id ? (await api('PATCH', `/news/${f.id}`, body)) : await post('/news', body);
    if (f.image) await upload(`/news/${n.id}/image`, f.image, f.image.name, undefined, { image_alt: f.image_alt });
    if (publish) await post(`/news/${n.id}/publish`);
    setF(null); toast(publish ? 'Published.' : 'Draft saved.'); d.reload();
  });
  const archive = useSubmit(async (nid: string) => { await post(`/news/${nid}/archive`); d.reload(); });
  return (
    <>
      <PageHead title="News" intro="Announcements for the companies you work with." actions={cos.length > 0 && <Button onClick={() => setF({ company_ids: [cos[0].id], category: 'announcement', title: '', body: '', pinned: false, image: null, image_alt: '' })}>Write a post</Button>} />
      {d.loading && !d.data ? <Skeleton /> : (d.data ?? []).length === 0 ? <Empty>No news yet.</Empty> : d.data!.map((n) => (
        <article key={n.id} className="card" aria-labelledby={`n-${n.id}`}>
          <div className="row between"><h2 id={`n-${n.id}`} style={{ fontSize: '1.25rem', margin: 0 }}>{n.pinned && <span className="badge st-info" style={{ marginRight: 8 }}>Pinned</span>}{n.title}</h2>{n.status === 'draft' && <Status s="planned" text="Draft" />}</div>
          <p className="small muted">{label(n.category)} · {n.company_codes.join(', ')} · {n.author_name}{n.published_at && `, ${fmtDate(n.published_at)}`}</p>
          {n.image_file_id && <NewsImage id={n.image_file_id} alt={n.image_alt} />}
          <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
          {n.company_ids.every((c: string) => hub.can('news.publish', c)) && <div className="row"><Button variant="ghost" onClick={() => setF({ ...n, image: null })}>Edit</Button>{n.status === 'published' && <Button variant="ghost" busy={archive.busy} onClick={() => archive.run(n.id)}>Archive</Button>}</div>}
        </article>
      ))}
      <Dialog open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit post' : 'Write a post'} footer={<><Button variant="secondary" busy={save.busy} onClick={() => save.run(false)}>Save draft</Button><Button busy={save.busy} onClick={() => save.run(true)}>Publish</Button></>}>
        {f && <><ErrorSummary error={save.error} />
          <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Who should see it?</legend>{cos.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={f.company_ids.includes(c.id)} onChange={(e) => setF({ ...f, company_ids: e.target.checked ? [...f.company_ids, c.id] : f.company_ids.filter((x: string) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
          <Field label="Category"><select name="category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['announcement', 'policy', 'training', 'celebration', 'operations', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
          <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Text" error={save.error?.fields.body}><textarea name="body" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <FilePicker label="Image" accept="image/jpeg,image/png,image/webp" onChange={(fs) => setF({ ...f, image: fs[0] ?? null })} />
          {f.image && <Field label="Describe the image" error={save.error?.fields._}><input name="image_alt" value={f.image_alt ?? ''} onChange={(e) => setF({ ...f, image_alt: e.target.value })} /></Field>}
          <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label></>}
      </Dialog>
    </>
  );
}

// Email preferences (shown on the Notifications page).
const CATS: [string, string][] = [['visit_reminder', 'Visit reminders'], ['training_due', 'Training due'], ['feedback_ready', 'Reviews and feedback ready'], ['invoice_available', 'Statements and invoices available']];
export function EmailPreferences() {
  const toast = useToast();
  const d = useApi<any>('/me/preferences');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (d.data) setF(d.data); }, [d.data]);
  const save = useSubmit(async () => { await api('PUT', '/me/preferences', f); toast('Preferences saved.'); });
  if (!f) return null;
  return (
    <section className="card" aria-labelledby="ep-h" style={{ marginTop: 16 }}>
      <h2 id="ep-h">Email reminders</h2>
      <p className="small muted">Emails only say that something is waiting and link to the Hub; they never contain personal details. Everything also appears here as an in-app notification, even if an email fails.</p>
      <label className="check"><input type="checkbox" checked={f.email_enabled} onChange={(e) => setF({ ...f, email_enabled: e.target.checked })} /> Send me email reminders</label>
      <fieldset disabled={!f.email_enabled} style={{ border: 0, padding: 0 }}><legend className="sr-only">Which reminders</legend>{CATS.map(([k, t]) => <label key={k} className="check"><input type="checkbox" checked={f.categories.includes(k)} onChange={(e) => setF({ ...f, categories: e.target.checked ? [...f.categories, k] : f.categories.filter((x: string) => x !== k) })} /> {t}</label>)}</fieldset>
      <ErrorSummary error={save.error} />
      <Button variant="secondary" busy={save.busy} onClick={() => save.run()}>Save preferences</Button>
    </section>
  );
}
