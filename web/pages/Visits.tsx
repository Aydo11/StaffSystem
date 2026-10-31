import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, post, serverNow, upload, useApi, useSubmit } from '../api.ts';
import { addDays, fmtDate, fmtDateTime, fmtDay, fmtElapsed, fmtMinutes, fmtTime, label, londonLocal, londonToday, weekStart } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, CompanyBadge, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, PhotoGrid, Skeleton, Status, useToast } from '../ui.tsx';
import { blankExtras, EXTRA_LABELS, extrasPayload, rated, VisitExtras, type Extras } from '../condition.tsx';
import { distanceText, FAR, here, MapEmbed } from '../geo.tsx';

export const CATEGORIES: [string, string][] = [['support_work', 'Support work'], ['inspection', 'Inspection'], ['maintenance', 'Maintenance'], ['cleaning', 'Cleaning'], ['key_handover', 'Key handover'], ['property_check', 'Property check'], ['administration', 'Administration'], ['other', 'Other']];
const SUMMARY_HINT = 'Property work only, in a sentence or two. Do not record resident names or support matters here — those belong in the support system.';

const PHOTO_HINT = 'Optional. Photos of the property and the work only — never of residents or their belongings. JPEG, PNG or WebP, up to 10 MB each.';
// Remembered on this device to save taps next time (a convenience only).
const remember = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(`hub.${k}`) ?? ''; localStorage.setItem(`hub.${k}`, v); } catch { /* storage may be blocked */ } return ''; };

function WorkType({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <fieldset className="field" id="f-work_category" tabIndex={-1} style={{ border: 0, padding: 0 }} aria-describedby={error ? 'wt-err' : undefined}>
      <legend>Type of work</legend>
      {error && <span className="err" id="wt-err">Error: {error}</span>}
      <Chips label="Type of work" value={value} onChange={onChange} options={CATEGORIES as [string, string][]} />
      {value === 'support_work' && <span className="hint" style={{ marginTop: 8 }}>Support work is approved automatically — no manager review needed.</span>}
    </fieldset>
  );
}

// Uploads chosen photos one by one after the visit is saved; returns how many failed (the visit itself is already safe).
// Uploads to a visit's photos, or to any other photo endpoint given as a path (e.g. a repair reported from the visit).
export async function uploadPhotos(visitId: string, files: File[], onProgress: (n: number | null) => void) {
  let failed = 0;
  for (const [i, f] of files.entries()) {
    try { await upload(visitId.startsWith('/') ? visitId : `/visits/${visitId}/photos`, f, f.name, (pct) => onProgress(Math.round(((i + pct / 100) / files.length) * 100))); } catch { failed++; }
  }
  onProgress(null);
  return failed;
}

function ApptChoice({ appts, value, onChange, error }: { appts: any[]; value: string; onChange: (v: string) => void; error?: string }) {
  if (!appts.length) return <div className="notice warn">You have no current role that covers this property. Ask your manager to allocate it to you.</div>;
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 16px' }} aria-describedby={error ? 'appt-err' : undefined}>
      <legend>Which company and role is this work for?</legend>
      {error && <span className="err" id="appt-err">Error: {error}</span>}
      {appts.map((a) => (
        <label key={a.id} className="check card" style={{ padding: 12, marginBottom: 8, cursor: 'pointer', borderColor: value === a.id ? 'var(--navy)' : undefined }}>
          <input type="radio" name="appointment_id" value={a.id} checked={value === a.id} onChange={() => onChange(a.id)} />
          <span><CompanyBadge code={a.company_code} name={a.company_name} /> <strong>{a.company_name}</strong><br /><span className="muted small">{a.job_title}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

export function StartVisitDialog({ property, scheduledVisitId, onClose }: { property: any; scheduledVisitId?: string; onClose: () => void }) {
  const { reloadMe } = useHub();
  const nav = useNavigate();
  const appts = property.my_appointments ?? [];
  const [appt, setAppt] = useState(appts.length === 1 ? appts[0].id : '');
  const [planned, setPlanned] = useState<string>('60');
  const requestId = useRef(crypto.randomUUID()); // same id for retries, so a double tap or network retry makes one visit
  const start = useSubmit(async () => {
    if (!appt) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { appointment_id: 'Choose the company and role' } });
    await post('/visits/start', { property_id: property.id, appointment_id: appt, client_request_id: requestId.current, planned_minutes: planned === 'none' ? undefined : Number(planned), scheduled_visit_id: scheduledVisitId, geo: await here() });
    await reloadMe();
    onClose();
    nav('/visit');
  });
  return (
    <Dialog open onClose={onClose} title={`Start a visit at ${property.name}`}>
      <ErrorSummary error={start.error} labels={{ appointment_id: 'Company and role' }} />
      <ApptChoice appts={appts} value={appt} onChange={setAppt} error={start.error?.fields.appointment_id} />
      <p className="small muted">Your location is recorded once when you press Start and once when you finish, to show the visit happened at the property. It is not tracked during the visit. If you do not allow location, the visit still starts.</p>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend>Expected length <span className="muted">(for planning and lone-worker check-in)</span></legend>
        <span className="hint">This is not your recorded time. Your time is measured from Start to Finish.</span>
        <Chips label="Expected length" value={planned} onChange={setPlanned} options={[['30', '30 min'], ['60', '1 h'], ['90', '1 h 30'], ['120', '2 h'], ['none', 'Not sure']]} />
      </fieldset>
      <p className="small muted">The start time is recorded by the server when you press Start Visit. If your expected finish passes, you will be asked to check in; this is not a monitored emergency service.</p>
      <Button variant="go" big block busy={start.busy} busyText="Starting…" onClick={() => start.run()} disabled={!appts.length}>Start Visit</Button>
    </Dialog>
  );
}

// ── Live visit ──
export function ActiveVisit() {
  const { me, reloadMe } = useHub();
  const v = me.activeVisit;
  const toast = useToast();
  const [now, setNow] = useState(serverNow());
  const draftKey = v ? `hub.visitDraft.${v.id}` : '';
  const [draft, setDraft] = useState<{ work_category: string; summary: string; extras: Extras }>(() => {
    try { const d = JSON.parse(localStorage.getItem(draftKey) || ''); return { ...d, extras: d.extras ?? blankExtras() }; } catch { return { work_category: '', summary: '', extras: blankExtras() }; }
  });
  const [review, setReview] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<any>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [repairPhotos, setRepairPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (draftKey) try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* drafts are a convenience */ } }, [draft, draftKey]);

  const finish = useSubmit(async () => {
    const fields: Record<string, string> = {};
    if (!draft.work_category) fields.work_category = 'Choose the type of work';
    if (draft.summary.trim().length < 3) fields.summary = 'Add a brief summary of the work';
    if (!rated(draft.extras)) fields.rating = 'Give the house mood rating: rate at least one part of the home';
    if (Object.keys(fields).length) { setReview(false); throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields }); }
    const r = await post(`/visits/${v!.id}/finish`, { work_category: draft.work_category, summary: draft.summary, ...extrasPayload(draft.extras), geo: await here() });
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    setReview(false);
    const failed = (photos.length ? await uploadPhotos(r.id, photos, setProgress) : 0) + (r.repair_id && repairPhotos.length ? await uploadPhotos(`/repairs/${r.repair_id}/photos`, repairPhotos, setProgress) : 0);
    setDone({ ...r, photos: photos.length - failed, failed });
    await reloadMe();
  });
  const extend = useSubmit(async (minutes: number) => { await post(`/visits/${v!.id}/extend`, { minutes }); await reloadMe(); toast(`Check-in recorded. Next check-in in ${minutes} minutes.`); });
  const doCancel = useSubmit(async () => { await post(`/visits/${v!.id}/cancel`, { reason }); setCancel(false); await reloadMe(); toast('Visit cancelled. No time was recorded.'); });

  if (done) return (
    <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
      <span className="done-check" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 12l5 5L20 6" /></svg></span>
      <h1 id="page-title" tabIndex={-1} style={{ marginTop: 16 }}>Visit saved</h1>
      <p>{fmtMinutes(done.minutes)} recorded ({fmtTime(done.started_at)}–{fmtTime(done.ended_at)}){done.photos > 0 && <> with {done.photos} photo{done.photos === 1 ? '' : 's'}</>}. {done.status === 'approved' ? 'Support work is approved automatically, so it already counts towards your timesheet.' : 'It is now waiting for your manager’s review.'}</p>
      {done.failed > 0 && <p className="notice warn">{done.failed} photo{done.failed === 1 ? '' : 's'} did not upload. Open the visit to add {done.failed === 1 ? 'it' : 'them'} again.</p>}
      <div className="row" style={{ justifyContent: 'center' }}><Link className="btn" to="/">Back to My Day</Link><Link className="btn secondary" to={`/visits/${done.id}`}>View visit</Link></div>
    </div>
  );
  if (!v) return (<><PageHead title="No visit in progress" /><p><Link className="btn" to="/properties?mine=true">Choose a property to start a visit</Link></p></>);

  const elapsed = now - Date.parse(v.started_at);
  const overdue = v.expected_end_at && now > Date.parse(v.expected_end_at);
  return (
    <>
      <PageHead title={`Visit at ${v.property_name}`} crumbs={[['My Day', '/'], ['Visit in progress']]} intro={<><CompanyBadge code={v.company_code} name={v.company_name} /> {v.company_name} · started {fmtTime(v.started_at)}</>} />
      <div className="grid-2">
        <section className="card" style={{ textAlign: 'center' }} aria-labelledby="t-h">
          <h2 id="t-h" className="sr-only">Timer</h2>
          <div className="timer-big" role="timer" aria-label={`Time on visit: ${fmtMinutes(Math.floor(elapsed / 60000))}`}>{fmtElapsed(elapsed)}</div>
          <p className="muted">Started {fmtDateTime(v.started_at)}{v.expected_end_at && <> · expected finish {fmtTime(v.expected_end_at)}</>}</p>
          {overdue && (
            <div className="notice warn" role="alert" style={{ textAlign: 'left' }}>
              <strong>Your expected finish time has passed.</strong> Please check in so your named contact knows you are OK. If you are in danger, call 999.
              <div className="row" style={{ marginTop: 8 }}><Button variant="secondary" busy={extend.busy} onClick={() => extend.run(30)}>I’m OK — 30 more minutes</Button><Button variant="secondary" disabled={extend.busy} onClick={() => extend.run(60)}>I’m OK — 1 more hour</Button></div>
            </div>
          )}
          <Button variant="go" big block onClick={() => setReview(true)}>Finish Visit</Button>
          <p style={{ marginTop: 12 }}><button type="button" className="btn ghost" onClick={() => setCancel(true)}>Started this by mistake?</button></p>
        </section>
        <section className="card" aria-labelledby="w-h">
          <h2 id="w-h">Work details</h2>
          <p className="small muted">Saved on this device as you type, so you won’t lose it if the page reloads.</p>
          <ErrorSummary error={finish.error} labels={EXTRA_LABELS} />
          <WorkType value={draft.work_category} onChange={(v) => setDraft({ ...draft, work_category: v })} error={finish.error?.fields.work_category} />
          <Field label="What did you do?" hint={SUMMARY_HINT} error={finish.error?.fields.summary}>
            <textarea name="summary" maxLength={500} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          </Field>
          <FilePicker label="Photos of the property" hint={PHOTO_HINT} accept="image/jpeg,image/png,image/webp" multiple busy={progress !== null} progress={progress} onChange={setPhotos} />
          <VisitExtras value={draft.extras} onChange={(x) => setDraft({ ...draft, extras: x })} ratingError={finish.error?.fields.rating} fieldErrors={finish.error?.fields} onRepairPhotos={setRepairPhotos} />
        </section>
      </div>
      <Dialog open={review} onClose={() => setReview(false)} title="Check your visit" variant="modal"
        footer={<><Button variant="go" busy={finish.busy} busyText={progress !== null ? `Uploading photos… ${progress}%` : 'Saving…'} onClick={() => finish.run()}>Save Visit</Button><Button variant="secondary" onClick={() => setReview(false)}>Keep working</Button></>}>
        <dl className="facts">
          <dt>Property</dt><dd>{v.property_name}</dd>
          <dt>Company</dt><dd>{v.company_name}</dd>
          <dt>Started</dt><dd>{fmtDateTime(v.started_at)}</dd>
          <dt>Duration so far</dt><dd><strong>{fmtMinutes(Math.floor(elapsed / 60000))}</strong></dd>
          <dt>Type</dt><dd>{label(draft.work_category) || 'Not chosen'}</dd>
          <dt>Photos</dt><dd>{photos.length || 'None'}</dd>
          <dt>House mood</dt><dd>{rated(draft.extras) ? 'Rated' : <strong>Not rated yet</strong>}</dd>
          {extrasPayload(draft.extras).complaint && <><dt>Complaint</dt><dd>Will be sent to the complaints manager</dd></>}
          {extrasPayload(draft.extras).repair && <><dt>Maintenance</dt><dd>{draft.extras.repair.title}</dd></>}
        </dl>
        <p className="small muted" style={{ marginTop: 16 }}>The finish time is recorded by the server when you press Save Visit. If the times are wrong later, you can request a correction.</p>
      </Dialog>
      <Dialog open={cancel} onClose={() => setCancel(false)} title="Cancel this visit?" variant="modal"
        footer={<><Button variant="danger" busy={doCancel.busy} onClick={() => doCancel.run()} disabled={reason.trim().length < 3}>Cancel visit</Button><Button variant="secondary" onClick={() => setCancel(false)}>Keep visit</Button></>}>
        <p>Cancelled visits record no time. This is kept in the history.</p>
        <ErrorSummary error={doCancel.error} />
        <Field label="Reason"><textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

// ── Completed visit logged afterwards ──
export function ManualVisit() {
  const [params] = useSearchParams();
  const props = useApi<any[]>('/properties?mine=true');
  const nav = useNavigate();
  const toast = useToast();
  const nowLocal = londonLocal();
  const [f, setF] = useState({ property_id: params.get('property') ?? remember('lastProperty'), appointment_id: '', date: nowLocal.slice(0, 10), time: '', preset: remember('lastDuration') || '60', custom: '', work_category: remember('lastWorkType'), summary: '' });
  const [extras, setExtras] = useState<Extras>(blankExtras);
  const [confirmUnusual, setConfirmUnusual] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [repairPhotos, setRepairPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const prop = props.data?.find((p) => p.id === f.property_id);
  const appts = prop?.my_appointments ?? [];
  useEffect(() => { if (appts.length === 1) setF((x) => ({ ...x, appointment_id: appts[0].id })); }, [f.property_id, props.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // One property: choose it. A remembered property that is no longer yours: clear it.
  useEffect(() => {
    if (!props.data) return;
    if (props.data.length === 1 && !f.property_id) setF((x) => ({ ...x, property_id: props.data![0].id }));
    else if (f.property_id && !props.data.some((p) => p.id === f.property_id)) setF((x) => ({ ...x, property_id: '' }));
  }, [props.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const minutes = f.preset === 'custom' ? Number(f.custom) : Number(f.preset);
  const endLabel = useMemo(() => {
    if (!f.time || !minutes) return null;
    const [h, m] = f.time.split(':').map(Number);
    const t = h * 60 + m + minutes;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}${t >= 1440 ? ' (next day)' : ''}`;
  }, [f.time, minutes]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  // "I've just finished": start = now minus the chosen duration (UK time).
  const justFinished = () => {
    if (!minutes) return;
    const start = londonLocal(new Date(Date.now() - minutes * 60000));
    setF({ ...f, date: start.slice(0, 10), time: start.slice(11, 16) });
  };

  const save = useSubmit(async () => {
    const fields: Record<string, string> = {};
    if (!f.property_id) fields.property_id = 'Choose a property';
    if (!f.appointment_id) fields.appointment_id = 'Choose the company and role';
    if (!f.time) fields.time = 'Enter the actual start time';
    if (!minutes || minutes < 1) fields.custom = 'Enter the number of minutes';
    if (!f.work_category) fields.work_category = 'Choose the type of work';
    if (f.summary.trim().length < 3) fields.summary = 'Add a brief summary';
    if (!rated(extras)) fields.rating = 'Give the house mood rating: rate at least one part of the home';
    if (Object.keys(fields).length) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields });
    try {
      const r = await post('/visits/manual', { property_id: f.property_id, appointment_id: f.appointment_id, start_local: `${f.date}T${f.time}`, minutes, work_category: f.work_category, summary: f.summary, client_request_id: requestId.current, confirm_unusual: confirmUnusual || undefined, ...extrasPayload(extras) });
      remember('lastProperty', f.property_id); remember('lastWorkType', f.work_category); remember('lastDuration', f.preset);
      const failed = (photos.length && !r.duplicate ? await uploadPhotos(r.visit.id, photos, setProgress) : 0) + (r.visit.repair_id && repairPhotos.length ? await uploadPhotos(`/repairs/${r.visit.repair_id}/photos`, repairPhotos, setProgress) : 0);
      toast(r.duplicate ? 'This visit was already saved.' : failed ? `Visit saved. ${failed} photo${failed === 1 ? '' : 's'} did not upload — add ${failed === 1 ? 'it' : 'them'} again on the visit.` : `Visit saved${photos.length ? ` with ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''} ${r.visit.status === 'approved' ? 'and approved automatically (support work)' : 'and sent for review'}.`);
      nav(`/visits/${r.visit.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unusual_duration') setConfirmUnusual(false);
      throw e;
    }
  });
  const unusual = save.error?.code === 'unusual_duration';
  const errs: Record<string, string> = { ...save.error?.fields, ...(save.error?.fields.start_local ? { time: save.error.fields.start_local } : {}) };

  return (
    <>
      <PageHead title="Log a completed visit" crumbs={[['My Day', '/'], ['Log completed visit']]} intro="For work you have already finished. It is labelled as a manual entry with the time you submitted it." />
      <form className="card" style={{ maxWidth: 720 }} noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }}>
        <ErrorSummary error={unusual ? null : save.error} labels={{ property_id: 'Property', appointment_id: 'Company and role', time: 'Start time', custom: 'Duration', ...EXTRA_LABELS }} />
        {props.loading && !props.data ? <Skeleton /> : (
          <Field label="Property" error={errs.property_id}>
            <select name="property_id" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value, appointment_id: '' })}>
              <option value="">Choose…</option>
              {props.data?.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.ref} ({p.company_code})</option>)}
            </select>
          </Field>
        )}
        {prop && <ApptChoice appts={appts} value={f.appointment_id} onChange={(v) => setF({ ...f, appointment_id: v })} error={errs.appointment_id} />}
        <div className="form-grid">
          <Field label="Date"><input name="date" type="date" max={nowLocal.slice(0, 10)} value={f.date} onChange={set('date')} /></Field>
          <Field label="Actual start time" hint="UK time" error={errs.time}><input name="time" type="time" value={f.time} onChange={set('time')} /></Field>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0 }}>
          <legend>How long did it take?</legend>
          <Chips label="Duration" value={f.preset} onChange={(v) => setF({ ...f, preset: v })} options={[['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 h'], ['90', '1 h 30'], ['120', '2 h'], ['custom', 'Custom']]} />
        </fieldset>
        {minutes > 0 && <p><Button variant="secondary" onClick={justFinished}>I’ve just finished — fill in the times</Button></p>}
        {f.preset === 'custom' && <Field label="Minutes" error={errs.custom}><input name="custom" type="number" inputMode="numeric" min={1} max={720} value={f.custom} onChange={set('custom')} style={{ maxWidth: 160 }} /></Field>}
        {endLabel && <p className="notice" aria-live="polite">Finish time will be <strong>{endLabel}</strong> ({fmtMinutes(minutes)}).</p>}
        <WorkType value={f.work_category} onChange={(v) => setF({ ...f, work_category: v })} error={errs.work_category} />
        <Field label="What did you do?" hint={SUMMARY_HINT} error={errs.summary}><textarea name="summary" maxLength={500} value={f.summary} onChange={set('summary')} /></Field>
        <FilePicker label="Photos of the property" hint={PHOTO_HINT} accept="image/jpeg,image/png,image/webp" multiple busy={progress !== null} progress={progress} onChange={setPhotos} />
        <VisitExtras value={extras} onChange={setExtras} ratingError={errs.rating} fieldErrors={errs} onRepairPhotos={setRepairPhotos} />
        {unusual && (
          <div className="notice warn" role="alert">
            <p><strong>{save.error!.message}</strong></p>
            <label className="check"><input type="checkbox" checked={confirmUnusual} onChange={(e) => setConfirmUnusual(e.target.checked)} /> Yes, this duration is correct</label>
          </div>
        )}
        <Button type="submit" variant="go" big busy={save.busy} busyText={progress !== null ? `Uploading photos… ${progress}%` : 'Saving…'} disabled={unusual && !confirmUnusual}>Save for review</Button>
      </form>
    </>
  );
}

// ── Visit detail: approval, split, corrections ──
// "Started 40 m from the property (±12 m)", or why there is no location.
const where = (lat: number | null, d: number | null, acc: number | null, what: string) => lat == null ? <span className="muted">{what}: location not shared</span>
  : <span>{what} {d == null ? 'with location recorded (the property has no map pin yet)' : `${distanceText(d)} from the property`}{acc != null && <span className="muted"> (accurate to about {distanceText(acc)})</span>}{d != null && d > FAR && <> <Status s="correction" text="Far from the property" /></>}</span>;

export function VisitDetail() {
  const { id } = useParams();
  const d = useApi<any>(`/visits/${id}`);
  const toast = useToast();
  const { reloadMe, me } = useHub();
  const [mode, setMode] = useState<null | 'reject' | 'correct' | 'split' | 'ack' | { decideCorrection: any }>(null);
  const [note, setNote] = useState('');
  const [corr, setCorr] = useState({ start: '', end: '', reason: '' });
  const [split, setSplit] = useState<Record<string, string>>({});
  const done = async (msg: string) => { setMode(null); setNote(''); toast(msg); await d.reload(); reloadMe(); };

  const decide = useSubmit(async (approve: boolean) => { await post(`/visits/${id}/decide`, { approve, note: note || undefined }); await done(approve ? 'Visit approved.' : 'Visit returned to the worker.'); });
  const correct = useSubmit(async () => { await post(`/visits/${id}/corrections`, { start_local: corr.start, end_local: corr.end, reason: corr.reason }); await done('Correction requested. The original times are kept.'); });
  const decideCorr = useSubmit(async (cid: string, approve: boolean) => { await post(`/corrections/${cid}/decide`, { approve, note: note || undefined }); await done(approve ? 'Correction approved. The visit now needs approval again.' : 'Correction not approved.'); });
  const doSplit = useSubmit(async () => {
    const allocations = Object.entries(split).filter(([, m]) => Number(m) > 0).map(([appointment_id, m]) => ({ appointment_id, minutes: Number(m) }));
    await post(`/visits/${id}/split`, { allocations, reason: note });
    await done('Time split between companies.');
  });
  const ack = useSubmit(async () => { await post(`/visits/${id}/ack-checkin`, { note }); await done('Check recorded.'); });
  const [photoProgress, setPhotoProgress] = useState<number | null>(null);
  const addPhotos = useSubmit(async (files: File[]) => {
    const failed = await uploadPhotos(id!, files, setPhotoProgress);
    await d.reload();
    if (failed) throw new ApiError(0, 'error', `${failed} photo${failed === 1 ? '' : 's'} did not upload. Check they are JPEG, PNG or WebP under 10 MB and try again.`);
    toast(`${files.length} photo${files.length === 1 ? '' : 's'} added.`);
  });
  const removePhoto = useSubmit(async (ph: any) => { await api('DELETE', `/visits/${id}/photos/${ph.id}`); toast('Photo removed.'); await d.reload(); });

  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { visit: v, corrections, allocations, can, splitAppointments, photos } = d.data;
  const pending = corrections.find((c: any) => c.status === 'pending');
  const toLocal = (iso: string) => (iso ? londonLocal(new Date(iso)) : '');
  const splitTotal = Object.values(split).reduce((s, m) => s + (Number(m) || 0), 0);

  return (
    <>
      <PageHead title={`Visit at ${v.property_name}`} crumbs={[['Visits & attendance', '/attendance'], [fmtDate(v.started_at)]]}
        intro={<><CompanyBadge code={v.company_code} name={v.company_name} /> {v.company_name} · {v.person_name}</>}
        actions={<Status s={v.status} />} />
      {pending && <div className="notice warn"><strong>Correction requested</strong> — waiting for a manager’s decision.</div>}
      <div className="grid-2">
        <section className="card" aria-labelledby="vd-h">
          <h2 id="vd-h">What happened</h2>
          <dl className="facts">
            <dt>Worker</dt><dd>{v.person_name} — {v.job_title}</dd>
            <dt>Company</dt><dd>{v.company_name}</dd>
            <dt>Property</dt><dd><Link to={`/properties/${v.property_id}`}>{v.property_name}</Link> ({v.property_ref})</dd>
            <dt>Recorded</dt><dd>{v.entry_mode === 'live' ? 'Live (Start/Finish)' : v.entry_mode === 'schedule' ? 'From the weekly support schedule (not individually logged; times not recorded)' : <>Manual entry, submitted {fmtDateTime(v.submitted_at)}</>}</dd>
            {v.entry_mode === 'schedule' ? <><dt>Date</dt><dd>{fmtDate(v.started_at)}</dd><dt>Hours</dt><dd>{fmtMinutes(v.minutes)}</dd></> : <>
            <dt>Start</dt><dd>{fmtDateTime(v.started_at)}</dd>
            <dt>Finish</dt><dd>{v.ended_at ? fmtDateTime(v.ended_at) : <Status s="correction" text="No finish time recorded" />}</dd></>}
            {v.entry_mode === 'live' && <><dt>Location</dt><dd>{where(v.start_lat, v.start_distance_m, v.start_accuracy_m, 'Started')}<br />{v.ended_at && where(v.finish_lat, v.finish_distance_m, v.finish_accuracy_m, 'Finished')}</dd></>}
            <dt>Duration</dt><dd>{v.ended_at ? fmtMinutes(v.minutes) : '—'}{v.planned_minutes && <span className="muted"> (planned {fmtMinutes(v.planned_minutes)})</span>}</dd>
            <dt>Work</dt><dd>{label(v.work_category)}</dd>
            <dt>Summary</dt><dd>{v.summary ?? '—'}</dd>
            {v.decided_by_name && <><dt>Decision</dt><dd>{label(v.status)} by {v.decided_by_name}, {fmtDateTime(v.decided_at)}{v.decision_note && <> — “{v.decision_note}”</>}</dd></>}
          </dl>
        </section>
        {v.start_lat != null && <section className="card" aria-labelledby="vm-h"><h2 id="vm-h">Where they started</h2><MapEmbed lat={v.start_lat} lng={v.start_lng} title={`Map of where the visit to ${v.property_name} was started`} /></section>}
        <section className="card" aria-labelledby="next-h">
          <h2 id="next-h">What happens next</h2>
          {v.status === 'submitted' && <p>Waiting for a manager in {v.company_name} to approve it. Approved time counts towards timesheets and KPIs.</p>}
          {v.status === 'approved' && <p>Approved. The time is allocated as shown below.</p>}
          {v.status === 'rejected' && <p>Returned. If the times were wrong, request a correction.</p>}
          {v.status === 'in_progress' && <p>The visit has not been finished yet.</p>}
          <div className="row">
            {can.decide && <><Button variant="go" busy={decide.busy} onClick={() => decide.run(true)}>Approve</Button><Button variant="secondary" onClick={() => setMode('reject')}>Return with a note</Button></>}
            {can.split && splitAppointments.length > 1 && <Button variant="secondary" onClick={() => { setSplit(Object.fromEntries(allocations.map((a: any) => [a.appointment_id, String(a.minutes)]))); setMode('split'); }}>Split between companies</Button>}
            {can.correct && <Button variant="secondary" onClick={() => { setCorr({ start: toLocal(v.started_at), end: toLocal(v.ended_at), reason: '' }); setMode('correct'); }}>Request a correction</Button>}
            {v.status === 'in_progress' && v.expected_end_at && !v.checkin_ack_at && can.decideCorrections && <Button variant="secondary" onClick={() => setMode('ack')}>Record that I checked on them</Button>}
          </div>
          <ErrorSummary error={decide.error} />
          {allocations.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}><table><caption>Time allocation</caption><thead><tr><th>Company</th><th>Role</th><th className="num">Minutes</th></tr></thead>
              <tbody>{allocations.map((a: any) => <tr key={a.company_id}><td><CompanyBadge code={a.company_code} name={a.company_name} /> {a.company_name}</td><td>{a.job_title}</td><td className="num">{a.minutes}</td></tr>)}</tbody></table></div>
          )}
        </section>
      </div>

      {(photos.length > 0 || can.addPhotos) && (
        <section className="card" aria-labelledby="ph-h" style={{ marginTop: 16 }}>
          <h2 id="ph-h">Photos</h2>
          {photos.length === 0 ? <p className="muted">No photos yet.</p> : (
            <PhotoGrid photos={photos} caption={(ph) => `${ph.uploaded_by_name}, ${fmtDateTime(ph.uploaded_at)}`}
              canRemove={(ph) => v.status !== 'approved' && ph.uploaded_by === me.person.id} onRemove={(ph) => removePhoto.run(ph)} />
          )}
          <ErrorSummary error={addPhotos.error ?? removePhoto.error} />
          {can.addPhotos && <FilePicker label="Add photos" hint={PHOTO_HINT} accept="image/jpeg,image/png,image/webp" multiple instant busy={photoProgress !== null} progress={photoProgress} onChange={(fs) => addPhotos.run(fs)} />}
        </section>
      )}

      {corrections.length > 0 && (
        <section className="card" aria-labelledby="corr-h" style={{ marginTop: 16 }}>
          <h2 id="corr-h">Correction history</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Requested</th><th>Original</th><th>Proposed</th><th>Reason</th><th>Outcome</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{corrections.map((c: any) => (
              <tr key={c.id}>
                <td>{fmtDateTime(c.created_at)}<br /><span className="muted small">{c.requested_by_name}</span></td>
                <td>{fmtTime(c.original.started_at)}–{c.original.ended_at ? fmtTime(c.original.ended_at) : 'no finish'}<br /><span className="muted small">{fmtDate(c.original.started_at)}</span></td>
                <td>{fmtTime(c.proposed.started_at)}–{fmtTime(c.proposed.ended_at)}<br /><span className="muted small">{fmtDate(c.proposed.started_at)}</span></td>
                <td>{c.reason}</td>
                <td><Status s={c.status === 'pending' ? 'submitted' : c.status} text={c.status === 'pending' ? 'Awaiting Review' : undefined} />{c.decided_by_name && <div className="muted small">{c.decided_by_name}{c.decision_note && `: ${c.decision_note}`}</div>}</td>
                <td>{c.status === 'pending' && can.decideCorrections && <div className="row"><Button variant="go" busy={decideCorr.busy} onClick={() => decideCorr.run(c.id, true)}>Approve</Button><Button variant="secondary" onClick={() => setMode({ decideCorrection: c })}>Reject</Button></div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <ErrorSummary error={decideCorr.error} />
        </section>
      )}

      <Dialog open={mode === 'reject'} onClose={() => setMode(null)} title="Return this visit" variant="modal" footer={<Button variant="danger" busy={decide.busy} onClick={() => decide.run(false)}>Return visit</Button>}>
        <ErrorSummary error={decide.error} />
        <Field label="What needs to change?" hint="The worker will see this note."><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={typeof mode === 'object' && mode !== null} onClose={() => setMode(null)} title="Reject correction" variant="modal" footer={<Button variant="danger" busy={decideCorr.busy} onClick={() => decideCorr.run((mode as any).decideCorrection.id, false)}>Reject correction</Button>}>
        <ErrorSummary error={decideCorr.error} />
        <Field label="Why is it not approved?"><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={mode === 'correct'} onClose={() => setMode(null)} title="Request a correction" footer={<Button busy={correct.busy} onClick={() => correct.run()}>Send for review</Button>}>
        <p>The original times stay on record. A manager must approve the change, and the visit will then need approving again.</p>
        <ErrorSummary error={correct.error} labels={{ start_local: 'Correct start', end_local: 'Correct finish' }} />
        <Field label="Correct start" hint="UK time" error={correct.error?.fields.start_local}><input name="start_local" type="datetime-local" value={corr.start} onChange={(e) => setCorr({ ...corr, start: e.target.value })} /></Field>
        <Field label="Correct finish" hint="UK time. Enter the real finish time — it is never guessed for you." error={correct.error?.fields.end_local}><input name="end_local" type="datetime-local" value={corr.end} onChange={(e) => setCorr({ ...corr, end: e.target.value })} /></Field>
        <Field label="Reason" error={correct.error?.fields.reason}><textarea name="reason" value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={mode === 'split'} onClose={() => setMode(null)} title="Split time between companies" footer={<Button busy={doSplit.busy} disabled={splitTotal !== v.minutes || note.trim().length < 3} onClick={() => doSplit.run()}>Save split</Button>}>
        <p>The parts must add up to exactly {fmtMinutes(v.minutes)} ({v.minutes} minutes). Time is moved, never duplicated.</p>
        <ErrorSummary error={doSplit.error} />
        {splitAppointments.map((a: any) => (
          <Field key={a.id} label={`${a.company_name} — ${a.job_title}`}><input name={`split-${a.id}`} type="number" inputMode="numeric" min={0} value={split[a.id] ?? ''} onChange={(e) => setSplit({ ...split, [a.id]: e.target.value })} style={{ maxWidth: 160 }} /></Field>
        ))}
        <p aria-live="polite"><strong>Total: {splitTotal} of {v.minutes} minutes</strong>{splitTotal !== v.minutes && <span className="muted"> — {v.minutes - splitTotal} left to allocate</span>}</p>
        <Field label="Reason for the split"><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={mode === 'ack'} onClose={() => setMode(null)} title="Record a welfare check" variant="modal" footer={<Button busy={ack.busy} disabled={note.trim().length < 3} onClick={() => ack.run()}>Save</Button>}>
        <p>Record how you confirmed the worker is safe. This does not replace calling 999 in an emergency.</p>
        <ErrorSummary error={ack.error} />
        <Field label="What did you do?"><textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

// ── Attendance: day / week / month / year ──
type View = 'day' | 'week' | 'month' | 'year';
export function Attendance() {
  const hub = useHub();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View) ?? 'week';
  const date = params.get('date') ?? londonToday();
  const team = params.get('team') === '1' && hub.can('visits.view_all');
  const setP = (o: Record<string, string>) => setParams({ view, date, ...(team ? { team: '1' } : {}), ...o });
  const range = view === 'day' ? [date, date] : view === 'week' ? [weekStart(date), addDays(weekStart(date), 6)] : view === 'month' ? [`${date.slice(0, 7)}-01`, addDays(`${date.slice(0, 7)}-01`, 40).slice(0, 7) + '-01'] : [`${date.slice(0, 4)}-01-01`, `${date.slice(0, 4)}-12-31`];
  const to = view === 'month' ? addDays(range[1], -1) : range[1];
  const person = team ? null : 'me';
  const list = useApi<any[]>(view === 'year' ? null : `/visits${hub.q({ from: range[0], to, person })}`);
  const sched = useApi<any[]>(view === 'year' ? null : `/schedule?from=${range[0]}&to=${to}`);
  const heat = useApi<any[]>(view === 'year' ? `/attendance/heatmap${hub.q({ year: date.slice(0, 4), person })}` : null);
  const step = (n: number) => setP({ date: view === 'day' ? addDays(date, n) : view === 'week' ? addDays(date, 7 * n) : view === 'month' ? addDays(`${date.slice(0, 7)}-15`, 30 * n) : `${Number(date.slice(0, 4)) + n}-06-15` });
  const title = view === 'day' ? fmtDay(date) : view === 'week' ? `Week of ${fmtDate(range[0])}` : view === 'month' ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${date.slice(0, 7)}-15T12:00Z`)) : date.slice(0, 4);

  const missed = (sched.data ?? []).filter((s) => s.missed && (team || s.person_id === hub.me.person.id));
  const rows = list.data ?? [];
  const totals = rows.reduce((t, v) => ({ rec: t.rec + (['submitted', 'approved'].includes(v.status) ? v.minutes ?? 0 : 0), app: t.app + (v.status === 'approved' ? v.minutes : 0) }), { rec: 0, app: 0 });

  return (
    <>
      <PageHead title="Visits & attendance" intro="Recorded visits show when someone started and finished work. They are not proof of continuous presence."
        actions={<><Link className="btn secondary" to="/visits/new">Log Completed Visit</Link><Link className="btn go" to="/properties?mine=true">Start Visit</Link></>} />
      <div className="row between" style={{ marginBottom: 16 }}>
        <Chips label="View" value={view} onChange={(v) => setP({ view: v })} options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']]} />
        {hub.can('visits.view_all') && <Chips label="Whose visits" value={team ? 'team' : 'me'} onChange={(v) => setParams({ view, date, ...(v === 'team' ? { team: '1' } : {}) })} options={[['me', 'Mine'], ['team', 'Everyone I manage']]} />}
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => step(-1)} aria-label="Previous period">‹ Previous</Button>
        <h2 style={{ margin: 0 }} aria-live="polite">{title}</h2>
        <Button variant="secondary" onClick={() => step(1)} aria-label="Next period">Next ›</Button>
        <Button variant="ghost" onClick={() => setP({ date: londonToday() })}>Today</Button>
      </div>

      {view === 'year' ? <Heatmap year={date.slice(0, 4)} data={heat.data} loading={heat.loading} onPick={(d) => setP({ view: 'day', date: d })} /> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="value">{fmtMinutes(totals.rec)}</div><div className="label">Recorded</div><div className="explain">Submitted and approved visits</div></div>
            <div className="kpi"><div className="value">{fmtMinutes(totals.app)}</div><div className="label">Approved</div><div className="explain">Counts towards timesheets</div></div>
            <div className="kpi"><div className="value">{rows.filter((v) => v.status === 'submitted').length}</div><div className="label">Awaiting review</div></div>
            <div className="kpi"><div className="value">{missed.length}</div><div className="label">Missed planned visits</div><div className="explain">Planned, with no visit recorded</div></div>
          </div>
          {list.error && <LoadError error={list.error} retry={list.reload} />}
          {list.loading && !list.data ? <Skeleton /> : rows.length === 0 && missed.length === 0 ? <Empty>No visits in this period.</Empty> : (
            <div className="table-wrap"><table>
              <caption className="sr-only">Visits for {title}</caption>
              <thead><tr><th>When</th>{team && <th>Who</th>}<th>Property</th><th>Company</th><th className="num">Duration</th><th>Status</th></tr></thead>
              <tbody>
                {missed.map((s) => <tr key={s.id}><td>{fmtDay(s.planned_start)} {fmtTime(s.planned_start)}</td>{team && <td>{s.person_name}</td>}<td>{s.property_name}</td><td><CompanyBadge code={s.company_code} name={s.company_name} /></td><td className="num">planned {fmtMinutes(s.planned_minutes)}</td><td><Status s="missed" /></td></tr>)}
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td><Link to={`/visits/${v.id}`}>{fmtDay(v.started_at)}{v.entry_mode !== 'schedule' && <> {fmtTime(v.started_at)}–{v.ended_at ? fmtTime(v.ended_at) : '…'}</>}</Link>{v.entry_mode === 'manual' && <div className="muted small">Manual entry</div>}{v.entry_mode === 'schedule' && <div className="muted small">From weekly schedule</div>}</td>
                    {team && <td>{v.person_name}</td>}
                    <td>{v.property_name}</td><td><CompanyBadge code={v.company_code} name={v.company_name} /></td>
                    <td className="num">{v.ended_at ? fmtMinutes(v.minutes) : '—'}</td>
                    <td><Status s={v.missing_clock_out ? 'correction' : v.status} text={v.missing_clock_out ? 'No finish time' : undefined} />{v.correction_pending && <div><Status s="correction" text="Correction pending" /></div>}{v.entry_mode === 'live' && !v.geotagged && <div className="small muted">Location not shared</div>}{v.start_distance_m > FAR && <div><Status s="correction" text={`Started ${distanceText(v.start_distance_m)} away`} /></div>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </>
  );
}

function Heatmap({ year, data, loading, onPick }: { year: string; data: any[] | null; loading: boolean; onPick: (d: string) => void }) {
  if (loading && !data) return <Skeleton />;
  const by = new Map((data ?? []).map((d) => [d.day, d]));
  const first = `${year}-01-01`;
  const lead = (new Date(`${first}T12:00Z`).getUTCDay() + 6) % 7;
  const days: string[] = [];
  for (let d = first; d.startsWith(year); d = addDays(d, 1)) days.push(d);
  const level = (m: number) => (m === 0 ? 0 : m < 60 ? 1 : m < 180 ? 2 : m < 360 ? 3 : 4);
  const active = (data ?? []).filter((d) => d.visits > 0);
  return (
    <section className="card" aria-labelledby="hm-h">
      <h2 id="hm-h">Approved visit time, {year}</h2>
      <p className="muted small">Each square is one day (Monday at the top). Choose a day to see its visits. The table below lists the same information.</p>
      <div className="heat" role="group" aria-label={`Calendar heatmap for ${year}`}>
        {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
        {days.map((d) => {
          const x = by.get(d);
          const m = x?.approved_minutes ?? 0;
          return <button key={d} type="button" className={`h${level(m)}`} onClick={() => onPick(d)} aria-label={`${fmtDate(d)}: ${x ? `${x.visits} visit${x.visits === 1 ? '' : 's'}, ${fmtMinutes(m)} approved, ${fmtMinutes(x.recorded_minutes)} recorded` : 'no visits'}`} title={`${fmtDate(d)} — ${fmtMinutes(m)} approved`} />;
        })}
      </div>
      <div className="legend" aria-hidden="true">Less <span className="h0" /><span className="h1" /><span className="h2" /><span className="h3" /><span className="h4" /> More</div>
      <details style={{ marginTop: 16 }}>
        <summary>Show as a table ({active.length} days with visits)</summary>
        <div className="table-wrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>Date</th><th className="num">Visits</th><th className="num">Recorded</th><th className="num">Approved</th></tr></thead>
          <tbody>{active.map((d) => <tr key={d.day}><td><button type="button" className="btn ghost" onClick={() => onPick(d.day)}>{fmtDate(d.day)}</button></td><td className="num">{d.visits}</td><td className="num">{fmtMinutes(d.recorded_minutes)}</td><td className="num">{fmtMinutes(d.approved_minutes)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>
  );
}
