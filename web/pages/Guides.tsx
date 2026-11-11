// Staff guides, "How do I…?" (server: routes/guides.ts). Body text: blank line between paragraphs, "- " bullets, "1. " steps.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, post, useApi, useSubmit } from '../api.ts';
import { fmtDate } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

export const GUIDE_CATEGORIES: [string, string][] = [['getting_started', 'Getting started'], ['visits_time', 'Visits, time and leave'], ['houses', 'Houses'],
  ['repairs_complaints', 'Repairs and complaints'], ['training', 'Training'], ['emergencies', 'Emergencies'], ['other', 'Other']];
const catName = (k: string) => GUIDE_CATEGORIES.find(([x]) => x === k)?.[1] ?? k;

/** Renders guide text: paragraphs, "- " bullet lists and "1. " numbered steps. */
export function GuideText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((block, i) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length && lines.every((l) => /^\s*- /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*- /, '')}</li>)}</ul>;
    if (lines.length && lines.every((l) => /^\s*\d+\. /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*\d+\. /, '')}</li>)}</ol>;
    return <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{block}</p>;
  })}</>;
}

export function Guides() {
  const d = useApi<any>('/guides');
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [editing, setEditing] = useState<any>(null);
  const rows = useMemo(() => (d.data?.guides ?? []).filter((g: any) => (cat === 'all' || g.category === cat)
    && (!search.trim() || `${g.title} ${g.summary ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))), [d.data, cat, search]);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const present = GUIDE_CATEGORIES.filter(([k]) => d.data.guides.some((g: any) => g.category === k));
  return (
    <>
      <PageHead title="Guides" intro="How to do things on the Hub, and what to do when something goes wrong."
        actions={d.data.can.manage && <Button onClick={() => setEditing({ category: 'getting_started', title: '', summary: '', body: '', status: 'draft', company_id: null })}>New guide</Button>} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <Field label="Search guides"><input type="search" name="q" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="For example: leave, repair, stopcock" /></Field>
      </div>
      <Chips label="Category" options={[['all', 'All'], ...present] as [string, string][]} value={cat} onChange={setCat} />
      {rows.length === 0 ? <Empty>No guides match.</Empty> : present.filter(([k]) => cat === 'all' || k === cat).map(([k, t]) => {
        const list = rows.filter((g: any) => g.category === k);
        return list.length > 0 && <section key={k} className="card" aria-labelledby={`g-${k}`} style={{ marginTop: 12 }}>
          <h2 id={`g-${k}`}>{t}</h2>
          <ul className="list">{list.map((g: any) => <li key={g.id}>
            <span><Link to={`/guides/${g.id}`}><strong>{g.title}</strong></Link>{g.company_code && <> <CompanyBadge code={g.company_code} /></>}
              {g.summary && <><br /><span className="small muted">{g.summary}</span></>}</span>
            {g.status === 'draft' && <Status s="info" text="Draft" />}
          </li>)}</ul>
        </section>;
      })}
      {editing && <GuideEditor guide={editing} companies={d.data.can.companies} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); d.reload(); }} />}
    </>
  );
}

export function GuidePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const d = useApi<any>(`/guides/${id}`);
  const [editing, setEditing] = useState(false);
  const del = useSubmit(async () => { await api('DELETE', `/guides/${id}`); toast('Guide deleted.'); nav('/guides'); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const g = d.data;
  return (
    <>
      <PageHead title={g.title} crumbs={[['Guides', '/guides'], [g.title]]} intro={<>{catName(g.category)}{g.company_code && <> · <CompanyBadge code={g.company_code} /></>}{g.status === 'draft' && <> · <Status s="info" text="Draft: only managers can see it" /></>}</>}
        actions={g.can.manage && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button variant="danger" busy={del.busy} onClick={() => { if (confirm('Delete this guide?')) del.run(); }}>Delete</Button></>} />
      <ErrorSummary error={del.error} />
      <article className="card guide-body">
        {g.summary && <p className="lead">{g.summary}</p>}
        <GuideText text={g.body} />
        <p className="small muted" style={{ marginTop: 16 }}>Last updated {fmtDate(g.updated_at)}{g.updated_by_name ? ` by ${g.updated_by_name}` : ''}.</p>
      </article>
      {editing && <GuideEditor guide={g} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); d.reload(); }} />}
    </>
  );
}

function GuideEditor({ guide, companies, onClose, onSaved }: { guide: any; companies?: string[]; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const [f, setF] = useState({ ...guide, summary: guide.summary ?? '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    const b = { category: f.category, title: f.title, summary: f.summary || null, body: f.body, status: f.status };
    if (guide.id) await api('PUT', `/guides/${guide.id}`, b); else await post('/guides', { ...b, company_id: f.company_id || null });
    toast(f.status === 'published' ? 'Guide published.' : 'Draft saved.'); onSaved();
  });
  return (
    <Dialog open onClose={onClose} title={guide.id ? 'Edit guide' : 'New guide'} footer={<Button busy={save.busy} onClick={() => save.run()}>{f.status === 'published' ? 'Publish' : 'Save draft'}</Button>}>
      <ErrorSummary error={save.error} />
      {!guide.id && companies && <Field label="Who is it for?"><select name="company_id" value={f.company_id ?? ''} onChange={set('company_id')}>
        <option value="">Every company</option>{companies.map((c) => <option key={c} value={c}>{hub.me.companies.find((x) => x.id === c)?.name}</option>)}</select></Field>}
      <Field label="Category"><select name="category" value={f.category} onChange={set('category')}>{GUIDE_CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={set('title')} /></Field>
      <Field label="Short summary" optional><input name="summary" value={f.summary} onChange={set('summary')} maxLength={300} /></Field>
      <Field label="Guide" hint="Leave a blank line between paragraphs. Start lines with “- ” for bullets or “1. ” for steps." error={save.error?.fields.body}>
        <textarea name="body" rows={14} value={f.body} onChange={set('body')} /></Field>
      <Field label="Status"><select name="status" value={f.status} onChange={set('status')}><option value="draft">Draft (managers only)</option><option value="published">Published (all staff)</option></select></Field>
    </Dialog>
  );
}
