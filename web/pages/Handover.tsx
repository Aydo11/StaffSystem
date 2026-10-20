import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, useApi, useSubmit } from '../api.ts';
import { addDays, fmtDateTime, fmtDay, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, useToast } from '../ui.tsx';

export function Handover() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(londonToday());
  const list = useApi<any[]>(`/handover${hub.q({ date })}`);
  const toast = useToast();
  const open = params.get('new') === '1';
  const [f, setF] = useState({ company_id: hub.company !== 'all' ? hub.company : hub.me.companies[0]?.id ?? '', property_id: '', for_date: londonToday(), body: '' });
  const props = useApi<any[]>(open && f.company_id ? `/properties?company=${f.company_id}` : null);
  const save = useSubmit(async () => { await post('/handover', { ...f, property_id: f.property_id || null }); setParams({}); setF({ ...f, body: '' }); toast('Handover note saved.'); list.reload(); });
  return (
    <>
      <PageHead title="Daily handover" intro="Operational notes for the next shift. Personal or confidential staff matters do not belong here — raise them privately with HR." actions={<Button onClick={() => setParams({ new: '1' })}>Write a note</Button>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => setDate(addDays(date, -1))}>‹ Previous day</Button>
        <h2 style={{ margin: 0 }} aria-live="polite">{fmtDay(date)}</h2>
        <Button variant="secondary" onClick={() => setDate(addDays(date, 1))}>Next day ›</Button>
      </div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading && !list.data ? <Skeleton /> : (list.data ?? []).length === 0 ? <Empty>No handover notes for this day.</Empty> : (
        <ul className="list card">{list.data!.map((h) => (
          <li key={h.id}><div><CompanyBadge code={h.company_code} name={h.company_name} /> {h.property_name && <strong>{h.property_name}</strong>}<p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{h.body}</p><span className="muted small">{h.author_name} · {fmtDateTime(h.created_at)}</span></div></li>
        ))}</ul>
      )}
      <Dialog open={open} onClose={() => setParams({})} title="Write a handover note" footer={<Button busy={save.busy} onClick={() => save.run()}>Save note</Button>}>
        <ErrorSummary error={save.error} />
        <Field label="Company" hint="The note is visible to colleagues in this company."><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, property_id: '' })}>{hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Property" optional><select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}><option value="">General</option>{props.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="For date"><input name="for_date" type="date" value={f.for_date} onChange={(e) => setF({ ...f, for_date: e.target.value })} /></Field>
        <Field label="Note" hint="No resident names or support details." error={save.error?.fields.body}><textarea name="body" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      </Dialog>
    </>
  );
}
