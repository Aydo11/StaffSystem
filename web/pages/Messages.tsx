import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, blobUrl, download, get, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, fmtDay, fmtTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { AuthImage, Avatar, Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

const ADMIN_NOTE = 'Administrators cannot read your conversations. If someone reports a message, a company administrator sees that message only, and that access is recorded.';

// ── Chat: conversation list beside the open conversation (one or the other on a phone) ──
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '✅']; // must match the server's list
const EMOJIS = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😍', '🥰', '😎', '🤔', '😐', '😴', '😮', '😢', '😭', '😡', '🙏', '👍', '👎', '👏', '🙌', '💪', '👋', '🤝', '❤️', '💙', '💚', '🔥', '⭐', '✨', '🎉', '🎂', '☕', '🍕', '🏠', '🔑', '🧹', '🛠️', '🚗', '📅', '⏰', '✅', '❌', '⚠️', '📷', '📎'];

export function Messages() { return <ChatShell />; }
export function Conversation() { const { id } = useParams(); return <ChatShell openId={id} />; }

function chatName(c: any, meId: string) {
  return c.kind === 'direct' ? c.members.filter((m: any) => m.id !== meId).map((m: any) => m.name).join(', ') || 'Direct message' : c.title ?? 'Group';
}
function ChatAvatar({ c, meId }: { c: any; meId: string }) {
  const others = c.members.filter((m: any) => m.id !== meId);
  if (c.kind === 'direct' && others[0]) return <Avatar personId={others[0].id} name={others[0].name} hasPhoto={others[0].has_photo} />;
  return <span className="avatar group-avatar" aria-hidden="true">{(c.title ?? '?').split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}</span>;
}

function ChatShell({ openId }: { openId?: string }) {
  const hub = useHub();
  const meId = hub.me.person.id;
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reports' && hub.can('messaging.moderate') ? 'reports' : 'chats';
  const list = useApi<any[]>('/conversations');
  const [creating, setCreating] = useState(false);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  useEffect(() => { const t = setInterval(() => list.reload(), 8000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (term.trim().length < 2) { setHits(null); return; } const t = setTimeout(() => get<any[]>(`/messages/search?q=${encodeURIComponent(term)}`).then(setHits).catch(() => setHits([])), 300); return () => clearTimeout(t); }, [term]);
  const shown = (list.data ?? []).filter((c) => !term.trim() || chatName(c, meId).toLowerCase().includes(term.trim().toLowerCase()));
  return (
    <>
      <PageHead title="Chat" intro={ADMIN_NOTE} actions={<Button onClick={() => setCreating(true)}><Icon name="plus" size={18} />New chat</Button>} />
      {hub.can('messaging.moderate') && <Tabs label="Message sections" tabs={[['chats', 'Chats'], ['reports', 'Reported messages']]} value={tab} onChange={(t) => setParams(t === 'chats' ? {} : { tab: t })} />}
      {tab === 'reports' ? <Reports /> : (
        <div className={`chat${openId ? ' has-open' : ''}`}>
          <aside className="chat-list card" aria-label="Conversations">
            <div className="field" style={{ margin: 0 }}><label htmlFor="msg-q" className="sr-only">Search chats and messages</label><input id="msg-q" type="search" placeholder="Search chats and messages" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
            {!hub.me.person.photo_path && <p className="small chat-nudge"><Icon name="camera" size={16} /> <Link to="/profile">Add a profile photo</Link> so colleagues recognise you.</p>}
            {hits && hits.length > 0 && <div className="small" aria-live="polite"><strong>Messages</strong><ul className="chat-hits">{hits.map((h) => <li key={h.id}><Link to={`/messages/${h.conversation_id}`}>{h.author_name}: {h.body}</Link></li>)}</ul></div>}
            {list.loading && !list.data ? <Skeleton /> : shown.length === 0 ? <Empty>{term ? 'No chats match.' : 'No chats yet. Start one with New chat.'}</Empty> : (
              <ul className="chat-items">{shown.map((c) => (
                <li key={c.id}>
                  <Link to={`/messages/${c.id}`} className="chat-item" aria-current={c.id === openId ? 'page' : undefined}>
                    <ChatAvatar c={c} meId={meId} />
                    <span className="chat-item-text">
                      <span className="row between" style={{ gap: 8, flexWrap: 'nowrap' }}><strong className="truncate">{chatName(c, meId)}</strong>{c.last && <span className="small muted" style={{ flex: 'none' }}>{fmtDay(c.last.at) === fmtDay(new Date().toISOString()) ? fmtTime(c.last.at) : fmtDate(c.last.at)}</span>}</span>
                      <span className="row between" style={{ gap: 8, flexWrap: 'nowrap' }}><span className="small muted truncate">{c.last ? `${c.last.author}: ${c.last.body}` : c.kind === 'direct' ? 'Say hello' : `${c.members.length} members`}</span>{c.unread > 0 && <span className="unread" aria-label={`${c.unread} unread`}>{c.unread}</span>}</span>
                    </span>
                  </Link>
                </li>
              ))}</ul>
            )}
          </aside>
          <section className="chat-pane card" aria-label="Conversation">
            {openId ? <ChatThread key={openId} id={openId} onActivity={list.reload} /> : <div className="chat-empty"><Icon name="note" size={36} /><p>Choose a chat, or start a new one with a colleague or a group.</p><Button onClick={() => setCreating(true)}>New chat</Button></div>}
          </section>
        </div>
      )}
      {creating && <NewConversation onClose={() => setCreating(false)} />}
    </>
  );
}

function ChatThread({ id, onActivity }: { id: string; onActivity: () => void }) {
  const hub = useHub();
  const meId = hub.me.person.id;
  const toast = useToast();
  const d = useApi<any>(`/conversations/${id}/messages`);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const requestId = useRef(crypto.randomUUID());
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const people = useApi<any[]>(adding && d.data ? `/people?company=${d.data.conversation.company_id}` : null);
  useEffect(() => { const t = setInterval(() => d.reload(), 4000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Stay at the bottom when new messages arrive, unless the reader has scrolled up to read history.
  const count = d.data?.messages.length ?? 0;
  const nearBottom = useRef(true);
  useEffect(() => { const el = scroller.current; if (el && nearBottom.current) el.scrollTop = el.scrollHeight; }, [count]);
  useEffect(() => { if (!file || !file.type.startsWith('image/')) { setPreview(null); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);

  const send = useSubmit(async () => {
    await upload(`/conversations/${id}/messages`, file, file?.name ?? '', undefined, { body: body.trim(), client_request_id: requestId.current });
    requestId.current = crypto.randomUUID(); setBody(''); setFile(null); setEmoji(false); nearBottom.current = true;
    await d.reload(); onActivity(); hub.reloadMe();
  });
  const react = useSubmit(async (mid: string, e: string) => { setReactFor(null); await post(`/messages/${mid}/reactions`, { emoji: e }); d.reload(); });
  const doReport = useSubmit(async () => { await post(`/messages/${report.id}/report`, { reason: report.reason }); setReport(null); toast('Reported. A company administrator will look at this message.'); });
  const leave = useSubmit(async () => { await post(`/conversations/${id}/leave`); location.assign('/messages'); });
  const add = useSubmit(async (pid: string) => { await post(`/conversations/${id}/members`, { person_id: pid }); toast('Added to the group.'); d.reload(); onActivity(); });
  const insert = (e: string) => {
    const el = input.current; const at = el?.selectionStart ?? body.length;
    setBody(body.slice(0, at) + e + body.slice(el?.selectionEnd ?? at));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + e.length, at + e.length); });
  };
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { conversation: c, members, messages } = d.data;
  const others = members.filter((m: any) => m.id !== meId);
  const title = c.kind === 'direct' ? others.map((m: any) => m.name).join(', ') || 'Direct message' : c.title;
  const group = c.kind !== 'direct';
  const canSend = (body.trim().length > 0 || !!file) && !send.busy;

  return (
    <div className="thread">
      <header className="thread-head">
        <Link to="/messages" className="btn ghost icon-btn hide-desktop" aria-label="Back to chats"><Icon name="back" /></Link>
        <ChatAvatar c={{ ...c, members }} meId={meId} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="truncate" style={{ margin: 0, fontSize: '1.125rem' }}>{title}</h2>
          <span className="small muted truncate" style={{ display: 'block' }}><CompanyBadge code={c.company_code} /> {group ? members.map((m: any) => (m.id === meId ? 'You' : m.name)).join(', ') : label(c.kind) + ' message'}</span>
        </div>
        {group && <Button variant="secondary" onClick={() => setAdding(true)}><Icon name="users" size={18} />Add people</Button>}
        <Button variant="ghost" busy={leave.busy} onClick={() => leave.run()}>Leave</Button>
      </header>

      <div className="thread-body" ref={scroller} onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {messages.length === 0 ? <div className="chat-empty"><p>No messages yet. Say hello 👋</p></div> : (
          <ol className="bubbles" aria-label="Messages" aria-live="polite">
            {messages.map((m: any, i: number) => {
              const prev = messages[i - 1];
              const mine = m.author_id === meId;
              const newDay = !prev || fmtDate(prev.created_at) !== fmtDate(m.created_at);
              const startRun = newDay || prev.author_id !== m.author_id || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60_000;
              const image = m.file_id && m.file_type?.startsWith('image/');
              return (
                <li key={m.id} className={`bubble-row${mine ? ' mine' : ''}${startRun ? ' run-start' : ''}`}>
                  {newDay && <div className="day-sep" role="separator"><span>{fmtDate(m.created_at)}</span></div>}
                  <div className="bubble-line">
                    {!mine && <span className="bubble-avatar">{startRun && <Avatar personId={m.author_id} name={m.author_name} hasPhoto={m.author_has_photo} />}</span>}
                    <div className="bubble-col">
                      {!mine && startRun && group && <span className="bubble-author">{m.author_name}</span>}
                      <div className={`bubble${image && !m.body ? ' photo-only' : ''}`}>
                        <span className="sr-only">{mine ? 'You' : m.author_name}, {fmtTime(m.created_at)}: </span>
                        {image && <button type="button" className="bubble-img" onClick={() => setViewing(m)} aria-label={`Open photo ${m.file_name}`}><AuthImage url={`/files/${m.file_id}`} alt="" /></button>}
                        {m.file_id && !image && <button type="button" className="bubble-file" onClick={() => download(`/files/${m.file_id}`, m.file_name)}><Icon name="file" size={18} />{m.file_name}</button>}
                        {m.body && <p>{m.body}</p>}
                        <span className="bubble-time" aria-hidden="true">{fmtTime(m.created_at)}</span>
                      </div>
                      {m.reactions.length > 0 && (
                        <div className="reactions">{m.reactions.map((r: any) => (
                          <button key={r.emoji} type="button" className={`reaction${r.mine ? ' mine' : ''}`} aria-pressed={r.mine} onClick={() => react.run(m.id, r.emoji)} aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}>{r.emoji} {r.count}</button>
                        ))}</div>
                      )}
                    </div>
                    <div className="bubble-tools">
                      <button type="button" className="btn ghost icon-btn" aria-label="React" aria-expanded={reactFor === m.id} onClick={() => setReactFor(reactFor === m.id ? null : m.id)}><Icon name="smile" size={18} /></button>
                      {reactFor === m.id && (
                        <div className="react-bar" role="group" aria-label="Choose a reaction">
                          {REACTIONS.map((e) => <button key={e} type="button" onClick={() => react.run(m.id, e)} aria-label={`React ${e}`}>{e}</button>)}
                          {!mine && <button type="button" className="small" onClick={() => { setReactFor(null); setReport({ id: m.id, reason: '' }); }}>Report</button>}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <form className="composer" noValidate onSubmit={(e) => { e.preventDefault(); if (canSend) send.run(); }}>
        <ErrorSummary error={send.error ?? react.error} />
        {file && (
          <div className="attach-preview">
            {preview ? <img src={preview} alt="" /> : <span className="picked-icon"><Icon name="file" /></span>}
            <span className="small truncate" style={{ flex: 1 }}>{file.name}</span>
            <button type="button" className="btn ghost icon-btn" onClick={() => setFile(null)} aria-label={`Remove ${file.name}`}><Icon name="x" size={18} /></button>
          </div>
        )}
        {emoji && <div className="emoji-grid" role="group" aria-label="Emoji">{EMOJIS.map((e) => <button key={e} type="button" onClick={() => insert(e)} aria-label={`Insert ${e}`}>{e}</button>)}</div>}
        <div className="composer-row">
          <label className="btn ghost icon-btn" title="Attach a photo or PDF">
            <Icon name="paperclip" /><span className="sr-only">Attach a photo or PDF</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          </label>
          <button type="button" className="btn ghost icon-btn" aria-label="Emoji" aria-expanded={emoji} onClick={() => setEmoji(!emoji)}><Icon name="smile" /></button>
          <label htmlFor="chat-input" className="sr-only">Message</label>
          <textarea id="chat-input" ref={input} rows={1} value={body} placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => { setBody(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) send.run(); } }}
            onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); setFile(f); } }} />
          <Button type="submit" className="send-btn" busy={send.busy} busyText="" disabled={!canSend} aria-label="Send"><Icon name="send" size={18} /></Button>
        </div>
        <p className="small muted" style={{ margin: '4px 0 0' }}>Do not share resident details here; use the support system for those.</p>
      </form>

      <Dialog open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `Photo from ${viewing.author_id === meId ? 'you' : viewing.author_name}` : 'Photo'} variant="modal"
        footer={viewing && <Button variant="secondary" onClick={() => download(`/files/${viewing.file_id}`, viewing.file_name)}>Download</Button>}>
        {viewing && <AuthImage url={`/files/${viewing.file_id}`} alt={viewing.file_name} className="photo-full" />}
      </Dialog>
      <Dialog open={!!report} onClose={() => setReport(null)} title="Report this message" variant="modal" footer={<Button busy={doReport.busy} onClick={() => doReport.run()}>Report</Button>}>
        <p>A company administrator will see this message (and only this message) and decide what to do.</p>
        <ErrorSummary error={doReport.error} /><Field label="Why are you reporting it?"><textarea name="reason" value={report?.reason ?? ''} onChange={(e) => setReport({ ...report, reason: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add people to this group" variant="modal">
        <ErrorSummary error={add.error} />
        <ul className="list">{(people.data ?? []).filter((p) => !members.some((m: any) => m.id === p.id)).map((p) => (
          <li key={p.id}><span className="row"><Avatar personId={p.id} name={p.full_name} hasPhoto={p.has_photo} />{p.full_name}</span><Button variant="secondary" disabled={add.busy} onClick={() => add.run(p.id)}>Add</Button></li>
        ))}</ul>
      </Dialog>
    </div>
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
    <Dialog open onClose={onClose} title="New chat" footer={<Button busy={create.busy} onClick={() => create.run()}>Start chat</Button>}>
      <ErrorSummary error={create.error} />
      <Field label="Company"><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, member_ids: [] })}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Type</legend><Chips label="Type" value={f.kind} onChange={(v) => setF({ ...f, kind: v, member_ids: v === 'direct' ? f.member_ids.slice(0, 1) : f.member_ids })} options={[['direct', 'One person'], ['team', 'Group'], ['property', 'Property group']]} /></fieldset>
      {f.kind === 'team' && <Field label="Group name" error={create.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>}
      {f.kind === 'property' && <Field label="Property"><select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">Choose…</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>{f.kind === 'direct' ? 'Who?' : 'Members'}</legend>
        <ul className="pick-list">{current.map((p) => <li key={p.id}><label><input type={f.kind === 'direct' ? 'radio' : 'checkbox'} name="members" checked={f.member_ids.includes(p.id)} onChange={(e) => setF({ ...f, member_ids: f.kind === 'direct' ? [p.id] : e.target.checked ? [...f.member_ids, p.id] : f.member_ids.filter((x: string) => x !== p.id) })} /><Avatar personId={p.id} name={p.full_name} hasPhoto={p.has_photo} /><span className="grow">{p.preferred_name ?? p.full_name}</span></label></li>)}</ul>
      </fieldset>
    </Dialog>
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
