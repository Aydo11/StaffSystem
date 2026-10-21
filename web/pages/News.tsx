import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate } from '../format.ts';
import { useHub } from '../hub.tsx';
import { AuthImage, Avatar, Button, Chips, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, PageHead, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';

const CATS: [string, string][] = [['update', 'Updates'], ['announcement', 'Announcements'], ['training', 'Training'], ['celebration', 'Celebrations'], ['operations', 'Operations'], ['policy', 'Policy'], ['other', 'Other']];
const ONE: Record<string, string> = { update: 'Update', announcement: 'Announcement', training: 'Training', celebration: 'Celebration', operations: 'Operations', policy: 'Policy', other: 'News' };
const ICON: Record<string, string> = { update: 'bell', announcement: 'note', training: 'check', celebration: 'smile', operations: 'building', policy: 'file', other: 'note' };
const excerpt = (n: any) => n.summary || (n.body.length > 160 ? `${n.body.slice(0, 160).trimEnd()}…` : n.body);
const paras = (t: string) => t.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>);
const canEdit = (hub: ReturnType<typeof useHub>, n: any) => n.company_ids.every((c: string) => hub.can('news.publish', c));

// Cover photo, or a coloured panel for the category when there is none.
function Cover({ n, className }: { n: any; className: string }) {
  return n.image_file_id
    ? <AuthImage url={`/files/${n.image_file_id}`} alt={n.image_alt ?? ''} className={`${className} news-img`} />
    : <span className={`${className} news-ph cat-${n.category}`} aria-hidden="true"><Icon name={ICON[n.category] ?? 'note'} size={40} /></span>;
}
function Meta({ n }: { n: any }) {
  return (
    <span className="news-meta small">
      <Avatar personId={n.author_id} name={n.author_name} hasPhoto={n.author_has_photo} />
      <span>{n.author_name} · {fmtDate(n.published_at ?? n.created_at)}{n.status === 'draft' && <> · <Status s="planned" text="Draft" /></>}</span>
    </span>
  );
}

export function News() {
  const hub = useHub();
  const nav = useNavigate();
  const d = useApi<any[]>(`/news${hub.q()}`);
  const [cat, setCat] = useState('all');
  const [editing, setEditing] = useState<any>(null);
  const cos = hub.me.companies.filter((c) => c.perms.includes('news.publish'));
  const all = d.data ?? [];
  const drafts = all.filter((n) => n.status === 'draft');
  const live = all.filter((n) => n.status === 'published' && (cat === 'all' || n.category === cat));
  const [lead, ...rest] = live;
  return (
    <>
      <PageHead title="News & updates" intro="What is happening across the companies you work with."
        actions={cos.length > 0 && <Button onClick={() => setEditing(blank(cos[0].id))}><Icon name="plus" size={18} />Write a post</Button>} />
      <Chips label="Show" value={cat} onChange={setCat} options={[['all', 'All'], ...CATS]} />
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : d.loading && !d.data ? <Skeleton lines={6} /> : (
        <>
          {drafts.length > 0 && (
            <section className="card news-drafts" aria-labelledby="dr-h">
              <h2 id="dr-h" className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Your drafts</h2>
              <ul className="list">{drafts.map((n) => <li key={n.id}><Link to={`/news/${n.id}`}>{n.title}</Link><span className="small muted">{ONE[n.category]} · saved {fmtDate(n.created_at)}</span></li>)}</ul>
            </section>
          )}
          {!lead ? <Empty>{cat === 'all' ? 'No news yet.' : 'Nothing in this category yet.'}</Empty> : (
            <>
              <Link to={`/news/${lead.id}`} className="news-lead card">
                <Cover n={lead} className="news-lead-cover" />
                <span className="news-lead-text">
                  <span className="news-cat">{lead.pinned && <span className="badge st-info">Pinned</span>} {ONE[lead.category]}</span>
                  <h2>{lead.title}</h2>
                  <span className="news-excerpt">{excerpt(lead)}</span>
                  <Meta n={lead} />
                </span>
              </Link>
              {rest.length > 0 && (
                <ul className="news-grid" aria-label="More news">{rest.map((n) => (
                  <li key={n.id}>
                    <Link to={`/news/${n.id}`} className="news-card card">
                      <Cover n={n} className="news-card-cover" />
                      <span className="news-card-text">
                        <span className="news-cat">{n.pinned && <span className="badge st-info">Pinned</span>} {ONE[n.category]}</span>
                        <h3>{n.title}</h3>
                        <span className="news-excerpt clamp-3">{excerpt(n)}</span>
                        <Meta n={n} />
                      </span>
                    </Link>
                  </li>
                ))}</ul>
              )}
            </>
          )}
        </>
      )}
      {editing && <NewsEditor post={editing} companies={cos} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); d.reload(); if (id) nav(`/news/${id}`); }} />}
    </>
  );
}
const blank = (companyId: string) => ({ company_ids: [companyId], category: 'update', title: '', summary: '', body: '', pinned: false, photos: [] });

export function NewsArticle() {
  const { id } = useParams();
  const hub = useHub();
  const toast = useToast();
  const nav = useNavigate();
  const d = useApi<any>(`/news/${id}`);
  const [editing, setEditing] = useState(false);
  const archive = useSubmit(async () => { await post(`/news/${id}/archive`); toast('Archived. It no longer shows on the News page.'); nav('/news'); });
  const publish = useSubmit(async () => { await post(`/news/${id}/publish`); toast('Published.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={10} />;
  const n = d.data;
  const cos = hub.me.companies.filter((c) => c.perms.includes('news.publish'));
  return (
    <article className="news-article">
      <PageHead title={n.title} crumbs={[['News & updates', '/news'], [n.title]]}
        actions={canEdit(hub, n) && <>
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          {n.status === 'draft' && <Button busy={publish.busy} onClick={() => publish.run()}>Publish</Button>}
          {n.status === 'published' && <Button variant="ghost" busy={archive.busy} onClick={() => archive.run()}>Archive</Button>}
        </>} />
      <ErrorSummary error={archive.error ?? publish.error} />
      <div className="news-article-head">
        <span className="news-cat">{ONE[n.category]} · {n.company_codes.join(', ')}</span>
        <Meta n={n} />
      </div>
      {n.image_file_id && <AuthImage url={`/files/${n.image_file_id}`} alt={n.image_alt ?? ''} className="news-hero news-img" />}
      {n.summary && <p className="news-standfirst">{n.summary}</p>}
      <div className="news-body">{paras(n.body)}</div>
      {n.photos.length > 0 && (
        <section aria-labelledby="g-h" style={{ marginTop: 32 }}>
          <h2 id="g-h">Photos</h2>
          <PhotoGrid photos={n.photos} />
        </section>
      )}
      <p style={{ marginTop: 32 }}><Link to="/news"><Icon name="back" size={16} /> All news</Link></p>
      {editing && <NewsEditor post={n} companies={cos} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); d.reload(); }} />}
    </article>
  );
}

function NewsEditor({ post: p, companies, onClose, onSaved }: { post: any; companies: any[]; onClose: () => void; onSaved: (id?: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ ...p, summary: p.summary ?? '', cover: null, cover_alt: p.image_alt ?? '', gallery: [] });
  const [step, setStep] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const save = useSubmit(async (publish: boolean) => {
    if (f.cover && f.cover_alt.trim().length < 3) throw new ApiError(400, 'invalid', 'Describe the cover photo in a few words, for people using screen readers.');
    const body = { company_ids: f.company_ids, category: f.category, title: f.title, summary: f.summary.trim() || null, body: f.body, pinned: f.pinned };
    const n = f.id ? await api('PATCH', `/news/${f.id}`, body) : await post('/news', body);
    try {
      if (f.cover) { setStep('Uploading the cover photo…'); await upload(`/news/${n.id}/image`, f.cover, f.cover.name, undefined, { image_alt: f.cover_alt.trim() }); }
      for (const [i, g] of f.gallery.entries()) { setStep(`Uploading photo ${i + 1} of ${f.gallery.length}…`); await upload(`/news/${n.id}/photos`, g, g.name); }
      for (const fid of removed) await api('DELETE', `/news/${n.id}/photos/${fid}`);
    } finally { setStep(null); }
    if (publish && n.status !== 'published') await post(`/news/${n.id}/publish`);
    toast(publish && f.status !== 'published' ? 'Published.' : 'Saved.');
    onSaved(f.id ? undefined : n.id);
  });
  const kept = (p.photos ?? []).filter((x: any) => !removed.includes(x.id));
  return (
    <Dialog open onClose={onClose} title={f.id ? 'Edit post' : 'Write a post'}
      footer={<>{f.status !== 'published' && <Button variant="secondary" busy={save.busy} onClick={() => save.run(false)}>Save draft</Button>}
        <Button busy={save.busy} busyText={step ?? 'Saving…'} onClick={() => save.run(true)}>{f.status === 'published' ? 'Save changes' : 'Publish'}</Button></>}>
      <ErrorSummary error={save.error} />
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Who should see it?</legend>
        {companies.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={f.company_ids.includes(c.id)} onChange={(e) => setF({ ...f, company_ids: e.target.checked ? [...f.company_ids, c.id] : f.company_ids.filter((x: string) => x !== c.id) })} /> {c.name}</label>)}
      </fieldset>
      <Field label="Category"><select name="category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map(([k]) => <option key={k} value={k}>{ONE[k]}</option>)}</select></Field>
      <Field label="Headline" error={save.error?.fields.title}><input name="title" maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Short summary" optional hint="One or two sentences shown on the news cards."><textarea name="summary" rows={2} maxLength={300} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      <Field label="Story" error={save.error?.fields.body} hint="Leave a blank line between paragraphs. No resident details."><textarea name="body" rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <div className="news-cover-edit">
        {(f.cover || f.image_file_id) && <span className="small muted">{f.cover ? 'New cover photo chosen.' : 'Current cover photo:'}</span>}
        {!f.cover && f.image_file_id && <AuthImage url={`/files/${f.image_file_id}`} alt={f.image_alt ?? ''} className="news-edit-thumb" />}
        <FilePicker label={f.image_file_id ? 'Replace the cover photo' : 'Cover photo'} hint="A wide (landscape) photo looks best. JPEG, PNG or WebP." accept="image/jpeg,image/png,image/webp" onChange={(fs) => setF({ ...f, cover: fs[0] ?? null })} />
        {f.cover && <Field label="Describe the cover photo"><input name="cover_alt" maxLength={300} value={f.cover_alt} onChange={(e) => setF({ ...f, cover_alt: e.target.value })} placeholder="e.g. The team outside Alder House after the garden clear-up" /></Field>}
      </div>
      {kept.length > 0 && (
        <div className="field"><span style={{ fontWeight: 600 }}>Photos in the gallery</span>
          <PhotoGrid photos={kept} onRemove={(x) => setRemoved([...removed, x.id])} />
        </div>
      )}
      <FilePicker label="Add photos to the gallery" multiple accept="image/jpeg,image/png,image/webp" hint="Shown under the story. Up to 20." onChange={(fs) => setF({ ...f, gallery: fs })} />
      <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
    </Dialog>
  );
}
