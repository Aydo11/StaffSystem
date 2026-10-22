import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, blobUrl, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime, fmtDay, fmtMinutes, fmtTime, label, londonLocal } from '../format.ts';
import { useHub } from '../hub.tsx';
import { AllocateDialog } from '../allocate.tsx';
import { Avatar, Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, Icon, LoadError, PageHead, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';
import { StartVisitDialog } from './Visits.tsx';
import { ASPECTS, blankExtras, CATEGORIES, ComplaintFields, ConditionBar, SOURCES, Stars, suggestions, tone } from '../condition.tsx';
import { MapEmbed } from '../geo.tsx';

function Photo({ id, has, name }: { id: string; has: boolean; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let u: string | null = null; if (has) blobUrl(`/properties/${id}/photo`).then((x) => { u = x; setSrc(x); }); return () => { if (u) URL.revokeObjectURL(u); }; }, [id, has]);
  return <div className="prop-photo">{src ? <img src={src} alt={`Photo of ${name}`} /> : <span aria-hidden="true">{name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>}</div>;
}

export function Properties() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') === 'true';
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [term, setTerm] = useState('');
  const [start, setStart] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const list = useApi<any[]>(`/properties${hub.q({ mine: mine ? 'true' : undefined })}`);
  const rows = (list.data ?? []).filter((p) => !term || `${p.name} ${p.ref} ${p.address_line1} ${p.postcode}`.toLowerCase().includes(term.toLowerCase()));
  const canAdd = hub.me.companies.some((c) => c.perms.includes('properties.manage'));

  return (
    <>
      <PageHead title={mine ? 'My Properties' : 'Properties'} intro={mine ? 'Properties allocated to you. Start a visit when you arrive, or log one you have finished.' : 'Properties in the companies you can see. No resident or occupancy details are kept here.'}
        actions={canAdd && <Button onClick={() => setAdding(true)}>Add property</Button>} />
      <div className="row between" style={{ marginBottom: 16 }}>
        <Chips label="Which properties" value={mine ? 'mine' : 'all'} onChange={(v) => setParams(v === 'mine' ? { mine: 'true' } : {})} options={[['mine', 'Mine'], ['all', 'All I can see']]} />
        <div className="row">
          <label className="sr-only" htmlFor="prop-find">Find a property</label>
          <input id="prop-find" type="search" placeholder="Find by name, reference or postcode" value={term} onChange={(e) => setTerm(e.target.value)} style={{ width: 300, maxWidth: '100%' }} />
          <Chips label="Layout" value={view} onChange={setView} options={[['cards', 'Cards'], ['table', 'Table']]} />
        </div>
      </div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading && !list.data ? <Skeleton lines={6} /> : rows.length === 0 ? <Empty>{mine ? 'No properties are allocated to you yet. Your manager allocates properties to your role.' : 'No properties match.'}</Empty> : view === 'cards' ? (
        <ul className="grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((p) => (
            <li key={p.id} className={`card prop-card glow-${tone(p.condition_score)}`}>
              <Photo id={p.id} has={p.has_photo} name={p.name} />
              <div className="prop-body">
                <div className="row between"><h3 style={{ margin: 0 }}><Link to={`/properties/${p.id}`}>{p.name}</Link></h3><CompanyBadge code={p.company_code} name={p.company_name} /></div>
                <div className="muted small">{p.ref} · {p.address_line1}, {p.postcode}</div>
                {p.status !== 'active' && <div><Status s={p.status} /></div>}
                <div className="small">Next visit: <strong>{p.next_visit ? `${fmtDay(p.next_visit)} ${fmtTime(p.next_visit)}` : 'none planned'}</strong><br />Last visit: {p.last_visit ? fmtDate(p.last_visit) : 'none recorded'} · Open tasks: {p.open_tasks}</div>
                <ConditionBar score={p.condition_score} compact />
                {(p.open_complaints > 0 || p.open_repairs > 0 || tone(p.condition_score) === 'low') && (
                  <details className="prop-tips"><summary>{[p.open_complaints && `${p.open_complaints} open complaint${p.open_complaints === 1 ? '' : 's'}`, p.open_repairs && `${p.open_repairs} repair${p.open_repairs === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'Suggestions'}</summary>
                    <ul>{suggestions(p.condition_aspects, p.open_complaints, p.open_repairs).slice(0, 3).map((t) => <li key={t}>{t}</li>)}</ul>
                  </details>
                )}
                <div className="hours" aria-label="Hours this month">
                  <div><span className="muted">Planned</span><strong>{fmtMinutes(p.planned_minutes_month)}</strong></div>
                  <div><span className="muted">Recorded</span><strong>{fmtMinutes(p.recorded_minutes_month)}</strong></div>
                  <div><span className="muted">Approved</span><strong>{fmtMinutes(p.approved_minutes_month)}</strong></div>
                </div>
              </div>
              {p.my_appointments.length > 0 && (
                <div className="prop-actions">
                  <Button variant="go" disabled={!!hub.me.activeVisit} title={hub.me.activeVisit ? 'Finish your current visit first' : undefined} onClick={() => setStart(p)} aria-label={`Start Visit at ${p.name}`}>Start Visit</Button>
                  <Link className="btn secondary" to={`/visits/new?property=${p.id}`} aria-label={`Log Completed Visit at ${p.name}`}>Log Completed</Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Property</th><th>Company</th><th>Status</th><th>Managing agent</th><th>Manager</th><th>Next visit</th><th className="num">Open tasks</th><th className="num">Approved this month</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}><td><Link to={`/properties/${p.id}`}>{p.name}</Link><div className="muted small">{p.ref} · {p.postcode}</div></td><td><CompanyBadge code={p.company_code} name={p.company_name} /></td><td><Status s={p.status} /></td><td>{p.managing_agent ?? '—'}</td><td>{p.manager_name ?? '—'}</td><td>{p.next_visit ? fmtDateTime(p.next_visit) : '—'}</td><td className="num">{p.open_tasks}</td><td className="num">{fmtMinutes(p.approved_minutes_month)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {start && <StartVisitDialog property={start} onClose={() => setStart(null)} />}
      {adding && <PropertyForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </>
  );
}

function PropertyForm({ existing, onClose, onSaved }: { existing?: any; onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const cos = hub.me.companies.filter((c) => c.perms.includes('properties.manage'));
  const [f, setF] = useState<any>(existing ? { ...existing, room_refs: (existing.room_refs ?? []).join(', ') } : { company_id: hub.company !== 'all' && cos.some((c) => c.id === hub.company) ? hub.company : cos.length === 1 ? cos[0].id : '', ref: '', name: '', address_line1: '', address_line2: '', city: '', postcode: '', status: 'active', managing_agent: '', room_refs: '', notes: '' });
  const toast = useToast();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    const body: any = { ref: f.ref, name: f.name, address_line1: f.address_line1, address_line2: f.address_line2 || null, city: f.city, postcode: f.postcode, status: f.status, managing_agent: f.managing_agent || null, notes: f.notes || null,
      room_refs: f.room_refs.split(',').map((s: string) => s.trim()).filter(Boolean) };
    if (existing) await patch(`/properties/${existing.id}`, body);
    else {
      if (!f.company_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { company_id: 'Choose the company' } });
      await post('/properties', { ...body, company_id: f.company_id });
    }
    toast(existing ? 'Property saved.' : 'Property added.');
    onSaved();
  });
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={existing ? `Edit ${existing.name}` : 'Add a property'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
      <ErrorSummary error={save.error} />
      {!existing && <Field label="Company" error={e.company_id} hint="The property is saved under this company."><select name="company_id" value={f.company_id} onChange={set('company_id')}><option value="">Choose…</option>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <div className="form-grid">
        <Field label="Reference" error={e.ref}><input name="ref" value={f.ref} onChange={set('ref')} /></Field>
        <Field label="Name" error={e.name}><input name="name" value={f.name} onChange={set('name')} /></Field>
      </div>
      <Field label="Address line 1" error={e.address_line1}><input name="address_line1" value={f.address_line1} onChange={set('address_line1')} /></Field>
      <Field label="Address line 2" optional><input name="address_line2" value={f.address_line2 ?? ''} onChange={set('address_line2')} /></Field>
      <div className="form-grid">
        <Field label="Town or city" error={e.city}><input name="city" value={f.city} onChange={set('city')} /></Field>
        <Field label="Postcode" error={e.postcode}><input name="postcode" value={f.postcode} onChange={set('postcode')} /></Field>
      </div>
      <Field label="Status"><select name="status" value={f.status} onChange={set('status')}>{['active', 'void', 'under_works', 'offboarded'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
      <Field label="Managing agent" optional><input name="managing_agent" value={f.managing_agent ?? ''} onChange={set('managing_agent')} /></Field>
      <Field label="Room references" optional hint="Labels only, separated by commas (for example Room A, Room B). Never resident names." error={e['room_refs.0'] ?? e.room_refs}><input name="room_refs" value={f.room_refs} onChange={set('room_refs')} /></Field>
      <Field label="Operational notes" optional hint="Property information only. Do not record access codes or resident details."><textarea name="notes" value={f.notes ?? ''} onChange={set('notes')} /></Field>
    </Dialog>
  );
}

export function PropertyPage() {
  const { id } = useParams();
  const hub = useHub();
  const d = useApi<any>(`/properties/${id}`);
  const toast = useToast();
  const [dlg, setDlg] = useState<null | 'start' | 'edit' | 'key' | 'issue' | 'schedule' | 'assign' | 'complaint'>(null);
  const [complaint, setComplaint] = useState(blankExtras().complaint);
  const [keyId, setKeyId] = useState('');
  const [form, setForm] = useState<any>({});
  const [progress, setProgress] = useState<number | null>(null);
  const people = useApi<any[]>(dlg === 'issue' && d.data ? `/people?company=${d.data.property.company_id}` : null);

  const keyAction = useSubmit(async (kid: string, action: string, body: any = {}) => { await post(`/keys/${kid}/${action}`, body); setDlg(null); toast(`Key ${action === 'issue' ? 'issued' : action === 'return' ? 'returned' : 'reported lost'}.`); d.reload(); });
  const addKey = useSubmit(async () => { await post(`/properties/${id}/keys`, { label: form.label }); setDlg(null); toast('Key added.'); d.reload(); });
  const schedule = useSubmit(async () => { await post('/scheduled-visits', { property_id: id, appointment_id: form.appointment_id, planned_start: form.planned_start, planned_minutes: Number(form.planned_minutes || 60), notes: form.notes || undefined }); setDlg(null); toast('Visit planned.'); d.reload(); });
  const photo = useSubmit(async (file: File) => { setProgress(0); try { await upload(`/properties/${id}/photo`, file, file.name, setProgress); toast('Photo updated.'); d.reload(); } finally { setProgress(null); } });
  const staff = useApi<any[]>(dlg === 'schedule' && d.data ? `/people?company=${d.data.property.company_id}` : null);
  const assignable = useApi<any[]>(dlg === 'assign' ? `/properties/${id}/assignable` : null);
  const endAlloc = useSubmit(async (aid: string) => { await post(`/appointment-properties/${aid}/end`); toast('Allocation ended.'); d.reload(); });
  const logComplaint = useSubmit(async () => { await post(`/properties/${id}/complaints`, complaint); setDlg(null); setComplaint(blankExtras().complaint); toast('Complaint logged and sent to the complaints manager.'); d.reload(); });

  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { property: p, keys, allocations, tasks, visits, scheduled, links, my_appointments, can, photos, condition, complaints, repairs, repair_history = [] } = d.data;
  const openComplaints = complaints.filter((c: any) => c.task_status !== 'completed');
  const tips = suggestions(condition.aspects, openComplaints.length, repairs.length);
  const current = allocations.filter((a: any) => !a.to_date);
  const canPlan = hub.can('visits.approve', p.company_id);

  return (
    <>
      <PageHead title={p.name} crumbs={[['Properties', '/properties'], [p.name]]} intro={<><CompanyBadge code={p.company_code} name={p.company_name} /> {p.ref} · {p.address_line1}, {p.city} {p.postcode}</>}
        actions={<>
          {my_appointments.length > 0 && <><Button variant="go" disabled={!!hub.me.activeVisit} onClick={() => setDlg('start')}>Start Visit</Button><Link className="btn secondary" to={`/visits/new?property=${p.id}`}>Log Completed Visit</Link></>}
          {can.manage && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
        </>} />
      <div className="grid-2">
        <section className={`card cond-card glow-${tone(condition.score)}`} aria-labelledby="hc-h">
          <h2 id="hc-h">House mood</h2>
          <ConditionBar score={condition.score} />
          <p className="small muted">{condition.score == null ? 'Rate the home when you finish a visit and the score appears here.' : `From the latest rating of each part of the home (${condition.ratings_count} rating${condition.ratings_count === 1 ? '' : 's'} in the last 12 months, latest ${fmtDate(condition.rated_at)}).`}</p>
          {condition.aspects && (
            <ul className="aspects">{ASPECTS.filter(([k]) => condition.aspects[k] != null).map(([k, t]) => (
              <li key={k} className={`tone-${tone(condition.aspects[k] * 20)}`}><span>{t}</span><Stars n={condition.aspects[k]} /></li>
            ))}</ul>
          )}
          {condition.latest_note && <p className="notice"><strong>Latest note:</strong> {condition.latest_note}</p>}
          {tips.length > 0 && (
            <details className="prop-tips" open={tone(condition.score) === 'low'}><summary>Suggested improvements ({tips.length})</summary><ul>{tips.map((t) => <li key={t}>{t}</li>)}</ul></details>
          )}
        </section>

        <section className="card" aria-labelledby="pc-h">
          <div className="row between"><h2 id="pc-h">Complaints</h2><Button variant="secondary" onClick={() => setDlg('complaint')}><Icon name="plus" size={18} />Log a complaint</Button></div>
          <p className="small muted">Each complaint goes to the complaints manager as a task. It is resolved when they complete the task.{hub.can('governance.manage', p.company_id) && <> <Link to="/governance?tab=leads&set=complaints_oversight">Choose the complaints manager</Link></>}</p>
          {complaints.length === 0 ? <Empty>No complaints logged.</Empty> : (
            <details open={openComplaints.length > 0}><summary>{openComplaints.length} open · {complaints.length - openComplaints.length} resolved</summary>
              <ul className="list">{complaints.map((c: any) => (
                <li key={c.id}>
                  <span><strong>{CATEGORIES.find(([k]) => k === c.category)?.[1]}</strong> · from {SOURCES.find(([k]) => k === c.source)?.[1].toLowerCase()}<br />
                    <span className="small">{c.summary}</span><br />
                    <span className="muted small">Logged by {c.raised_by_name}, {fmtDate(c.created_at)} · {c.handler_name ? `with ${c.handler_name}` : 'no complaints manager set'}{c.task_id && <> · <Link to={`/tasks/${c.task_id}`}>task</Link></>}</span></span>
                  <Status s={c.task_status === 'completed' ? 'completed' : c.task_status ?? 'not_started'} text={c.task_status === 'completed' ? 'Resolved' : c.task_status === 'in_progress' ? 'Being handled' : 'Open'} />
                </li>
              ))}</ul>
            </details>
          )}
          <h3 style={{ marginTop: 20 }}>Maintenance</h3>
          {repairs.length === 0 ? <p className="muted">No open repairs.</p> : <details><summary>{repairs.length} open repair{repairs.length === 1 ? '' : 's'}</summary><ul className="list">{repairs.map((r: any) => <li key={r.id}><Link to={`/estates/repairs/${r.id}`}>{r.title}</Link><span className="small muted">{label(r.urgency)} · due {fmtDate(r.due_on)}</span></li>)}</ul></details>}
          {repair_history.length > 0 && <details><summary>{repair_history.length} fixed repair{repair_history.length === 1 ? '' : 's'} · {repair_history.filter((r: any) => r.on_time).length} on time</summary><ul className="list">{repair_history.map((r: any) => <li key={r.id}><Link to={`/estates/repairs/${r.id}`}>{r.title}</Link><span className="small muted">{label(r.urgency)} · fixed in {r.days_to_fix <= 0 ? 'the same day' : `${r.days_to_fix} day${r.days_to_fix === 1 ? '' : 's'}`} · closed {fmtDateTime(r.verified_at)} <Status s={r.on_time ? 'verified' : 'action'} text={r.on_time ? 'On time' : 'Late'} /></span></li>)}</ul></details>}
          <p className="small muted">Each repair goes to the repairs manager as a task and completes when it is verified.{hub.can('governance.manage', p.company_id) && <> <Link to="/governance?tab=leads&set=repairs">Choose the repairs manager</Link></>}</p>
        </section>

        <section className="card" aria-labelledby="pd-h">
          <h2 id="pd-h">Details</h2>
          <Photo id={p.id} has={p.has_photo} name={p.name} />
          {can.manage && (
            <div style={{ marginTop: 12 }}>
              <FilePicker label="Property photo" accept="image/jpeg,image/png,image/webp" instant busy={photo.busy} progress={progress} buttonText={p.has_photo ? 'Replace photo' : 'Add a photo'} onChange={(fs) => photo.run(fs[0])} />
              <ErrorSummary error={photo.error} />
            </div>
          )}
          <dl className="facts" style={{ marginTop: 16 }}>
            <dt>Status</dt><dd><Status s={p.status} /></dd>
            <dt>Company</dt><dd>{p.company_name}</dd>
            {links.length > 0 && <><dt>Also worked by</dt><dd>{links.map((l: any) => <div key={l.company_id}><CompanyBadge code={l.company_code} name={l.company_name} /> {l.arrangement}</div>)}</dd></>}
            <dt>Managing agent</dt><dd>{p.managing_agent ?? '—'}</dd>
            <dt>Room references</dt><dd>{p.room_refs?.length ? p.room_refs.join(', ') : '—'}</dd>
            <dt>Notes</dt><dd>{p.notes ?? '—'}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="pm-h">
          <h2 id="pm-h">Map</h2>
          <p className="small muted">{p.address_line1}, {p.city} {p.postcode}</p>
          {p.latitude != null ? <MapEmbed lat={p.latitude} lng={p.longitude} title={`Map showing ${p.name}`} /> : <p className="muted">No map pin yet. It is placed from the postcode within the hour.</p>}
        </section>

        <section className="card" aria-labelledby="sv-h">
          <div className="row between"><h2 id="sv-h">Planned visits</h2>{canPlan && <Button variant="secondary" onClick={() => { setForm({ planned_start: londonLocal(), planned_minutes: '60' }); setDlg('schedule'); }}>Plan a visit</Button>}</div>
          {scheduled.length === 0 ? <Empty>No visits planned.</Empty> : <ul className="list">{scheduled.map((s: any) => <li key={s.id}><span>{fmtDay(s.planned_start)} {fmtTime(s.planned_start)} · {s.person_name}</span><span className="muted">{fmtMinutes(s.planned_minutes)} planned</span></li>)}</ul>}
          <h3 style={{ marginTop: 24 }}>Recent visits</h3>
          {visits.length === 0 ? <Empty>No visits recorded.</Empty> : <ul className="list">{visits.slice(0, 8).map((v: any) => <li key={v.id}><Link to={`/visits/${v.id}`}>{fmtDate(v.started_at)} · {v.person_name}</Link><Status s={v.status} /></li>)}</ul>}
        </section>

        <section className="card" aria-labelledby="pt-h">
          <div className="row between"><h2 id="pt-h">Tasks</h2><Link to={`/tasks?new=1&property=${p.id}&company=${p.company_id}`}>New task here</Link></div>
          {tasks.length === 0 ? <Empty>No tasks.</Empty> : <ul className="list">{tasks.map((t: any) => <li key={t.id}><span><Link to={`/tasks/${t.id}`}>{t.title}</Link><br /><span className="muted small">{t.owner_name ?? 'Unassigned'} · due {fmtDate(t.due_on)}</span></span><Status s={t.status} /></li>)}</ul>}
        </section>

        {keys.length > 0 || can.manage ? (
          <section className="card" aria-labelledby="pk-h">
            <div className="row between"><h2 id="pk-h">Keys and equipment</h2>{can.manage && <Button variant="secondary" onClick={() => { setForm({ label: '' }); setDlg('key'); }}>Add key</Button>}</div>
            <p className="small muted">Access codes are not stored in the Hub. Keep them in your company’s protected key safe procedure.</p>
            {keys.length === 0 ? <Empty>No keys recorded.</Empty> : <ul className="list">{keys.map((k: any) => {
              const out = k.holder_person_id && !k.returned_at && !k.lost_reported_at;
              return (
                <li key={k.id}>
                  <span><strong>{k.label}</strong><br /><span className="muted small">{k.lost_reported_at ? `Reported lost ${fmtDate(k.lost_reported_at)}` : out ? `With ${k.holder_name} since ${fmtDate(k.issued_at)}` : 'In the office'}</span></span>
                  {can.manage && <span className="row">
                    {!out && !k.lost_reported_at && <Button variant="secondary" onClick={() => { setKeyId(k.id); setForm({ holder: '' }); setDlg('issue'); }}>Issue</Button>}
                    {out && <Button variant="secondary" busy={keyAction.busy} onClick={() => keyAction.run(k.id, 'return')}>Record return</Button>}
                    {!k.lost_reported_at && <Button variant="ghost" onClick={() => keyAction.run(k.id, 'lost')}>Report lost</Button>}
                  </span>}
                </li>
              );
            })}</ul>}
            <ErrorSummary error={keyAction.error} />
          </section>
        ) : null}

        {(allocations.length > 0 || can.assign) && (
          <section className="card" aria-labelledby="pa-h">
            <div className="row between"><h2 id="pa-h">Staff</h2>{can.assign && <Button variant="secondary" onClick={() => setDlg('assign')}><Icon name="plus" size={18} />Assign staff</Button>}</div>
            {current.length === 0 ? <Empty>No one is allocated to this property.</Empty> : (
              <ul className="list">{current.map((a: any) => (
                <li key={a.id}>
                  <span className="row"><Avatar personId={a.person_id} name={a.person_name} /><span><Link to={`/people/${a.person_id}`}>{a.person_name}</Link> <CompanyBadge code={a.company_code} /><br /><span className="muted small">{a.job_title} · since {fmtDate(a.from_date)}</span></span></span>
                  {hub.can('appointments.manage', a.company_id) && <Button variant="ghost" busy={endAlloc.busy} onClick={() => endAlloc.run(a.id)}>End allocation</Button>}
                </li>
              ))}</ul>
            )}
            <ErrorSummary error={endAlloc.error} />
            {allocations.length > current.length && (
              <details style={{ marginTop: 12 }}><summary>Earlier allocations ({allocations.length - current.length})</summary>
                <ul className="list">{allocations.filter((a: any) => a.to_date).map((a: any) => <li key={a.id}><span><Link to={`/people/${a.person_id}`}>{a.person_name}</Link> <CompanyBadge code={a.company_code} /><br /><span className="muted small">{a.job_title}</span></span><span className="small">{fmtDate(a.from_date)} – {fmtDate(a.to_date)}</span></li>)}</ul>
              </details>
            )}
          </section>
        )}

        {photos.length > 0 && (
          <section className="card" aria-labelledby="pp-h">
            <h2 id="pp-h">Visit photos</h2>
            <p className="small muted">The latest photos taken on visits, newest first. Open a photo to see it full size.</p>
            <PhotoGrid photos={photos} caption={(ph) => <>{ph.person_name}, {fmtDate(ph.started_at)} · <Link to={`/visits/${ph.visit_id}`}>visit</Link></>} />
          </section>
        )}
      </div>

      {dlg === 'assign' && (
        <AllocateDialog title={`Assign staff to ${p.name}`} searchLabel="Search staff" loading={assignable.loading}
          options={assignable.data?.map((x) => ({ key: x.id, appointmentId: x.id, propertyId: p.id, title: x.person_name, sub: x.job_title, companyCode: x.company_code, personId: x.person_id, hasPhoto: x.has_photo })) ?? null}
          onClose={() => setDlg(null)} onDone={() => { setDlg(null); d.reload(); }} />
      )}
      <Dialog open={dlg === 'complaint'} onClose={() => setDlg(null)} title={`Log a complaint at ${p.name}`} footer={<Button busy={logComplaint.busy} onClick={() => logComplaint.run()}>Send to complaints manager</Button>}>
        <ErrorSummary error={logComplaint.error} />
        <ComplaintFields value={complaint} onChange={setComplaint} error={logComplaint.error?.fields.summary} />
      </Dialog>
      {dlg === 'start' && <StartVisitDialog property={{ ...p, my_appointments }} onClose={() => setDlg(null)} />}
      {dlg === 'edit' && <PropertyForm existing={p} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); d.reload(); }} />}
      <Dialog open={dlg === 'key'} onClose={() => setDlg(null)} title="Add a key or item" variant="modal" footer={<Button busy={addKey.busy} onClick={() => addKey.run()}>Add</Button>}>
        <ErrorSummary error={addKey.error} />
        <Field label="Label" hint="For example ‘Front door set 3’. Never write an access code here." error={addKey.error?.fields.label}><input name="label" value={form.label ?? ''} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={dlg === 'issue'} onClose={() => setDlg(null)} title="Issue key" variant="modal" footer={<Button busy={keyAction.busy} disabled={!form.holder} onClick={() => keyAction.run(keyId, 'issue', { holder_person_id: form.holder })}>Issue key</Button>}>
        <ErrorSummary error={keyAction.error} />
        <Field label="Who is taking it?"><select name="holder" value={form.holder ?? ''} onChange={(e) => setForm({ ...form, holder: e.target.value })}><option value="">Choose…</option>{people.data?.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></Field>
      </Dialog>
      <Dialog open={dlg === 'schedule'} onClose={() => setDlg(null)} title="Plan a visit" footer={<Button busy={schedule.busy} onClick={() => schedule.run()}>Save plan</Button>}>
        <p className="small muted">A plan is not recorded time. The worker still starts and finishes the visit.</p>
        <ErrorSummary error={schedule.error} />
        <Field label="Who and which role">
          <select name="appointment_id" value={form.appointment_id ?? ''} onChange={(e) => setForm({ ...form, appointment_id: e.target.value })}>
            <option value="">Choose…</option>
            {staff.data?.flatMap((x) => x.appointments.filter((a: any) => a.company_id === p.company_id && a.status === 'active').map((a: any) => <option key={`${x.id}${a.job_title}`} value={a.appointment_id ?? ''} disabled={!a.appointment_id}>{x.full_name} — {a.job_title}</option>))}
          </select>
        </Field>
        <Field label="Planned start" hint="UK time" error={schedule.error?.fields.planned_start}><input name="planned_start" type="datetime-local" value={form.planned_start ?? ''} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></Field>
        <Field label="Planned minutes" error={schedule.error?.fields.planned_minutes}><input name="planned_minutes" type="number" min={5} max={720} value={form.planned_minutes ?? ''} onChange={(e) => setForm({ ...form, planned_minutes: e.target.value })} style={{ maxWidth: 160 }} /></Field>
      </Dialog>
    </>
  );
}
