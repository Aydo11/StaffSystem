import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { download, get, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';
import { Paragraphs } from './Training.tsx';

const receiptStatus = (r: any): [string, string] => !r ? ['not_required', 'Not supplied yet'] : r.acknowledged_at ? ['verified', 'Acknowledged'] : r.opened_at ? ['submitted', 'Opened, not acknowledged'] : ['info', 'New — please read'];

export function Policies() {
  const hub = useHub();
  const nav = useNavigate();
  const d = useApi<any>(`/policies${hub.q()}`);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (term.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => fetchHits(term).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [term]);
  const canDraft = hub.can('policies.manage');
  const published = d.data?.published ?? [];
  return (
    <>
      <PageHead title="Policies and handbooks" intro="The versions approved by your companies. Acknowledging a policy records that you have read it; it is not a contract." actions={canDraft && <Button onClick={() => setCreating(true)}>New policy or handbook</Button>} />
      <div className="field" style={{ maxWidth: 520 }}><label htmlFor="pol-q">Search policies and handbooks</label><input id="pol-q" type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="For example: lone working, grievance" /></div>
      {hits && (
        <section className="card" aria-live="polite" aria-labelledby="hits-h">
          <h2 id="hits-h">{hits.length} result{hits.length === 1 ? '' : 's'}</h2>
          <ul className="list">{hits.map((h) => <li key={`${h.id}${h.pub_company_id}`}><div><Link to={`/policies/${h.id}?company=${h.pub_company_id}`}><strong>{h.title}</strong></Link> <span className="badge co">{h.company_code}</span>
            {h.chapters.map((c: any) => <p key={c.index} className="small" style={{ margin: '4px 0' }}><Link to={`/policies/${h.id}?company=${h.pub_company_id}#ch-${c.index}`}>{c.title}</Link>: {c.snippet}</p>)}</div></li>)}</ul>
        </section>
      )}
      {d.error && <LoadError error={d.error} retry={d.reload} />}
      {d.loading && !d.data ? <Skeleton lines={6} /> : (
        <>
          {published.length === 0 ? <Empty>No published policies yet.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Title</th><th>Company</th><th>Version</th><th>Review by</th><th>You</th></tr></thead>
              <tbody>{published.map((p: any) => { const [s, t] = receiptStatus(p.receipt); return (
                <tr key={`${p.id}${p.pub_company_id}`}><td><Link to={`/policies/${p.id}?company=${p.pub_company_id}`}>{p.title}</Link><div className="muted small">{label(p.kind)}{p.language !== 'en-GB' && ` · ${p.language}`}</div></td>
                  <td><CompanyBadge code={p.company_code} name={p.company_name} /></td><td>v{p.version}, from {fmtDate(p.effective_on)}</td><td>{fmtDate(p.review_on)}</td><td><Status s={s} text={t} /></td></tr>); })}</tbody>
            </table></div>
          )}
          {(d.data?.pending ?? []).length > 0 && (
            <section className="card" aria-labelledby="pend-h" style={{ marginTop: 16 }}>
              <h2 id="pend-h">Drafts and documents waiting for approval or adoption</h2>
              <ul className="list">{d.data.pending.map((p: any) => <li key={p.id}><span><Link to={`/policies/${p.id}`}>{p.title}</Link> <span className="badge co">{p.company_code ?? 'Shared'}</span><br /><span className="muted small">{label(p.kind)} · version {p.version}</span></span><Status s={p.status === 'draft' ? 'planned' : 'review'} text={p.status === 'draft' ? 'Draft' : 'Approved elsewhere — not adopted here'} /></li>)}</ul>
            </section>
          )}
        </>
      )}
      {creating && <NewPolicy onClose={() => setCreating(false)} onSaved={(id) => nav(`/policies/${id}`)} />}
    </>
  );
}
const fetchHits = (term: string) => get<any[]>(`/policies/search?q=${encodeURIComponent(term)}`);

function NewPolicy({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const hub = useHub();
  const cos = hub.me.companies.filter((c) => c.perms.includes('policies.manage'));
  const [f, setF] = useState({ company_id: cos[0]?.id ?? '', kind: 'policy', title: '', language: 'en-GB' });
  const save = useSubmit(async () => { const p = await post('/policies', { ...f, company_id: f.company_id || null }); onSaved(p.id); });
  return (
    <Dialog open onClose={onClose} title="New policy or handbook" variant="modal" footer={<Button busy={save.busy} onClick={() => save.run()}>Create draft</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Owned by" hint="A shared document must then be adopted by each company that uses it."><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="">Shared across companies</option></select></Field>
      <Field label="Type"><select name="kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="policy">Policy</option><option value="handbook">Staff handbook</option></select></Field>
      <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Language" hint="For a translation, use its language code, for example pl or so."><input name="language" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} style={{ maxWidth: 160 }} /></Field>
    </Dialog>
  );
}

type PTab = 'read' | 'edit' | 'receipts' | 'history';
export function PolicyPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const company = params.get('company');
  const hub = useHub();
  const toast = useToast();
  const nav = useNavigate();
  const d = useApi<any>(`/policies/${id}${company ? `?company=${company}` : ''}`);
  const [tab, setTab] = useState<PTab>('read');
  const ack = useSubmit(async () => { await post(`/policies/${id}/acknowledge`, { company_id: company }); toast('Acknowledged. Thank you.'); d.reload(); hub.reloadMe(); });
  const approve = useSubmit(async (companyId: string) => { const r = await post(`/policies/${id}/approve`, { company_id: companyId }); toast(`Approved and supplied to ${r.supplied} people.`); d.reload(); });
  const newVersion = useSubmit(async () => { const r = await post(`/policies/${id}/new-version`); nav(`/policies/${r.id}`); });
  useEffect(() => { if (d.data && !company && d.data.can.edit) setTab('edit'); }, [d.data, company]);
  useEffect(() => { if (d.data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [d.data]);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { policy: p, can, receipt, file, versions, publications, translations } = d.data;
  const tabs: [PTab, string][] = [['read', 'Read'], ...(can.edit ? [['edit', 'Edit draft'] as [PTab, string]] : []), ...(can.receipts ? [['receipts', 'Who has read it'] as [PTab, string]] : []), ['history', 'Versions']];
  return (
    <>
      <PageHead title={p.title} crumbs={[['Policies and handbooks', '/policies'], [p.title]]}
        intro={<>{label(p.kind)} · version {p.version}{p.company_code ? <> · <CompanyBadge code={p.company_code} name={p.company_name} /></> : ' · shared'} · {label(p.status)}</>}
        actions={<>
          {file && <Button variant="secondary" onClick={() => download(`/files/${file.id}`, file.original_name)}>Download {file.mime_type === 'application/pdf' ? 'PDF' : 'Word document'}</Button>}
          {!file && p.chapters.length > 0 && <Button variant="secondary" onClick={() => print()}>Print or save as PDF</Button>}
          {can.newVersion && <Button variant="secondary" busy={newVersion.busy} onClick={() => newVersion.run()}>Create a new version</Button>}
        </>} />
      <ErrorSummary error={ack.error ?? approve.error ?? newVersion.error} />
      {can.approve.length > 0 && (
        <div className="notice warn no-print">
          <strong>{p.status === 'draft' ? 'Review this draft, then approve it for a company.' : 'This shared document is approved elsewhere. Adopt it to publish it to a company’s staff.'}</strong>
          <div className="row" style={{ marginTop: 8 }}>{can.approve.map((cid: string) => <Button key={cid} busy={approve.busy} onClick={() => approve.run(cid)}>{p.status === 'draft' ? 'Approve for' : 'Adopt for'} {hub.co(cid)?.name}</Button>)}</div>
        </div>
      )}
      <Tabs label="Document sections" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'read' && (
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)' }}>
          <nav aria-label="Contents" className="card no-print" style={{ alignSelf: 'start' }}>
            <h2 style={{ fontSize: '1.125rem' }}>Contents</h2>
            <ol style={{ paddingLeft: 20, margin: 0 }}>{p.chapters.map((c: any, i: number) => <li key={i}><a href={`#ch-${i}`}>{c.title}</a></li>)}</ol>
            {translations.length > 0 && <><h3 style={{ fontSize: '1rem', marginTop: 16 }}>Other languages</h3><ul>{translations.map((t: any) => <li key={t.id}><Link to={`/policies/${t.id}${company ? `?company=${company}` : ''}`} lang={t.language}>{t.title} ({t.language})</Link></li>)}</ul></>}
          </nav>
          <article className="card" lang={p.language}>
            <dl className="facts" style={{ marginBottom: 16 }}>
              <dt>Owner</dt><dd>{p.owner_name ?? '—'}</dd>
              <dt>Applies to</dt><dd>{p.audience ? `Job title: ${p.audience}` : 'Everyone in the company'}</dd>
              <dt>Effective</dt><dd>{fmtDate(p.effective_on)}</dd>
              <dt>Review by</dt><dd>{fmtDate(p.review_on)}</dd>
              <dt>Approved</dt><dd>{publications.length ? publications.map((x: any) => `${x.company_code} by ${x.approved_by_name}, ${fmtDate(x.approved_at)}`).join('; ') : 'Not yet approved'}</dd>
              {p.revision_summary && <><dt>What changed</dt><dd>{p.revision_summary}</dd></>}
            </dl>
            {p.chapters.length === 0 && !file && <p className="muted">No content yet.</p>}
            {p.chapters.map((c: any, i: number) => <section key={i} id={`ch-${i}`} aria-labelledby={`ch-${i}-h`}><h2 id={`ch-${i}-h`} style={{ fontSize: '1.25rem' }}>{c.title}</h2><Paragraphs text={c.body} /></section>)}
            {company && receipt && (
              <div className="no-print" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
                {receipt.acknowledged_at ? <Status s="verified" text={`You acknowledged this on ${fmtDate(receipt.acknowledged_at)}`} /> : (
                  <><p>Please confirm you have read this. It records that you have read it — it does not mean you have agreed to a contract change. If anything is unclear, use Request Help or ask your manager.</p>
                    <Button busy={ack.busy} onClick={() => ack.run()}>Acknowledge</Button></>
                )}
                {receipt.explained_at && <p className="small" style={{ marginTop: 8 }}>Explained to you in person on {fmtDate(receipt.explained_at)}.</p>}
              </div>
            )}
          </article>
        </div>
      )}
      {tab === 'edit' && can.edit && <PolicyEditor p={p} reload={d.reload} />}
      {tab === 'receipts' && company && <Receipts id={id!} company={company} />}
      {tab === 'history' && (
        <div className="table-wrap"><table>
          <thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>What changed</th><th>Approved for</th></tr></thead>
          <tbody>{versions.map((v: any) => <tr key={v.id}><td><Link to={`/policies/${v.id}${company ? `?company=${company}` : ''}`}>v{v.version}</Link></td><td>{label(v.status)}</td><td>{fmtDate(v.effective_on)}</td><td>{v.revision_summary ?? '—'}</td><td>{(v.publications ?? []).map((x: any) => `${x.company_code} (${fmtDate(x.approved_at)})`).join(', ') || '—'}</td></tr>)}</tbody>
        </table></div>
      )}
    </>
  );
}

function PolicyEditor({ p, reload }: { p: any; reload: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ title: p.title, audience: p.audience ?? '', revision_summary: p.revision_summary ?? '', effective_on: p.effective_on ?? '', review_on: p.review_on ?? '', chapters: p.chapters });
  const [progress, setProgress] = useState<number | null>(null);
  const save = useSubmit(async () => { await patch(`/policies/${p.id}`, { ...f, audience: f.audience || null, revision_summary: f.revision_summary || null, effective_on: f.effective_on || null, review_on: f.review_on || null }); toast('Draft saved.'); reload(); });
  const pdf = useSubmit(async (file: File) => { setProgress(0); try { await upload(`/policies/${p.id}/file`, file, file.name, setProgress); toast('Source document attached. Read it before approval.'); reload(); } finally { setProgress(null); } });
  const setCh = (i: number, k: string, v: string) => setF({ ...f, chapters: f.chapters.map((c: any, j: number) => (j === i ? { ...c, [k]: v } : c)) });
  const move = (i: number, by: number) => { const c = [...f.chapters]; const j = i + by; if (j < 0 || j >= c.length) return; [c[i], c[j]] = [c[j], c[i]]; setF({ ...f, chapters: c }); };
  return (
    <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }}>
      <p className="small muted">Someone other than you must review and approve this draft before staff see it.</p>
      <ErrorSummary error={save.error ?? pdf.error} />
      <Field label="Title" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label="Audience" optional hint="Blank = everyone in the company, or one job title."><input name="audience" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></Field>
        <Field label="Effective from" error={save.error?.fields.effective_on}><input name="effective_on" type="date" value={f.effective_on} onChange={(e) => setF({ ...f, effective_on: e.target.value })} /></Field>
        <Field label="Review by" error={save.error?.fields.review_on}><input name="review_on" type="date" value={f.review_on} onChange={(e) => setF({ ...f, review_on: e.target.value })} /></Field>
      </div>
      <Field label="What changed in this version" optional><textarea name="revision_summary" value={f.revision_summary} onChange={(e) => setF({ ...f, revision_summary: e.target.value })} /></Field>
      <FilePicker label="Attach the source document" hint="PDF or Word (.docx). Keep readable chapters below for search and screen readers." accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" instant busy={pdf.busy} progress={progress} onChange={(fs) => pdf.run(fs[0])} />
      <h2 style={{ fontSize: '1.25rem' }}>Chapters</h2>
      {f.chapters.map((c: any, i: number) => (
        <details key={i} className="card" open={f.chapters.length < 4}>
          <summary><strong>{i + 1}. {c.title}</strong></summary>
          <Field label="Chapter title"><input name={`ch-${i}-title`} value={c.title} onChange={(e) => setCh(i, 'title', e.target.value)} /></Field>
          <Field label="Text" hint="Leave a blank line between paragraphs."><textarea name={`ch-${i}-body`} rows={8} value={c.body} onChange={(e) => setCh(i, 'body', e.target.value)} /></Field>
          <div className="row"><Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>Move up</Button><Button variant="ghost" disabled={i === f.chapters.length - 1} onClick={() => move(i, 1)}>Move down</Button><Button variant="ghost" onClick={() => setF({ ...f, chapters: f.chapters.filter((_: any, j: number) => j !== i) })}>Remove</Button></div>
        </details>
      ))}
      <div className="row"><Button variant="secondary" onClick={() => setF({ ...f, chapters: [...f.chapters, { title: 'New chapter', body: '' }] })}>Add chapter</Button><Button type="submit" busy={save.busy}>Save Changes</Button></div>
    </form>
  );
}

function Receipts({ id, company }: { id: string; company: string }) {
  const toast = useToast();
  const d = useApi<any[]>(`/policies/${id}/receipts?company=${company}`);
  const [who, setWho] = useState<any>(null);
  const [note, setNote] = useState('');
  const explain = useSubmit(async () => { await post(`/policies/${id}/explained`, { company_id: company, person_id: who.person_id, note }); setWho(null); setNote(''); toast('Recorded.'); d.reload(); });
  const rows = d.data ?? [];
  const n = (k: string) => rows.filter((r) => r[k]).length;
  return (
    <>
      <div className="kpis">
        {[['supplied_at', 'Supplied'], ['opened_at', 'Opened'], ['acknowledged_at', 'Acknowledged'], ['explained_at', 'Explained in person']].map(([k, t]) => <div key={k} className="kpi"><div className="value">{n(k)} / {rows.length}</div><div className="label">{t}</div></div>)}
      </div>
      {d.loading && !d.data ? <Skeleton /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Supplied</th><th>Opened</th><th>Acknowledged</th><th>Explained</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.person_id}><td>{r.person_name}<div className="muted small">{r.job_title}</div></td><td>{r.supplied_at ? fmtDate(r.supplied_at) : <span className="muted">Not yet</span>}</td><td>{r.opened_at ? fmtDateTime(r.opened_at) : '—'}</td><td>{r.acknowledged_at ? fmtDateTime(r.acknowledged_at) : '—'}</td><td>{r.explained_at ? <>{fmtDate(r.explained_at)} by {r.explained_by_name}</> : '—'}</td>
            <td>{r.supplied_at && <Button variant="ghost" onClick={() => setWho(r)}>Record explanation<span className="sr-only"> for {r.person_name}</span></Button>}</td></tr>)}</tbody>
        </table></div>
      )}
      <Dialog open={!!who} onClose={() => setWho(null)} title={`Explained to ${who?.person_name ?? ''}`} variant="modal" footer={<Button busy={explain.busy} disabled={note.trim().length < 3} onClick={() => explain.run()}>Save</Button>}>
        <ErrorSummary error={explain.error} />
        <Field label="How was it explained?" hint="For example, read through together in supervision, or with an interpreter."><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}
