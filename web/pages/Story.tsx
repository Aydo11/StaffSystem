import { useState } from 'react';
import { api, post, put, upload, useApi, useSubmit } from '../api.ts';
import { AuthImage, Button, Chips, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, Skeleton, useToast } from '../ui.tsx';

const WHO: [string, string][] = [['private', 'Only me'], ['managers', 'Managers and HR'], ['colleagues', 'Colleagues']];
const PROMPTS = ['Where I come from', 'What shaped me', 'Why I do this work', 'Challenges I have overcome', 'My proudest moment', 'What I bring to my role'];

// A person's life story as a small book: read one chapter at a time, written only by them.
export function StoryTab({ personId, name, isMe }: { personId: string; name: string; isMe: boolean }) {
  const d = useApi<any>(`/people/${personId}/story`);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={6} />;
  if (!d.data.shared) return <Empty>{name} has not shared their story with you.</Empty>;
  const { chapters, can_edit } = d.data;
  return (
    <>
      {can_edit && (
        <div className="row between" style={{ marginBottom: 16 }}>
          <Chips label="Story view" value={mode} onChange={setMode} options={[['read', 'Read'], ['edit', 'Write and arrange']]} />
          <span className="small muted">Who can read it: <strong>{WHO.find(([k]) => k === d.data.visibility)?.[1]}</strong></span>
        </div>
      )}
      {mode === 'edit' && can_edit ? <StoryEditor personId={personId} data={d.data} reload={d.reload} />
        : chapters.length === 0 ? (
          <div className="card story-empty">
            <Icon name="file" size={36} />
            <h2>{isMe ? 'Tell your story' : `${name} has not written their story yet`}</h2>
            {isMe && <><p>Share the experiences, values and journey that make you good at what you do. Write as much or as little as you like, one chapter at a time, and choose who can read it.</p>
              <Button onClick={() => setMode('edit')}>Start writing</Button></>}
          </div>
        ) : <StoryBook name={name} intro={d.data.intro} chapters={chapters} />}
    </>
  );
}

function StoryBook({ name, intro, chapters }: { name: string; intro: string | null; chapters: any[] }) {
  const [page, setPage] = useState(-1); // -1 = cover
  const [dir, setDir] = useState<'next' | 'prev'>('next');
  const go = (p: number) => { setDir(p > page ? 'next' : 'prev'); setPage(p); };
  const c = chapters[page];
  return (
    <div className="story">
      <nav className="story-contents card" aria-label="Chapters">
        <h2 className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Contents</h2>
        <ol>
          <li><button type="button" aria-current={page === -1 ? 'page' : undefined} onClick={() => go(-1)}>Introduction</button></li>
          {chapters.map((ch, i) => <li key={ch.id}><button type="button" aria-current={page === i ? 'page' : undefined} onClick={() => go(i)}><span className="muted">{i + 1}.</span> {ch.title}</button></li>)}
        </ol>
      </nav>
      <article className={`story-page card turn-${dir}`} key={page} aria-live="polite">
        {page === -1 ? (
          <div className="story-cover">
            <span className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>The story of</span>
            <h2>{name}</h2>
            {intro && <p className="story-intro">{intro}</p>}
            <p className="muted small">{chapters.length} chapter{chapters.length === 1 ? '' : 's'}</p>
            <Button onClick={() => go(0)}>Begin reading <Icon name="play" size={16} /></Button>
          </div>
        ) : (
          <>
            <span className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Chapter {page + 1}{c.period && ` · ${c.period}`}</span>
            <h2 className="story-title">{c.title}</h2>
            {c.photo_file_id && <AuthImage url={`/files/${c.photo_file_id}`} alt={`Photo for ${c.title}`} className="story-photo" />}
            <div className="story-body">{c.body.split(/\n{2,}/).map((para: string, i: number) => <p key={i}>{para}</p>)}</div>
          </>
        )}
        <div className="story-nav">
          <Button variant="secondary" disabled={page === -1} onClick={() => go(page - 1)}><Icon name="back" size={16} />Previous</Button>
          <span className="small muted">{page === -1 ? 'Introduction' : `${page + 1} of ${chapters.length}`}</span>
          <Button variant="secondary" disabled={page === chapters.length - 1} onClick={() => go(page + 1)}>Next</Button>
        </div>
      </article>
    </div>
  );
}

function StoryEditor({ personId, data, reload }: { personId: string; data: any; reload: () => void }) {
  const toast = useToast();
  const base = `/people/${personId}/story`;
  const [settings, setSettings] = useState({ visibility: data.visibility, intro: data.intro ?? '' });
  const [edit, setEdit] = useState<any>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const chapters: any[] = data.chapters;
  const saveSettings = useSubmit(async () => { await put(base, { visibility: settings.visibility, intro: settings.intro || null }); toast('Story settings saved.'); reload(); });
  const save = useSubmit(async () => {
    const b = { title: edit.title, period: edit.period || null, body: edit.body };
    const c = edit.id ? await api('PATCH', `${base}/chapters/${edit.id}`, b) : await post(`${base}/chapters`, b);
    if (edit.photo) { setProgress(0); try { await upload(`${base}/chapters/${c.id}/photo`, edit.photo, edit.photo.name, setProgress); } finally { setProgress(null); } }
    setEdit(null); toast(edit.id ? 'Chapter saved.' : 'Chapter added.'); reload();
  });
  const remove = useSubmit(async (c: any) => { await api('DELETE', `${base}/chapters/${c.id}`); toast('Chapter removed.'); reload(); });
  const move = useSubmit(async (i: number, by: number) => {
    const ids = chapters.map((c) => c.id); [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    await post(`${base}/order`, { ids }); reload();
  });
  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="ss-h">
        <h2 id="ss-h">About your story</h2>
        <ErrorSummary error={saveSettings.error} />
        <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Who can read it?</legend>
          <Chips label="Who can read it" value={settings.visibility} onChange={(v) => setSettings({ ...settings, visibility: v })} options={WHO} />
          <span className="hint" style={{ marginTop: 8 }}>Only share what you are comfortable with. You can change this at any time, and nobody else can edit your story.</span>
        </fieldset>
        <Field label="Introduction" optional hint="A sentence or two on the cover, e.g. why you came into this work."><textarea name="intro" maxLength={1000} value={settings.intro} onChange={(e) => setSettings({ ...settings, intro: e.target.value })} /></Field>
        <Button busy={saveSettings.busy} onClick={() => saveSettings.run()}>Save</Button>
      </section>
      <section className="card" aria-labelledby="sc-h">
        <div className="row between"><h2 id="sc-h" style={{ margin: 0 }}>Chapters</h2><Button onClick={() => setEdit({ title: '', period: '', body: '' })}><Icon name="plus" size={18} />Add a chapter</Button></div>
        <ErrorSummary error={remove.error ?? move.error} />
        {chapters.length === 0 ? <div style={{ marginTop: 12 }}><p className="muted">Not sure where to start? Pick a chapter idea:</p><div className="chips">{PROMPTS.map((t) => <button key={t} type="button" className="chip" onClick={() => setEdit({ title: t, period: '', body: '' })}>{t}</button>)}</div></div> : (
          <ol className="list story-list">{chapters.map((c, i) => (
            <li key={c.id}>
              <span><strong>{i + 1}. {c.title}</strong>{c.period && <span className="muted small"> · {c.period}</span>}<br /><span className="small muted">{c.body.slice(0, 90)}{c.body.length > 90 ? '…' : ''}</span></span>
              <span className="row" style={{ gap: 4 }}>
                <Button variant="ghost" disabled={i === 0 || move.busy} onClick={() => move.run(i, -1)} aria-label={`Move ${c.title} up`}>↑</Button>
                <Button variant="ghost" disabled={i === chapters.length - 1 || move.busy} onClick={() => move.run(i, 1)} aria-label={`Move ${c.title} down`}>↓</Button>
                <Button variant="secondary" onClick={() => setEdit({ ...c, period: c.period ?? '' })}>Edit</Button>
                <Button variant="ghost" busy={remove.busy} onClick={() => remove.run(c)} aria-label={`Remove ${c.title}`}>Remove</Button>
              </span>
            </li>
          ))}</ol>
        )}
      </section>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit chapter' : 'New chapter'} footer={<Button busy={save.busy} busyText={progress !== null ? `Uploading… ${progress}%` : 'Saving…'} onClick={() => save.run()}>Save chapter</Button>}>
        {edit && <>
          <ErrorSummary error={save.error} />
          <Field label="Chapter title" error={save.error?.fields.title}><input name="title" maxLength={120} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <Field label="When" optional hint="For example “2015 – 2019” or “Growing up”."><input name="period" maxLength={60} value={edit.period} onChange={(e) => setEdit({ ...edit, period: e.target.value })} /></Field>
          <Field label="Your words" error={save.error?.fields.body} hint="Leave a blank line between paragraphs. Do not include anything about residents or other people’s private lives."><textarea name="body" rows={10} maxLength={8000} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
          <FilePicker label={edit.photo_file_id ? 'Replace the photo' : 'A photo for this chapter'} hint="Optional. JPEG, PNG or WebP." accept="image/jpeg,image/png,image/webp" onChange={(fs) => setEdit({ ...edit, photo: fs[0] ?? null })} />
        </>}
      </Dialog>
    </div>
  );
}
