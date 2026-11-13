// Rooms and voids (server: routes/voids.ts). The property's manager sees and updates its rooms; voids overview roles see
// every property in their companies. Status buttons sit apart from "View room details" so opening a room never changes it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bath, Camera, Check, CircleHelp, DoorClosed, DoorOpen, Download, Layers, Pencil, Undo2, Wrench } from 'lucide-react';
import { api, ApiError, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime } from '../format.ts';
import { AuthImage, Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, PhotoGrid, Skeleton, useToast } from '../ui.tsx';
import { csv, save as download } from '../xlsx.ts';

export const SIZE: Record<string, string> = { single: 'Single', double: 'Double' };
export const BATH: Record<string, string> = { ensuite: 'En-suite', shared: 'Shared bathroom' };
export const FLOOR: Record<string, string> = { lower_ground: 'Lower ground', ground: 'Ground floor', first: 'First floor', second: 'Second floor', third_plus: 'Third floor or above' };
const FLOOR_ORDER = ['ground', 'first', 'second', 'third_plus', 'lower_ground'];
const STATUS: Record<string, { label: string; cls: string; Icon: any }> = {
  available: { label: 'Available', cls: 'vd-available', Icon: DoorOpen },
  filled: { label: 'Filled', cls: 'vd-filled', Icon: DoorClosed },
  unavailable: { label: 'Temporarily unavailable', cls: 'vd-unavailable', Icon: Wrench },
  not_set: { label: 'Status not set', cls: 'vd-notset', Icon: CircleHelp },
};
const attrs = (r: any) => [SIZE[r.size], BATH[r.bathroom], FLOOR[r.floor]].filter(Boolean);
const complete = (r: any) => !!(r.size && r.bathroom && r.floor);
function since(iso: string | null) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days < 1 ? 'Available since today' : `Available for ${days} day${days === 1 ? '' : 's'}`;
}

export function StatusTag({ s }: { s: string }) {
  const st = STATUS[s] ?? STATUS.not_set;
  return <span className={`vd-tag ${st.cls}`}><st.Icon size={16} aria-hidden="true" />{st.label}</span>;
}

// ── Voids overview: only the properties this person may see ──
export function VoidsPage() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(['company', 'property', 'size', 'bathroom', 'floor', 'available'].map((k) => [k, params.get(k) ?? '']));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const d = useApi<any>(`/voids${qs ? `?${qs}` : ''}`);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k === 'company') n.delete('property'); setParams(n, { replace: true }); };
  const filtering = !!(f.size || f.bathroom || f.floor || f.available);
  const exportCsv = () => {
    const rows = d.data.rooms.map((r: any) => [r.property_name, r.company_code, r.label, STATUS[r.status].label, SIZE[r.size] ?? '', BATH[r.bathroom] ?? '', FLOOR[r.floor] ?? '', r.void_started_at ? fmtDate(r.void_started_at) : '']);
    download(csv([['Property', 'Organisation', 'Room', 'Status', 'Size', 'Bathroom', 'Floor', 'Available since'], ...rows]), 'rooms-and-voids.csv');
  };
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { totals, properties, rooms, companies } = d.data;
  const tiles: [string, number, string][] = [['Total rooms', totals.rooms, ''], ['Available now', totals.available, 'vd-available'], ['Filled', totals.filled, 'vd-filled'], ['Temporarily unavailable', totals.unavailable, 'vd-unavailable']];
  return (
    <>
      <PageHead title="Voids" intro="Which rooms are free across the properties you manage." actions={rooms.length > 0 && <Button variant="secondary" onClick={exportCsv}><Download size={18} aria-hidden="true" />Export rooms (CSV)</Button>} />
      <ul className="vd-tiles" aria-label="Room totals">{tiles.map(([t, n, cls]) => <li key={t} className={cls}><strong>{n}</strong><span>{t}</span></li>)}</ul>
      {totals.not_set > 0 && <p className="small muted">{totals.not_set} room{totals.not_set === 1 ? ' has' : 's have'} no status set yet.</p>}
      <section className="card vd-filters" aria-label="Filters">
        {companies.length > 1 && <Field label="Organisation"><select name="company" value={f.company} onChange={(e) => set('company', e.target.value)}><option value="">All</option>{companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        <Field label="Property"><select name="property" value={f.property} onChange={(e) => set('property', e.target.value)}><option value="">All</option>{properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Room size"><select name="size" value={f.size} onChange={(e) => set('size', e.target.value)}><option value="">Any</option>{Object.entries(SIZE).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Bathroom"><select name="bathroom" value={f.bathroom} onChange={(e) => set('bathroom', e.target.value)}><option value="">Any</option>{Object.entries(BATH).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Floor"><select name="floor" value={f.floor} onChange={(e) => set('floor', e.target.value)}><option value="">Any</option>{FLOOR_ORDER.map((k) => <option key={k} value={k}>{FLOOR[k]}</option>)}</select></Field>
        <label className="check vd-avail-filter"><input type="checkbox" checked={!!f.available} onChange={(e) => set('available', e.target.checked ? '1' : '')} /> Available now</label>
      </section>
      {filtering ? (
        <section className="card" aria-labelledby="vd-match-h">
          <h2 id="vd-match-h">{rooms.length} matching room{rooms.length === 1 ? '' : 's'}</h2>
          {rooms.length === 0 ? <Empty>No rooms match these filters.</Empty> : <ul className="vd-match">{rooms.map((r: any) => (
            <li key={r.id}><Link to={`/properties/${r.property_id}?tab=rooms&room=${r.id}`} className="vd-match-link">
              {r.photo_id ? <AuthImage url={`/files/${r.photo_id}`} alt="" className="vd-thumb" /> : <span className="vd-thumb vd-thumb-empty" aria-hidden="true"><Camera size={20} /></span>}
              <span className="vd-card-text"><span><strong>{r.property_name} · {r.label}</strong> <CompanyBadge code={r.company_code} /></span><StatusTag s={r.status} />
                <span className="small">{attrs(r).join(' · ') || 'Details not added'}</span>
                {r.status === 'available' && r.void_started_at && <span className="small muted">{since(r.void_started_at)}</span>}</span></Link></li>))}</ul>}
        </section>
      ) : (
        <section className="card" aria-labelledby="vd-props-h">
          <h2 id="vd-props-h">Properties</h2>
          {properties.length === 0 ? <Empty>You have no properties to manage here. Ask an administrator if you think you should.</Empty> : (
            <div className="table-wrap"><table>
              <caption className="sr-only">Rooms and voids by property</caption>
              <thead><tr><th scope="col">Property</th><th scope="col">Organisation</th><th scope="col">Total rooms</th><th scope="col">Voids now</th></tr></thead>
              <tbody>{properties.map((p: any) => <tr key={p.id}>
                <td><Link to={`/properties/${p.id}?tab=rooms`}><strong>{p.name}</strong></Link><div className="small muted">{p.ref}</div></td>
                <td>{p.company_name}</td>
                <td>{p.total || <span className="muted">Not set up</span>}</td>
                <td>{p.total ? <span className={p.available ? 'vd-count vd-available' : 'vd-count'}>{p.available} of {p.total}</span> : '—'}{p.unavailable > 0 && <div className="small muted">{p.unavailable} temporarily unavailable</div>}</td>
              </tr>)}</tbody>
            </table></div>)}
        </section>
      )}
    </>
  );
}

// ── "Rooms & Voids" tab on a property ──
type Undo = { room: any; event_id: number; text: string } | null;
export function RoomsTab({ propertyId }: { propertyId: string }) {
  const [params, setParams] = useSearchParams();
  const d = useApi<any>(`/properties/${propertyId}/rooms`);
  const [rooms, setRooms] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'warn' | 'bad' } | null>(null);
  const [undo, setUndo] = useState<Undo>(null);
  const [choose, setChoose] = useState<{ room: any; then?: string } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [total, setTotal] = useState(false);
  const [rename, setRename] = useState(false);
  const openId = params.get('room');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('room', id); else n.delete('room'); setParams(n, { replace: true }); };
  useEffect(() => { if (d.data) setRooms(d.data.rooms); }, [d.data]);
  const live = useRef<HTMLDivElement>(null);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data || !rooms) return <Skeleton lines={6} />;
  const canEdit = d.data.can.edit;
  const replace = (r: any) => setRooms((rs) => rs!.map((x) => (x.id === r.id ? r : x)));
  const fail = (e: any) => {
    if (e instanceof ApiError && e.code === 'stale' && e.details?.room) { replace(e.details.room); setMsg({ text: e.message, tone: 'warn' }); }
    else if (e instanceof ApiError && e.status === 400 && e.details?.code === 'needs_details') setMsg({ text: e.message, tone: 'warn' });
    else setMsg({ text: e instanceof ApiError ? e.message : 'That did not save. Check your connection and try again.', tone: 'bad' });
  };
  // One tap: saves, recolours the card and updates the totals; offers Undo.
  const setStatus = async (r: any, status: string, extra: any = {}) => {
    if (status === 'available' && !complete({ ...r, ...extra })) { setChoose({ room: r, then: 'available' }); return; }
    setBusy((b) => ({ ...b, [r.id]: true })); setMsg(null);
    try {
      const out = await api('PATCH', `/rooms/${r.id}`, { version: r.version, status, ...extra });
      replace(out.room);
      const text = `${r.label} marked ${STATUS[status].label.toLowerCase()}`;
      setUndo(out.event_id ? { room: out.room, event_id: out.event_id, text } : null);
      setMsg({ text, tone: 'ok' });
    } catch (e) { fail(e); } finally { setBusy((b) => ({ ...b, [r.id]: false })); }
  };
  const doUndo = async () => {
    if (!undo) return;
    const cur = rooms.find((x) => x.id === undo.room.id) ?? undo.room;
    setBusy((b) => ({ ...b, [cur.id]: true }));
    try { const out = await post(`/rooms/${cur.id}/undo`, { event_id: undo.event_id, version: cur.version }); replace(out.room); setMsg({ text: `Undone: ${cur.label} is ${STATUS[out.room.status].label.toLowerCase()} again`, tone: 'ok' }); setUndo(null); }
    catch (e) { fail(e); setUndo(null); } finally { setBusy((b) => ({ ...b, [cur.id]: false })); }
  };
  const bulk = async (status: 'available' | 'filled') => {
    const chosen = rooms.filter((r) => picked.includes(r.id));
    try {
      const out = await post(`/properties/${propertyId}/rooms/status`, { status, rooms: chosen.map((r) => ({ id: r.id, version: r.version })) });
      await d.reload();
      const needs = chosen.filter((r) => out.needs_details.includes(r.id)).map((r) => r.label);
      const stale = chosen.filter((r) => out.conflicts.includes(r.id)).map((r) => r.label);
      setMsg({ tone: needs.length || stale.length ? 'warn' : 'ok', text: [`${out.updated.length} room${out.updated.length === 1 ? '' : 's'} marked ${status}.`,
        needs.length ? `${needs.join(', ')} need${needs.length === 1 ? 's' : ''} size, bathroom and floor first: open ${needs.length === 1 ? 'it' : 'each'} and choose them.` : '',
        stale.length ? `${stale.join(', ')} changed while you were choosing and ${stale.length === 1 ? 'was' : 'were'} left as ${stale.length === 1 ? 'it was' : 'they were'}.` : ''].filter(Boolean).join(' ') });
      setUndo(null); setPicked([]); setSelecting(false);
    } catch (e) { fail(e); }
  };
  if (rooms.length === 0) return canEdit ? <SetupRooms propertyId={propertyId} onDone={d.reload} /> : <section className="card"><Empty>The rooms for this property have not been set up yet.</Empty></section>;
  const available = rooms.filter((r) => r.status === 'available').length;
  const n = (s: string) => rooms.filter((r) => r.status === s).length;
  const open = rooms.find((r) => r.id === openId);
  return (
    <section className="card" aria-labelledby="vd-h">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div><h2 id="vd-h" style={{ marginBottom: 4 }}>{available} of {rooms.length} rooms available</h2>
          <p className="small muted" style={{ margin: 0 }}>{n('filled')} filled{n('unavailable') ? ` · ${n('unavailable')} temporarily unavailable` : ''}{n('not_set') ? ` · ${n('not_set')} status not set` : ''}</p></div>
        {canEdit && <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button variant={selecting ? 'primary' : 'secondary'} onClick={() => { setSelecting(!selecting); setPicked([]); }}>{selecting ? 'Done selecting' : 'Select rooms'}</Button>
          <Button variant="ghost" onClick={() => setRename(true)}><Pencil size={16} aria-hidden="true" />Rename rooms</Button>
          <Button variant="ghost" onClick={() => setTotal(true)}>Change number of rooms</Button></div>}
      </div>
      <div ref={live} role="status" aria-live="polite" className="vd-live">
        {msg && <div className={`notice ${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? 'warn' : 'bad'} vd-msg`}>{msg.tone === 'ok' && <Check size={18} aria-hidden="true" />}<span>{msg.text}</span>
          {undo && msg.tone === 'ok' && <Button variant="secondary" onClick={doUndo} busy={busy[undo.room.id]} busyText="Undoing…"><Undo2 size={16} aria-hidden="true" />Undo</Button>}</div>}
      </div>
      {selecting && <div className="vd-bulk"><span>{picked.length} selected</span>
        <Button variant="secondary" onClick={() => setPicked(picked.length === rooms.length ? [] : rooms.map((r) => r.id))}>{picked.length === rooms.length ? 'Clear' : 'Select all'}</Button>
        <Button disabled={!picked.length} onClick={() => bulk('available')}>Mark available</Button>
        <Button variant="secondary" disabled={!picked.length} onClick={() => bulk('filled')}>Mark filled</Button></div>}
      <ul className="vd-grid">{rooms.map((r) => {
        const st = STATUS[r.status];
        const action = r.status === 'available' ? ['filled', 'Mark filled'] : ['available', 'Mark available'];
        return <li key={r.id} className={`vd-card ${st.cls}`}>
          {selecting && <label className="vd-pick"><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /><span className="sr-only">Select {r.label}</span></label>}
          <button type="button" className="vd-card-body" onClick={() => setOpen(r.id)} aria-label={`View room details: ${r.label}, ${st.label}`}>
            {r.photo_id ? <AuthImage url={`/files/${r.photo_id}`} alt="" className="vd-thumb" /> : null}
            <span className="vd-card-text"><strong className="vd-label">{r.label}</strong><StatusTag s={r.status} />
              {attrs(r).length > 0 && <span className="vd-attrs">{attrs(r).join(' · ')}</span>}
              {r.status === 'available' && <span className="small muted">{since(r.void_started_at)}</span>}
              {r.status === 'unavailable' && r.unavailable_reason && <span className="small muted">{r.unavailable_reason}</span>}</span>
          </button>
          {canEdit && !selecting && <div className="vd-actions">
            <Button variant={r.status === 'available' ? 'secondary' : 'go'} busy={busy[r.id]} busyText="Saving…" onClick={() => setStatus(r, action[0])} aria-label={`${action[1]}: ${r.label}`}>{action[1]}</Button>
            {r.status === 'not_set' && <Button variant="secondary" busy={busy[r.id]} busyText="Saving…" onClick={() => setStatus(r, 'filled')} aria-label={`Mark filled: ${r.label}`}>Mark filled</Button>}
          </div>}
        </li>;
      })}</ul>
      {choose && <QuickChoices room={choose.room} makeAvailable={choose.then === 'available'} onClose={() => setChoose(null)}
        onSaved={(out) => { replace(out.room); setChoose(null); if (out.event_id) { const text = `${out.room.label} marked available`; setUndo({ room: out.room, event_id: out.event_id, text }); setMsg({ text, tone: 'ok' }); } else setMsg({ text: `${out.room.label} details saved`, tone: 'ok' }); }}
        onStale={(e) => { fail(e); setChoose(null); }} />}
      {open && <RoomDetail roomId={open.id} canEdit={canEdit} onClose={() => setOpen(null)} onChanged={(r) => { replace(r); }} onEditDetails={(r) => { setOpen(null); setChoose({ room: r }); }} onStale={fail} />}
      {total && <TotalDialog propertyId={propertyId} rooms={rooms} onClose={() => setTotal(false)} onDone={() => { setTotal(false); setMsg({ text: 'Number of rooms updated.', tone: 'ok' }); setUndo(null); d.reload(); }} />}
      {rename && <RenameDialog rooms={rooms} onClose={() => setRename(false)} onDone={() => { setRename(false); setMsg({ text: 'Room names saved.', tone: 'ok' }); setUndo(null); d.reload(); }} />}
    </section>
  );
}

// First setup: a slider for speed, a number field for keyboards, screen readers and bigger properties.
function SetupRooms({ propertyId, onDone }: { propertyId: string; onDone: () => void }) {
  const [n, setN] = useState(4);
  const save = useSubmit(async () => { await post(`/properties/${propertyId}/rooms`, { count: n }); onDone(); });
  return (
    <section className="card" aria-labelledby="vd-setup-h">
      <h2 id="vd-setup-h">How many rooms does this property have?</h2>
      <p className="small muted">We will create Room 1 to Room {n}. You can rename them to match the property's own numbering, and every room starts as "Status not set".</p>
      <ErrorSummary error={save.error} />
      <div className="vd-count-pick">
        <input type="range" min={1} max={30} value={Math.min(n, 30)} onChange={(e) => setN(Number(e.target.value))} aria-label="Number of rooms (slider)" />
        <Field label="Number of rooms"><input type="number" name="count" min={1} max={200} inputMode="numeric" value={n} onChange={(e) => setN(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} /></Field>
      </div>
      <Button big busy={save.busy} onClick={() => save.run()}>Create {n} room{n === 1 ? '' : 's'}</Button>
    </section>
  );
}

// Three required choices (big buttons) plus optional notes. Saved on the room for next time.
function QuickChoices({ room, makeAvailable, onClose, onSaved, onStale }: { room: any; makeAvailable: boolean; onClose: () => void; onSaved: (out: any) => void; onStale: (e: any) => void }) {
  const [f, setF] = useState({ size: room.size ?? '', bathroom: room.bathroom ?? '', floor: room.floor ?? '', description: room.description ?? '', access_notes: room.access_notes ?? '' });
  const save = useSubmit(async () => {
    try { onSaved(await api('PATCH', `/rooms/${room.id}`, { version: room.version, ...f, size: f.size || null, bathroom: f.bathroom || null, floor: f.floor || null,
      description: f.description.trim() || null, access_notes: f.access_notes.trim() || null, ...(makeAvailable ? { status: 'available' } : {}) })); }
    catch (e) { if (e instanceof ApiError && e.code === 'stale') onStale(e); else throw e; }
  });
  const missing = makeAvailable && !(f.size && f.bathroom && f.floor);
  const group = (key: 'size' | 'bathroom' | 'floor', title: string, opts: [string, string][]) => (
    <fieldset className="vd-opts"><legend>{title} <span className="small muted">(required)</span></legend>
      <div className="vd-opt-row">{opts.map(([k, t]) => <label key={k} className={`vd-opt${f[key] === k ? ' on' : ''}`}><input type="radio" name={key} value={k} checked={f[key] === k} onChange={() => setF({ ...f, [key]: k })} />{t}</label>)}</div>
    </fieldset>);
  return (
    <Dialog open onClose={onClose} title={makeAvailable ? `Make ${room.label} available` : `${room.label}: details`}
      footer={<Button big busy={save.busy} disabled={missing} onClick={() => save.run()}>{makeAvailable ? 'Save and mark available' : 'Save details'}</Button>}>
      {makeAvailable && <p className="small">Choose one option in each group. They are saved on the room so you only do this once.</p>}
      <ErrorSummary error={save.error} />
      {group('size', 'Room size', Object.entries(SIZE))}
      {group('bathroom', 'Bathroom', Object.entries(BATH))}
      {group('floor', 'Floor', FLOOR_ORDER.map((k) => [k, FLOOR[k]]))}
      <Field label="Short description" optional hint="Useful matching details, for example: Ground-floor double near the entrance. Shared kitchen. No resident details.">
        <textarea name="description" rows={2} maxLength={600} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Access notes" optional hint="Facts only, for example: Two steps at the front door. Do not describe the room as fully accessible unless it has been assessed.">
        <textarea name="access_notes" rows={2} maxLength={600} value={f.access_notes} onChange={(e) => setF({ ...f, access_notes: e.target.value })} /></Field>
      {missing && <p className="small muted">Choose size, bathroom and floor to continue.</p>}
    </Dialog>
  );
}

function RoomDetail({ roomId, canEdit, onClose, onChanged, onEditDetails, onStale }: { roomId: string; canEdit: boolean; onClose: () => void; onChanged: (r: any) => void; onEditDetails: (r: any) => void; onStale: (e: any) => void }) {
  const toast = useToast();
  const d = useApi<any>(`/rooms/${roomId}`);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const act = useSubmit(async (status: string, reason?: string) => {
    try { const out = await api('PATCH', `/rooms/${roomId}`, { version: d.data.room.version, status, reason: reason || null }); onChanged(out.room); toast(`${out.room.label}: ${STATUS[status].label.toLowerCase()}.`); setBlocking(null); d.reload(); }
    catch (e) { if (e instanceof ApiError && e.code === 'stale') { onStale(e); d.reload(); } else throw e; }
  });
  const addPhoto = useSubmit(async (file: File) => { await upload(`/rooms/${roomId}/photos`, file, file.name, undefined, replacing ? { replace: replacing } : {}); setReplacing(null); toast(replacing ? 'Photo replaced.' : 'Photo added.'); await d.reload(); refreshCard(); });
  const removePhoto = useSubmit(async (p: any) => { await api('DELETE', `/rooms/${roomId}/photos/${p.id}`); toast('Photo removed.'); await d.reload(); refreshCard(); });
  const refreshCard = async () => { const x = await api('GET', `/rooms/${roomId}`); onChanged(x.room); };
  const title = d.data ? `${d.data.property.name} · ${d.data.room.label}` : 'Room';
  return (
    <Dialog open onClose={onClose} title={title}>
      {d.error ? <LoadError error={d.error} retry={d.reload} /> : !d.data ? <Skeleton lines={6} /> : (() => {
        const { room: r, photos, history } = d.data;
        return <>
          <p><StatusTag s={r.status} />{r.status === 'available' && <span className="small muted"> · {since(r.void_started_at)}</span>}{r.status === 'unavailable' && r.unavailable_reason && <span className="small muted"> · {r.unavailable_reason}</span>}</p>
          <ErrorSummary error={act.error ?? addPhoto.error ?? removePhoto.error} />
          <dl className="facts">
            <dt><DoorOpen size={16} aria-hidden="true" /> Room size</dt><dd>{SIZE[r.size] ?? <span className="muted">Not chosen</span>}</dd>
            <dt><Bath size={16} aria-hidden="true" /> Bathroom</dt><dd>{BATH[r.bathroom] ?? <span className="muted">Not chosen</span>}</dd>
            <dt><Layers size={16} aria-hidden="true" /> Floor</dt><dd>{FLOOR[r.floor] ?? <span className="muted">Not chosen</span>}</dd>
            <dt>Description</dt><dd>{r.description || <span className="muted">None</span>}</dd>
            <dt>Access notes</dt><dd>{r.access_notes || <span className="muted">None</span>}</dd>
          </dl>
          {canEdit && <div className="row" style={{ flexWrap: 'wrap', margin: '12px 0' }}>
            {r.status !== 'available' && <Button variant="go" busy={act.busy} onClick={() => (complete(r) ? act.run('available') : onEditDetails(r))}>Mark available</Button>}
            {r.status !== 'filled' && <Button variant="secondary" busy={act.busy} onClick={() => act.run('filled')}>Mark filled</Button>}
            {r.status !== 'unavailable' && <Button variant="secondary" onClick={() => setBlocking('')}>Temporarily unavailable</Button>}
            <Button variant="ghost" onClick={() => onEditDetails(r)}><Pencil size={16} aria-hidden="true" />Edit details</Button>
          </div>}
          {blocking !== null && <div className="card vd-block">
            <Field label="Why is it unavailable?" optional hint="For example: repairs, deep clean. No resident details."><input name="reason" maxLength={200} value={blocking} onChange={(e) => setBlocking(e.target.value)} /></Field>
            <div className="row"><Button busy={act.busy} onClick={() => act.run('unavailable', blocking)}>Save as temporarily unavailable</Button><Button variant="ghost" onClick={() => setBlocking(null)}>Cancel</Button></div></div>}
          <h3 style={{ fontSize: '1rem', marginTop: 16 }}>Photos</h3>
          {photos.length ? <PhotoGrid photos={photos} onRemove={canEdit ? (p) => removePhoto.run(p) : undefined} /> : <p className="small muted">No photos.</p>}
          {canEdit && <>
            {photos.length > 0 && <Field label="Replace a photo" optional><select name="replace" value={replacing ?? ''} onChange={(e) => setReplacing(e.target.value || null)}><option value="">No, add a new one</option>{photos.map((p: any, i: number) => <option key={p.id} value={p.id}>Photo {i + 1}</option>)}</select></Field>}
            {(photos.length < 6 || replacing) && <FilePicker key={photos.length + (replacing ?? '')} label={replacing ? 'Choose the new photo' : 'Add a photo'} hint="Room photos only. Keep residents, personal belongings and paperwork out of shot." accept="image/jpeg,image/png,image/webp" instant busy={addPhoto.busy} buttonText="Take or choose a photo" onChange={(fs) => fs[0] && addPhoto.run(fs[0])} />}
          </>}
          <details className="vd-history"><summary>History</summary>
            <ul className="list">{history.map((h: any) => <li key={h.id}><span className="small">{historyText(h)}<br /><span className="muted">{h.actor_name ?? 'System'} · {fmtDateTime(h.at)}</span></span></li>)}</ul></details>
        </>;
      })()}
    </Dialog>
  );
}
function historyText(h: any) {
  const S = (s: string) => STATUS[s]?.label ?? s;
  switch (h.kind) {
    case 'status': return `${h.undo_of ? 'Undo: ' : ''}${S(h.from_value?.status)} → ${S(h.to_value?.status)}${h.to_value?.reason ? ` (${h.to_value.reason})` : ''}`;
    case 'created': return `Room created as ${h.to_value?.label}`;
    case 'label': return `Renamed from ${h.from_value?.label} to ${h.to_value?.label}`;
    case 'details': return `Details changed: ${Object.keys(h.to_value ?? {}).map((k) => k.replace('_', ' ')).join(', ')}`;
    case 'photo_added': return 'Photo added';
    case 'photo_removed': return 'Photo removed';
    case 'archived': return 'Room archived';
    default: return h.kind;
  }
}

function TotalDialog({ propertyId, rooms, onClose, onDone }: { propertyId: string; rooms: any[]; onClose: () => void; onDone: () => void }) {
  const [n, setN] = useState(rooms.length);
  const [archive, setArchive] = useState<string[]>([]);
  const fewer = rooms.length - n;
  const save = useSubmit(async () => { await post(`/properties/${propertyId}/rooms/total`, { count: n, archive_ids: fewer > 0 ? archive : undefined }); onDone(); });
  return (
    <Dialog open onClose={onClose} title="Change number of rooms" footer={<Button busy={save.busy} disabled={fewer > 0 && archive.length !== fewer} onClick={() => save.run()}>Save</Button>}>
      <ErrorSummary error={save.error} />
      <div className="vd-count-pick">
        <input type="range" min={1} max={Math.max(30, rooms.length)} value={Math.min(n, Math.max(30, rooms.length))} onChange={(e) => { setN(Number(e.target.value)); setArchive([]); }} aria-label="Number of rooms (slider)" />
        <Field label="Number of rooms"><input type="number" name="count" min={1} max={200} inputMode="numeric" value={n} onChange={(e) => { setN(Math.max(1, Math.min(200, Number(e.target.value) || 1))); setArchive([]); }} /></Field>
      </div>
      {n > rooms.length && <p className="small">{n - rooms.length} new room{n - rooms.length === 1 ? '' : 's'} will be added with "Status not set".</p>}
      {fewer > 0 && <fieldset className="vd-opts"><legend>Choose {fewer} room{fewer === 1 ? '' : 's'} to archive. Their history is kept.</legend>
        {rooms.map((r) => <label key={r.id} className="check"><input type="checkbox" checked={archive.includes(r.id)} disabled={!archive.includes(r.id) && archive.length >= fewer}
          onChange={(e) => setArchive(e.target.checked ? [...archive, r.id] : archive.filter((x) => x !== r.id))} /> {r.label} <span className="small muted">· {STATUS[r.status].label}</span></label>)}</fieldset>}
    </Dialog>
  );
}

function RenameDialog({ rooms, onClose, onDone }: { rooms: any[]; onClose: () => void; onDone: () => void }) {
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(rooms.map((r) => [r.id, r.label])));
  const changed = useMemo(() => rooms.filter((r) => names[r.id].trim() && names[r.id].trim() !== r.label), [names, rooms]);
  const save = useSubmit(async () => { for (const r of changed) await api('PATCH', `/rooms/${r.id}`, { version: r.version, label: names[r.id].trim() }); onDone(); });
  return (
    <Dialog open onClose={onClose} title="Rename rooms" footer={<Button busy={save.busy} disabled={!changed.length} onClick={() => save.run()}>Save names</Button>}>
      <p className="small muted">Match the property's own numbering, for example "Flat 1A" or "Room 3 (front)". Labels only, never resident names.</p>
      <ErrorSummary error={save.error} />
      <div className="form-grid">{rooms.map((r) => <Field key={r.id} label={`Room in position ${r.position}`}><input name={`label-${r.id}`} maxLength={40} value={names[r.id]} onChange={(e) => setNames({ ...names, [r.id]: e.target.value })} /></Field>)}</div>
    </Dialog>
  );
}
