import { useState } from 'react';
import { ApiError, get, post, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, label, londonToday } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

const KINDS: [string, string][] = [['annual', 'Annual leave'], ['sick', 'Sickness'], ['unpaid', 'Unpaid'], ['training', 'Training or study'], ['compassionate', 'Compassionate'], ['other', 'Other']];
const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? label(k);
const days = (l: any) => `${l.days} day${l.days === 1 ? '' : 's'}`;
// Day and month of the first day, shown as a calendar tile (decorative: the full range is in the text).
const Tile = ({ d }: { d: string }) => { const x = new Date(`${d}T12:00:00Z`); return <span className="date-tile" aria-hidden="true"><b>{x.getUTCDate()}</b><span>{x.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}</span></span>; };
const range = (l: any) => (l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`);

export function LeavePage() {
  const d = useApi<any>('/leave');
  const [tab, setTab] = useState<'mine' | 'decide' | 'team'>('mine');
  const [asking, setAsking] = useState(false);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={6} />;
  const { mine, toDecide, upcoming, canApprove } = d.data;
  const tabs: ['mine' | 'decide' | 'team', string][] = [['mine', 'My leave'], ...(canApprove.length ? [['decide', `To decide (${toDecide.length})`] as ['decide', string]] : []), ['team', 'Team calendar']];
  return (
    <>
      <PageHead title="Leave" intro="Request leave, see who is away, and arrange cover for planned visits. Leave reduces available hours on the Workload page." actions={<Button onClick={() => setAsking(true)}>Request leave</Button>} />
      <Chips label="Show" value={tab} onChange={setTab} options={tabs} />
      <div style={{ marginTop: 16 }}>
        {tab === 'mine' && (mine.length ? <ul className="list">{mine.map((l: any) => <MyLeave key={l.id} l={l} reload={d.reload} />)}</ul> : <Empty>You have no leave recorded.</Empty>)}
        {tab === 'decide' && (toDecide.length ? toDecide.map((l: any) => <Decide key={l.id} l={l} reload={d.reload} />) : <Empty>Nothing waiting for a decision.</Empty>)}
        {tab === 'team' && (upcoming.length ? (
          <div className="table-wrap"><table><thead><tr><th>Who</th><th>When</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>{upcoming.map((l: any) => <tr key={l.id}><td>{l.person_name} <CompanyBadge code={l.company_code} name={l.company_name} /></td><td>{range(l)} <span className="small muted">({days(l)})</span></td><td>{kindLabel(l.kind)}</td><td><Status s={l.status} /></td></tr>)}</tbody></table></div>
        ) : <Empty>No upcoming leave.</Empty>)}
      </div>
      {asking && <RequestLeave onClose={() => setAsking(false)} onSaved={() => { setAsking(false); d.reload(); }} />}
    </>
  );
}

function RequestLeave({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const cos = [...new Map(hub.me.appointments.filter((a: any) => a.status === 'active').map((a: any) => [a.company_id, a.company_name])).entries()];
  const [f, setF] = useState({ company_id: cos[0]?.[0] ?? '', kind: 'annual', start_date: londonToday(), end_date: londonToday(), note: '' });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    if (f.end_date < f.start_date) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { end_date: 'Must be on or after the first day' } });
    await post('/leave', { ...f, note: f.note || undefined });
    toast('Leave requested. Your manager will be asked to approve it.');
    onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title="Request leave" footer={<Button busy={save.busy} onClick={() => save.run()}>Send request</Button>}>
      <ErrorSummary error={save.error} />
      {cos.length > 1 && <Field label="Approved by" hint="The company whose manager approves it. Leave applies to all your work." error={e.company_id}><select name="company_id" value={f.company_id} onChange={set('company_id')}>{cos.map(([id, n]) => <option key={id as string} value={id as string}>{n as string}</option>)}</select></Field>}
      <Field label="Type" error={e.kind}><select name="kind" value={f.kind} onChange={set('kind')}>{KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
      <div className="form-grid">
        <Field label="First day" error={e.start_date}><input name="start_date" type="date" value={f.start_date} onChange={(ev) => setF({ ...f, start_date: ev.target.value, end_date: f.end_date < ev.target.value ? ev.target.value : f.end_date })} /></Field>
        <Field label="Last day" error={e.end_date}><input name="end_date" type="date" value={f.end_date} min={f.start_date} onChange={set('end_date')} /></Field>
      </div>
      <Field label="Note for your manager" optional hint="Do not include medical details." error={e.note}><textarea name="note" rows={2} maxLength={500} value={f.note} onChange={set('note')} /></Field>
    </Dialog>
  );
}

function MyLeave({ l, reload }: { l: any; reload: () => void }) {
  const toast = useToast();
  const cancel = useSubmit(async () => { await post(`/leave/${l.id}/cancel`, {}); toast('Leave cancelled.'); reload(); });
  const canCancel = ['requested', 'approved'].includes(l.status) && l.end_date >= londonToday();
  return (
    <li>
      <span className="dated"><Tile d={l.start_date} /><span><strong>{kindLabel(l.kind)}</strong> · {range(l)} <span className="small muted">({days(l)})</span><br />
        <span className="small muted">{l.company_name}{l.decided_by_name && ` · ${l.status === 'approved' ? 'Approved' : 'Decided'} by ${l.decided_by_name}, ${fmtDateTime(l.decided_at)}`}{l.decision_note && ` · “${l.decision_note}”`}</span></span></span>
      <span className="row"><Status s={l.status} />{canCancel && <Button variant="secondary" busy={cancel.busy} onClick={() => cancel.run()} aria-label={`Cancel leave from ${fmtDate(l.start_date)}`}>Cancel</Button>}</span>
      <ErrorSummary error={cancel.error} />
    </li>
  );
}

function Decide({ l, reload }: { l: any; reload: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [cover, setCover] = useState<any[] | null>(null);
  const loadCover = useSubmit(async () => setCover((await get(`/leave/${l.id}/cover`)).visits));
  const decide = useSubmit(async (decision: 'approved' | 'rejected') => {
    await post(`/leave/${l.id}/decide`, { decision, note: note || undefined });
    toast(decision === 'approved' ? 'Leave approved.' : 'Leave rejected.'); reload();
  });
  return (
    <section className="card" aria-labelledby={`lv-${l.id}`}>
      <h2 id={`lv-${l.id}`} style={{ fontSize: '1.125rem' }}>{l.person_name}: {kindLabel(l.kind)}, {range(l)} ({days(l)})</h2>
      <p className="small muted">{l.company_name} · requested {fmtDateTime(l.created_at)}{l.note && <> · “{l.note}”</>}</p>
      {hub.can('visits.approve', l.company_id) && (cover ? <CoverList visits={cover} reload={() => loadCover.run()} /> : <Button variant="secondary" busy={loadCover.busy} onClick={() => loadCover.run()}>Check planned visits that need cover</Button>)}
      <ErrorSummary error={loadCover.error ?? decide.error} />
      <Field label="Note" optional hint="Required if you reject it." error={decide.error?.fields.note}><input name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="row"><Button variant="go" busy={decide.busy} onClick={() => decide.run('approved')}>Approve</Button><Button variant="danger" disabled={decide.busy} onClick={() => decide.run('rejected')}>Reject</Button></div>
    </section>
  );
}

function CoverList({ visits, reload }: { visits: any[]; reload: () => void }) {
  if (!visits.length) return <p className="notice ok">No planned visits during this leave.</p>;
  return (
    <div style={{ margin: '12px 0' }}>
      <p><strong>{visits.length} planned visit{visits.length === 1 ? '' : 's'} need cover:</strong></p>
      <ul className="list">{visits.map((v) => <CoverRow key={v.id} v={v} reload={reload} />)}</ul>
    </div>
  );
}
function CoverRow({ v, reload }: { v: any; reload: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const go = useSubmit(async () => {
    const r = await post(`/scheduled-visits/${v.id}/reassign`, { person_id: to });
    toast(r.warnings?.length ? `Reassigned. ${r.warnings.join(' ')}` : 'Reassigned.'); reload();
  });
  const id = `cover-${v.id}`;
  return (
    <li>
      <span>{fmtDateTime(v.planned_start)} · {v.property_name}</span>
      <span className="row">
        <label className="sr-only" htmlFor={id}>Cover for {v.property_name} on {fmtDateTime(v.planned_start)}</label>
        <select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose cover…</option>
          {v.candidates.map((c: any) => <option key={c.person_id} value={c.person_id}>{c.name}{c.clearance === 'cleared' ? '' : ` (${label(c.clearance === 'none' ? 'no clearance' : c.clearance)})`}</option>)}
        </select>
        <Button variant="secondary" disabled={!to} busy={go.busy} onClick={() => go.run()}>Reassign</Button>
      </span>
      <ErrorSummary error={go.error} />
    </li>
  );
}
