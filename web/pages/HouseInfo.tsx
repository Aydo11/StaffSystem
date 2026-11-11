// Property tabs: the house info pack and house routines (server: routes/houseinfo.ts).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate } from '../format.ts';
import { Button, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';

export const INFO_SECTIONS: [string, string, string][] = [
  ['water', 'Water and stopcock', 'Where the stopcock is and how to turn it off'],
  ['electrics', 'Electrics and fuse board', 'Where the fuse board is, which switch is which'],
  ['heating', 'Heating and hot water', 'Boiler location, thermostat, how to reset'],
  ['meters', 'Meters', 'Gas, electricity and water meters, and how to read them'],
  ['bins', 'Bins and recycling', 'Collection days, which bin when, where they go out'],
  ['wifi', 'Wifi and internet', 'Network name and password, where the router is'],
  ['fire', 'Fire alarm and escape route', 'Panel location, call points, escape route, assembly point'],
  ['house_rules', 'House rules', 'Quiet hours, visitors, shared spaces'],
  ['emergency', 'Emergency contacts', 'Landlord or agent, out-of-hours, utility emergency lines'],
  ['other', 'Anything else', 'Parking, access, quirks of the house'],
];

export function InfoPack({ propertyId }: { propertyId: string }) {
  const toast = useToast();
  const d = useApi<any>(`/properties/${propertyId}/info`);
  const [editing, setEditing] = useState<any>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const save = useSubmit(async () => { await api('PUT', `/properties/${propertyId}/info`, { sections: editing.sections, access: editing.access }); setEditing(null); toast('Info pack saved.'); d.reload(); });
  const addPhoto = useSubmit(async (section: string, file: File) => { await upload(`/properties/${propertyId}/info/photos`, file, file.name, undefined, { section }); setAdding(null); toast('Photo added.'); d.reload(); });
  const removePhoto = useSubmit(async (ph: any) => { await api('DELETE', `/properties/${propertyId}/info/photos/${ph.id}`); d.reload(); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={6} />;
  const { sections, photos, can } = d.data;
  const filled = INFO_SECTIONS.filter(([k]) => sections[k] || photos.some((p: any) => p.section === k));
  const all: [string, string, string][] = can.manage ? [...INFO_SECTIONS, ['access', 'Key safe, door and alarm codes', 'Managers only. Never put these anywhere else.']] : INFO_SECTIONS;
  const show = can.manage ? all : filled;
  return (
    <section className="card" aria-labelledby="ip-h">
      <div className="row between"><h2 id="ip-h">House info pack</h2>
        {can.manage && <Button variant="secondary" onClick={() => setEditing({ sections: { ...sections }, access: d.data.access ?? '' })}>Edit info pack</Button>}</div>
      <p className="small muted">{d.data.updated_at ? `Last updated ${fmtDate(d.data.updated_at)}${d.data.updated_by_name ? ` by ${d.data.updated_by_name}` : ''}.` : 'Not filled in yet.'} <Link to="/guides">How to use the info pack</Link></p>
      <ErrorSummary error={addPhoto.error ?? removePhoto.error} />
      {show.length === 0 ? <Empty>No information has been added for this house yet. Ask your manager.</Empty> : (
        <div className="info-grid">{show.map(([k, t, hint]) => {
          const text = k === 'access' ? d.data.access : sections[k];
          const ph = photos.filter((p: any) => p.section === k);
          return <section key={k} className={`info-sec${k === 'access' ? ' restricted' : ''}`} aria-labelledby={`ip-${k}`}>
            <h3 id={`ip-${k}`}>{t}{k === 'access' && <> <Status s="info" text="Managers only" /></>}</h3>
            {text ? <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p> : <p className="small muted">{can.manage ? hint : 'Not added yet.'}</p>}
            {ph.length > 0 && <PhotoGrid photos={ph} onRemove={can.manage ? (p) => removePhoto.run(p) : undefined} />}
            {can.manage && (adding === k
              ? <FilePicker compact label={`Add a photo: ${t}`} accept="image/jpeg,image/png,image/webp" instant busy={addPhoto.busy} buttonText="Choose photo" onChange={(fs) => fs[0] && addPhoto.run(k, fs[0])} />
              : ph.length < 6 && <button type="button" className="linkish small" onClick={() => setAdding(k)}>Add a photo</button>)}
          </section>;
        })}</div>)}
      {editing && <Dialog open onClose={() => setEditing(null)} title="Edit info pack" footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        <ErrorSummary error={save.error} />
        {INFO_SECTIONS.map(([k, t, hint]) => <Field key={k} label={t} optional hint={hint}>
          <textarea name={k} rows={3} value={editing.sections[k] ?? ''} onChange={(e) => setEditing({ ...editing, sections: { ...editing.sections, [k]: e.target.value } })} /></Field>)}
        <Field label="Key safe, door and alarm codes" optional hint="Only people who manage this house can see this. It is not written to the activity log.">
          <textarea name="access" rows={3} value={editing.access} onChange={(e) => setEditing({ ...editing, access: e.target.value })} /></Field>
      </Dialog>}
    </section>
  );
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FREQ: Record<string, string> = { daily: 'Every day', weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };
const when = (r: any) => r.frequency === 'daily' ? 'Every day' : r.frequency === 'monthly' ? `Every month on day ${r.month_day}` : `${FREQ[r.frequency]} on ${DAYS[r.weekday - 1]}`;
// Quick starts: the manager still picks the day and who does it.
const TEMPLATES: { title: string; frequency: string; details: string; checklist: string[] }[] = [
  { title: 'Put the bins out', frequency: 'weekly', details: 'Put out the bins due this week; bring them back in after collection.', checklist: ['Correct bins out', 'Area left tidy'] },
  { title: 'Weekly fire alarm test', frequency: 'weekly', details: 'Test the fire alarm from a different call point each week and record which one.', checklist: ['Alarm sounded throughout', 'Call point recorded', 'Panel shows no faults'] },
  { title: 'Communal areas clean', frequency: 'weekly', details: 'Clean the kitchen, bathroom, hallways and stairs used by everyone.', checklist: ['Kitchen', 'Bathroom', 'Hallways and stairs', 'Supplies restocked'] },
  { title: 'Check escape routes are clear', frequency: 'weekly', details: 'Hallways, stairs and exits free of obstructions; fire doors close properly.', checklist: ['Routes clear', 'Fire doors close'] },
  { title: 'Flush little-used taps and showers', frequency: 'weekly', details: 'Run any taps or showers not used in the last week for a few minutes.', checklist: [] },
  { title: 'Emergency lighting check', frequency: 'monthly', details: 'Check emergency lights come on during a short test.', checklist: [] },
];

export function Routines({ propertyId, companyId }: { propertyId: string; companyId: string }) {
  const toast = useToast();
  const d = useApi<any>(`/properties/${propertyId}/routines`);
  const staff = useApi<any[]>(`/people?company=${companyId}`);
  const [f, setF] = useState<any>(null);
  const blank = { title: '', details: '', frequency: 'weekly', weekday: 1, month_day: 1, owner_id: '', checklist: '', priority: 'normal' };
  const save = useSubmit(async () => {
    const b = { title: f.title, details: f.details || null, frequency: f.frequency, weekday: ['weekly', 'fortnightly'].includes(f.frequency) ? Number(f.weekday) : null,
      month_day: f.frequency === 'monthly' ? Number(f.month_day) : null, owner_id: f.owner_id || null, priority: f.priority,
      checklist: String(f.checklist).split('\n').map((x) => x.trim()).filter(Boolean) };
    if (f.id) await api('PATCH', `/routines/${f.id}`, b); else await post(`/properties/${propertyId}/routines`, b);
    setF(null); toast('Routine saved.'); d.reload();
  });
  const end = useSubmit(async (r: any) => { await post(`/routines/${r.id}/end`); toast('Routine stopped. Past tasks are kept.'); d.reload(); });
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={5} />;
  const { routines, can } = d.data;
  return (
    <section className="card" aria-labelledby="rt-h">
      <div className="row between"><h2 id="rt-h">House routines</h2>{can.manage && <Button variant="secondary" onClick={() => setF(blank)}>Add a routine</Button>}</div>
      <p className="small muted">Each routine becomes a task on the day it is due, for the person named (or the property manager). Missed ones show as overdue.</p>
      <ErrorSummary error={end.error} />
      {routines.length === 0 ? <Empty>No routines yet.{can.manage ? ' Add the regular jobs for this house, such as bins and the fire alarm test.' : ''}</Empty> : (
        <ul className="list">{routines.map((r: any) => <li key={r.id}>
          <span><strong>{r.title}</strong><br /><span className="small muted">{when(r)} · {r.owner_name ?? 'Property manager'}{r.checklist.length ? ` · ${r.checklist.length} checks` : ''}</span></span>
          <span className="row">{r.overdue > 0 && <Status s="action" text={`${r.overdue} overdue`} />}
            {r.last_task && <Link className="small" to={`/tasks/${r.last_task.id}`}>Latest: {fmtDate(r.last_task.due_on)}</Link>}
            {can.manage && <><Button variant="ghost" onClick={() => setF({ ...r, details: r.details ?? '', owner_id: r.owner_id ?? '', weekday: r.weekday ?? 1, month_day: r.month_day ?? 1, checklist: r.checklist.map((c: any) => c.text).join('\n') })}>Edit</Button>
              <Button variant="ghost" busy={end.busy} onClick={() => { if (confirm(`Stop the routine “${r.title}”?`)) end.run(r); }}>Stop</Button></>}</span>
        </li>)}</ul>)}
      {f && <Dialog open onClose={() => setF(null)} title={f.id ? 'Edit routine' : 'Add a routine'} footer={<Button busy={save.busy} onClick={() => save.run()}>Save</Button>}>
        <ErrorSummary error={save.error} />
        {!f.id && <Field label="Start from a common routine" optional><select name="template" value="" onChange={(e) => { const t = TEMPLATES[Number(e.target.value)]; if (t) setF({ ...f, title: t.title, frequency: t.frequency, details: t.details, checklist: t.checklist.join('\n') }); }}>
          <option value="">Choose…</option>{TEMPLATES.map((t, i) => <option key={t.title} value={i}>{t.title}</option>)}</select></Field>}
        <Field label="What needs doing" error={save.error?.fields.title}><input name="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Details" optional><textarea name="details" rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label="How often"><select name="frequency" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{Object.entries(FREQ).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          {['weekly', 'fortnightly'].includes(f.frequency) && <Field label="Day" error={save.error?.fields.weekday}><select name="weekday" value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{DAYS.map((t, i) => <option key={t} value={i + 1}>{t}</option>)}</select></Field>}
          {f.frequency === 'monthly' && <Field label="Day of the month" error={save.error?.fields.month_day}><input name="month_day" type="number" min={1} max={28} value={f.month_day} onChange={(e) => setF({ ...f, month_day: e.target.value })} /></Field>}
        </div>
        <Field label="Who does it" hint="Leave as the property manager, or choose someone." error={save.error?.fields.owner_id}><select name="owner_id" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
          <option value="">The property manager</option>{staff.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
        <Field label="Checklist" optional hint="One check per line. They appear as tick boxes on the task."><textarea name="checklist" rows={4} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></Field>
        <Field label="Priority"><select name="priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</select></Field>
      </Dialog>}
    </section>
  );
}
