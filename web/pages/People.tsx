import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, patch, post, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, label, londonToday, money } from '../format.ts';
import { useHub } from '../hub.tsx';
import { AccessLinkNotice, PersonDataActions, SignInAccess } from './DataTools.tsx';
import { Avatar, Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, Tabs, useToast } from '../ui.tsx';

export function People() {
  const hub = useHub();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(term), 250); return () => clearTimeout(t); }, [term]);
  const list = useApi<any[]>(`/people${hub.q({ q: q.length >= 2 ? q : undefined })}`);
  const [inviting, setInviting] = useState(false);
  const canInvite = hub.me.companies.some((c) => c.perms.includes('staff.create'));
  return (
    <>
      <PageHead title="People" intro="Professional profiles of colleagues in your companies. Personal and HR details are restricted." actions={canInvite && <Button onClick={() => setInviting(true)}>Invite a person</Button>} />
      <div className="field" style={{ maxWidth: 420 }}><label htmlFor="people-q">Find a person</label><input id="people-q" type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name or staff reference" /></div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading && !list.data ? <Skeleton lines={6} /> : (list.data ?? []).length === 0 ? <Empty>No people found.</Empty> : (
        <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
          {list.data!.map((p) => (
            <li key={p.id}><Link to={`/people/${p.id}`} className="card card-link" style={{ display: 'flex', gap: 12 }}>
              <Avatar personId={p.id} name={p.full_name} hasPhoto={p.has_photo} />
              <span><strong>{p.full_name}</strong> {p.status !== 'active' && <Status s={p.status} />}<br /><span className="muted small">{p.staff_ref}</span>
                <span className="row" style={{ gap: 6, marginTop: 6 }}>{p.appointments.map((a: any, i: number) => <span key={i} className="small"><CompanyBadge code={a.company_code} name={a.company_name} /> {a.job_title}{a.status !== 'active' && ` (${label(a.status)})`}</span>)}</span>
              </span>
            </Link></li>
          ))}
        </ul>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onSaved={() => { setInviting(false); list.reload(); }} />}
    </>
  );
}

const REL: [string, string][] = [['employee', 'Employee'], ['contractor', 'Contractor'], ['agency', 'Agency worker'], ['secondment', 'Secondment'], ['volunteer', 'Volunteer'], ['other', 'Other']];

function AppointmentFields({ f, set, errors, companyId }: { f: any; set: (k: string) => (e: any) => void; errors: Record<string, string>; companyId: string }) {
  const hub = useHub();
  const managers = useApi<any[]>(companyId ? `/people?company=${companyId}` : null);
  return (
    <>
      <div className="form-grid">
        <Field label="Job title" error={errors.job_title}><input name="job_title" value={f.job_title} onChange={set('job_title')} /></Field>
        <Field label="Relationship" error={errors.relationship}><select name="relationship" value={f.relationship} onChange={set('relationship')}>{REL.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend>Legal employer or contracting entity</legend>
        <span className="hint">Being assigned to a company does not make it the legal employer. Choose one of the companies, or name another entity.</span>
        <select aria-label="Legal employer company" value={f.legal_employer_company_id} onChange={set('legal_employer_company_id')}>
          <option value="">Another organisation (name it below)</option>
          {hub.me.companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name ?? c.name}</option>)}
        </select>
        {!f.legal_employer_company_id && <Field label="Name of legal employer or contracting entity" error={errors.legal_employer_name}><input name="legal_employer_name" value={f.legal_employer_name} onChange={set('legal_employer_name')} /></Field>}
      </fieldset>
      <Field label="Responsibilities" optional><textarea name="responsibilities" value={f.responsibilities} onChange={set('responsibilities')} /></Field>
      <div className="form-grid">
        <Field label="Manager" optional><select name="manager_person_id" value={f.manager_person_id} onChange={set('manager_person_id')}><option value="">None</option>{managers.data?.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></Field>
        <Field label="Start date" error={errors.start_date}><input name="start_date" type="date" value={f.start_date} onChange={set('start_date')} /></Field>
        <Field label="Contracted or agreed hours per week" optional error={errors.contracted_hours_per_week}><input name="contracted_hours_per_week" type="number" step="0.5" min={0} max={168} value={f.contracted_hours_per_week} onChange={set('contracted_hours_per_week')} /></Field>
      </div>
    </>
  );
}
const apptBody = (f: any) => ({ relationship: f.relationship, job_title: f.job_title, responsibilities: f.responsibilities || null, manager_person_id: f.manager_person_id || null, start_date: f.start_date,
  contracted_hours_per_week: f.contracted_hours_per_week === '' ? null : Number(f.contracted_hours_per_week), legal_employer_company_id: f.legal_employer_company_id || null, legal_employer_name: f.legal_employer_company_id ? null : f.legal_employer_name || null });
const blankAppt = (companyId = '') => ({ company_id: companyId, relationship: 'employee', job_title: '', responsibilities: '', manager_person_id: '', start_date: londonToday(), contracted_hours_per_week: '', legal_employer_company_id: companyId, legal_employer_name: '' });

function InviteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('staff.create') && c.perms.includes('appointments.manage'));
  const [f, setF] = useState<any>({ email: '', full_name: '', preferred_name: '', ...blankAppt(hub.company !== 'all' ? hub.company : cos[0]?.id ?? '') });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useSubmit(async () => {
    const r = await post('/people', { email: f.email, full_name: f.full_name, preferred_name: f.preferred_name || undefined, company_id: f.company_id, ...apptBody(f) });
    toast(`Profile created. Staff reference ${r.staff_ref}.`);
    setCreated(r);
  });
  const [created, setCreated] = useState<any>(null);
  if (created) return (
    <Dialog open onClose={onSaved} title="Person invited" footer={<Button onClick={onSaved}>Done</Button>}>
      <AccessLinkNotice link={created.invite_link} email={created.invitation} purpose="invite" />
    </Dialog>
  );
  const e = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title="Invite a person" footer={<Button busy={save.busy} onClick={() => save.run()}>Create and invite</Button>}>
      <p className="small muted">If they already have a profile with another company, add an appointment to that profile instead — one person has one login.</p>
      <ErrorSummary error={save.error} />
      <Field label="Company" error={e.company_id}><select name="company_id" value={f.company_id} onChange={set('company_id')}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <div className="form-grid">
        <Field label="Full name" error={e.full_name}><input name="full_name" value={f.full_name} onChange={set('full_name')} /></Field>
        <Field label="Preferred name" optional><input name="preferred_name" value={f.preferred_name} onChange={set('preferred_name')} /></Field>
      </div>
      <Field label="Work email" error={e.email}><input name="email" type="email" value={f.email} onChange={set('email')} /></Field>
      <AppointmentFields f={f} set={set} errors={e} companyId={f.company_id} />
    </Dialog>
  );
}

// ── Person page / My Profile ──
type PTab = 'profile' | 'appointments' | 'clearance' | 'personal';
export function PersonPage({ self }: { self?: boolean }) {
  const hub = useHub();
  const params = useParams();
  const id = self ? hub.me.person.id : params.id!;
  const d = useApi<any>(`/people/${id}`);
  const [tab, setTab] = useState<PTab>('profile');
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { person: p, can, clearance, restricted, checks } = d.data;
  const isMe = id === hub.me.person.id;
  const tabs: [PTab, string][] = [['profile', 'Profile'], ['appointments', 'Appointments'], ...(clearance ? [['clearance', checks ? 'Clearance & checks' : 'Clearance'] as [PTab, string]] : []), ...(restricted ? [['personal', 'Personal details'] as [PTab, string]] : [])];
  return (
    <>
      <PageHead title={isMe ? 'My Profile' : p.full_name} crumbs={isMe ? undefined : [['People', '/people'], [p.full_name]]}
        actions={<Link className="btn secondary" to={`/people/${id}/resume`}>{isMe ? 'My Resume' : 'Professional profile'}</Link>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <Avatar personId={p.id} name={p.full_name} hasPhoto={p.has_photo} size="lg" />
        <div><strong style={{ fontSize: '1.25rem' }}>{p.full_name}</strong>{p.preferred_name && <span className="muted"> (known as {p.preferred_name})</span>}<br /><span className="muted">{p.staff_ref} · {p.email}</span> {p.status !== 'active' && <Status s={p.status} />}</div>
      </div>
      <div className="row no-print" style={{ marginBottom: 12 }}>{(isMe || restricted) && <PersonDataActions person={p} />}<SignInAccess person={p} isMe={isMe} /></div>
      <Tabs label="Profile sections" tabs={tabs} value={tab} onChange={setTab} />
      <div role="tabpanel">
        {tab === 'profile' && <ProfileTab d={d.data} isMe={isMe} reload={d.reload} />}
        {tab === 'appointments' && <AppointmentsTab d={d.data} isMe={isMe} reload={d.reload} />}
        {tab === 'clearance' && <ClearanceTab d={d.data} reload={d.reload} />}
        {tab === 'personal' && <PersonalTab d={d.data} reload={d.reload} editable={can.editRestricted} />}
      </div>
    </>
  );
}

function ProfileTab({ d, isMe, reload }: { d: any; isMe: boolean; reload: () => void }) {
  const { person: p, can, qualifications, changeRequests } = d;
  const toast = useToast();
  const { reloadMe } = useHub();
  const [edit, setEdit] = useState(false);
  const [propose, setPropose] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [qual, setQual] = useState(false);
  const [f, setF] = useState<any>({});
  const save = useSubmit(async () => {
    await patch(`/people/${p.id}`, { preferred_name: f.preferred_name || null, professional_summary: f.professional_summary || null, work_phone: f.work_phone || null, development_goals: f.development_goals || null,
      skills: f.skills.split(',').map((s: string) => s.trim()).filter(Boolean), languages: f.languages.split(',').map((s: string) => s.trim()).filter(Boolean) });
    setEdit(false); toast('Profile saved.'); reload();
  });
  const sendProposal = useSubmit(async () => {
    const list = f.field === 'skills' || f.field === 'languages';
    await post('/me/change-requests', { field: f.field, value: list ? f.value.split(',').map((s: string) => s.trim()).filter(Boolean) : f.value });
    setPropose(false); toast('Change proposed. HR will verify it.'); reload();
  });
  const decide = useSubmit(async (rid: string, approve: boolean) => { await post(`/change-requests/${rid}/decide`, { approve }); toast(approve ? 'Change applied.' : 'Change rejected.'); reload(); });
  const addQual = useSubmit(async () => { await post(`/people/${p.id}/qualifications`, { title: f.title, issuer: f.issuer || null, awarded_on: f.awarded_on || null }); setQual(false); toast('Qualification added. It will show as unverified until checked.'); reload(); });
  const verify = useSubmit(async (qid: string) => { await post(`/qualifications/${qid}/verify`); toast('Qualification verified.'); reload(); });
  const removePhoto = useSubmit(async () => { await api('DELETE', `/people/${p.id}/photo`); toast('Photo removed.'); reload(); if (isMe) reloadMe(); });
  const pending = changeRequests.filter((r: any) => r.status === 'pending');

  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="pp-h">
        <div className="row between"><h2 id="pp-h">Professional profile</h2>
          <div className="row">{can.edit && <Button variant="secondary" onClick={() => { setF({ ...p, skills: p.skills.join(', '), languages: p.languages.join(', ') }); setEdit(true); }}>Edit</Button>}
            {isMe && !can.edit && <Button variant="secondary" onClick={() => { setF({ field: 'professional_summary', value: '' }); setPropose(true); }}>Propose a change</Button>}</div></div>
        <dl className="facts">
          <dt>Summary</dt><dd>{p.professional_summary ?? '—'}</dd>
          <dt>Work phone</dt><dd>{p.work_phone ?? '—'}</dd>
          <dt>Skills</dt><dd>{p.skills.length ? p.skills.join(', ') : '—'}</dd>
          <dt>Languages</dt><dd>{p.languages.length ? p.languages.join(', ') : '—'}</dd>
          <dt>Development goals</dt><dd>{p.development_goals ?? '—'}</dd>
        </dl>
        {(isMe || can.edit) && <div className="row" style={{ marginTop: 16 }}><Button variant="secondary" onClick={() => setPhoto(true)}>{p.has_photo ? 'Replace photo' : 'Add photo'}</Button>{p.has_photo && <Button variant="ghost" busy={removePhoto.busy} onClick={() => removePhoto.run()}>Remove photo</Button>}</div>}
        {pending.length > 0 && (
          <div style={{ marginTop: 16 }}><h3>Proposed changes</h3><ul className="list">{pending.map((r: any) => (
            <li key={r.id}><span><strong>{label(r.field)}</strong>: {Array.isArray(r.proposed_value) ? r.proposed_value.join(', ') : String(r.proposed_value)}<br /><span className="muted small">Proposed {fmtDate(r.requested_at)}</span></span>
              {can.verify ? <span className="row"><Button variant="go" busy={decide.busy} onClick={() => decide.run(r.id, true)}>Approve</Button><Button variant="secondary" disabled={decide.busy} onClick={() => decide.run(r.id, false)}>Reject</Button></span> : <Status s="review" />}</li>
          ))}</ul></div>
        )}
      </section>
      <section className="card" aria-labelledby="q-h">
        <div className="row between"><h2 id="q-h">Qualifications and certificates</h2>{(isMe || can.edit) && <Button variant="secondary" onClick={() => { setF({ title: '', issuer: '', awarded_on: '' }); setQual(true); }}>Add</Button>}</div>
        {qualifications.length === 0 ? <Empty>None recorded.</Empty> : <ul className="list">{qualifications.map((q: any) => (
          <li key={q.id}><span><strong>{q.title}</strong><br /><span className="muted small">{q.issuer ?? 'Issuer not given'} · {fmtDate(q.awarded_on)}</span></span>
            {q.verified_at ? <Status s="verified" text={`Verified by ${q.verified_by_name}`} /> : can.verify ? <Button variant="secondary" busy={verify.busy} onClick={() => verify.run(q.id)}>Verify</Button> : <Status s="awaiting_verification" />}</li>
        ))}</ul>}
        <ErrorSummary error={verify.error ?? decide.error} />
      </section>
      <Dialog open={edit} onClose={() => setEdit(false)} title="Edit professional profile" footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        <ErrorSummary error={save.error} />
        <Field label="Preferred name" optional><input name="preferred_name" value={f.preferred_name ?? ''} onChange={(e) => setF({ ...f, preferred_name: e.target.value })} /></Field>
        <Field label="Professional summary" optional><textarea name="professional_summary" value={f.professional_summary ?? ''} onChange={(e) => setF({ ...f, professional_summary: e.target.value })} /></Field>
        <Field label="Work phone" optional><input name="work_phone" value={f.work_phone ?? ''} onChange={(e) => setF({ ...f, work_phone: e.target.value })} /></Field>
        <Field label="Skills" hint="Separate with commas" optional><input name="skills" value={f.skills ?? ''} onChange={(e) => setF({ ...f, skills: e.target.value })} /></Field>
        <Field label="Languages" hint="Separate with commas" optional><input name="languages" value={f.languages ?? ''} onChange={(e) => setF({ ...f, languages: e.target.value })} /></Field>
        <Field label="Development goals" optional><textarea name="development_goals" value={f.development_goals ?? ''} onChange={(e) => setF({ ...f, development_goals: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={propose} onClose={() => setPropose(false)} title="Propose a change" footer={<Button busy={sendProposal.busy} onClick={() => sendProposal.run()}>Send for verification</Button>}>
        <p className="small muted">An authorised person checks changes before they appear on your profile.</p>
        <ErrorSummary error={sendProposal.error} />
        <Field label="What do you want to change?"><select name="field" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}>{['preferred_name', 'professional_summary', 'work_phone', 'skills', 'languages', 'development_goals'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
        <Field label="New value" hint={f.field === 'skills' || f.field === 'languages' ? 'Separate with commas' : undefined} error={sendProposal.error?.fields.value}><textarea name="value" value={f.value ?? ''} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
      </Dialog>
      <Dialog open={qual} onClose={() => setQual(false)} title="Add a qualification" footer={<Button busy={addQual.busy} onClick={() => addQual.run()}>Add</Button>}>
        <ErrorSummary error={addQual.error} />
        <Field label="Title" error={addQual.error?.fields.title}><input name="title" value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Issuer" optional><input name="issuer" value={f.issuer ?? ''} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></Field>
        <Field label="Date awarded" optional><input name="awarded_on" type="date" value={f.awarded_on ?? ''} onChange={(e) => setF({ ...f, awarded_on: e.target.value })} /></Field>
      </Dialog>
      {photo && <PhotoDialog personId={p.id} onClose={() => setPhoto(false)} onSaved={() => { setPhoto(false); reload(); if (isMe) reloadMe(); }} />}
    </div>
  );
}

// Square crop with a zoom slider (keyboard-operable), previewed before upload.
function PhotoDialog({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const [progress, setProgress] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const toast = useToast();
  useEffect(() => {
    if (!img || !canvas.current) return;
    const c = canvas.current, ctx = c.getContext('2d')!;
    const side = Math.min(img.width, img.height) / zoom;
    const sx = (img.width - side) * (pos.x / 100), sy = (img.height - side) * (pos.y / 100);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, c.width, c.height);
  }, [img, zoom, pos]);
  const pick = (file?: File) => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = u;
  };
  const save = useSubmit(async () => {
    const blob: Blob = await new Promise((r, j) => canvas.current!.toBlob((b) => (b ? r(b) : j(new ApiError(0, 'error', 'Could not prepare the photo.'))), 'image/jpeg', 0.9));
    setProgress(0);
    try { await upload(`/people/${personId}/photo`, blob, 'photo.jpg', setProgress); } finally { setProgress(null); }
    toast('Photo saved.');
    onSaved();
  });
  return (
    <Dialog open onClose={onClose} title="Profile photo" footer={<Button busy={save.busy} disabled={!img} onClick={() => save.run()}>Save photo</Button>}>
      <ErrorSummary error={save.error} />
      <div className="field"><label htmlFor="photo-file">Choose a photo</label><span className="hint">A clear, recent photo of your face. JPEG, PNG or WebP.</span><input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pick(e.target.files?.[0])} /></div>
      {img && (
        <>
          <canvas ref={canvas} width={320} height={320} role="img" aria-label="Preview of the cropped photo" style={{ borderRadius: '50%', width: 200, height: 200, display: 'block', margin: '0 auto 16px', border: '1px solid var(--line)' }} />
          <Field label="Zoom"><input name="zoom" type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></Field>
          <Field label="Move left or right"><input name="posx" type="range" min={0} max={100} value={pos.x} onChange={(e) => setPos({ ...pos, x: Number(e.target.value) })} /></Field>
          <Field label="Move up or down"><input name="posy" type="range" min={0} max={100} value={pos.y} onChange={(e) => setPos({ ...pos, y: Number(e.target.value) })} /></Field>
          {progress !== null && <progress max={100} value={progress} aria-label="Upload progress" />}
        </>
      )}
    </Dialog>
  );
}

function AppointmentsTab({ d, isMe, reload }: { d: any; isMe: boolean; reload: () => void }) {
  const hub = useHub();
  const toast = useToast();
  const { person: p, appointments, can } = d;
  const [dlg, setDlg] = useState<null | { kind: 'new' | 'end' | 'rate' | 'property' | 'edit'; appt?: any }>(null);
  const [f, setF] = useState<any>({});
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const props = useApi<any[]>(dlg?.kind === 'property' ? `/properties?company=${dlg.appt.company_id}` : null);
  const colleagues = useApi<any[]>(dlg?.kind === 'end' ? `/people?company=${dlg.appt.company_id}` : null);
  const close = (msg: string) => { setDlg(null); toast(msg); reload(); };
  const create = useSubmit(async () => { await post('/appointments', { person_id: p.id, company_id: f.company_id, ...apptBody(f) }); close('Appointment added.'); });
  const edit = useSubmit(async () => { const b = apptBody(f); delete (b as any).start_date; await patch(`/appointments/${dlg!.appt.id}`, b); close('Appointment updated. The previous values are kept in the audit history.'); });
  const end = useSubmit(async () => {
    const r = await post(`/appointments/${dlg!.appt.id}/end`, { end_date: f.end_date, reason: f.reason, transfer_to: f.transfer_to || undefined });
    close(`Appointment ended.${r.keysStillHeld.length ? ` ${r.keysStillHeld.length} key(s) still need returning.` : ''}${r.leaver ? ' This was their last appointment, so their sign-in has ended.' : r.accessEndsOn ? ` This company’s roles end after ${fmtDate(r.accessEndsOn)}. Other appointments are unchanged.` : ' Their other appointments are unchanged.'}`);
  });
  const rate = useSubmit(async () => { await post(`/appointments/${dlg!.appt.id}/rates`, { rate_type: f.rate_type, amount: f.amount, effective_from: f.effective_from }); close('Rate added. Earlier rates are kept.'); });
  const alloc = useSubmit(async () => {
    const r = await post(`/appointments/${dlg!.appt.id}/properties`, { property_id: f.property_id, override_reason: f.override_reason || undefined });
    close(r.warnings.length ? `Allocated. Note: ${r.warnings.join(' ')}` : 'Property allocated.');
  });
  const endAlloc = useSubmit(async (aid: string) => { await post(`/appointment-properties/${aid}/end`); toast('Allocation ended.'); reload(); });
  const manageable = (cid: string) => can.manageAppointments.includes(cid);
  const addable = hub.me.companies.filter((c) => manageable(c.id));
  const clearanceErr = alloc.error?.code === 'clearance_required';

  return (
    <>
      {addable.length > 0 && <p><Button onClick={() => { setF(blankAppt(addable[0].id)); setDlg({ kind: 'new' }); }}>Add an appointment</Button></p>}
      {appointments.length === 0 ? <Empty>No appointments you can see.</Empty> : appointments.map((a: any) => (
        <section key={a.id} className="card" aria-labelledby={`ap-${a.id}`}>
          <div className="row between">
            <h3 id={`ap-${a.id}`} style={{ margin: 0 }}><CompanyBadge code={a.company_code} name={a.company_name} /> {a.job_title}</h3>
            <span className="row"><Status s={a.is_current ? 'active' : a.status} text={a.is_current ? 'Current' : undefined} />
              {manageable(a.company_id) && a.status !== 'ended' && <><Button variant="secondary" onClick={() => { setF({ ...a, legal_employer_company_id: a.legal_employer_company_id ?? '', legal_employer_name: a.legal_employer_name ?? '', manager_person_id: a.manager_person_id ?? '', responsibilities: a.responsibilities ?? '', contracted_hours_per_week: a.contracted_hours_per_week ?? '' }); setDlg({ kind: 'edit', appt: a }); }}>Edit</Button>
                <Button variant="secondary" onClick={() => { setF({ end_date: londonToday(), reason: '', transfer_to: '' }); setDlg({ kind: 'end', appt: a }); }}>End appointment</Button></>}</span>
          </div>
          <dl className="facts" style={{ marginTop: 12 }}>
            <dt>Company</dt><dd>{a.company_name}</dd>
            <dt>Relationship</dt><dd>{label(a.relationship)}</dd>
            <dt>Legal employer</dt><dd>{a.legal_employer_company_name ?? a.legal_employer_name}</dd>
            <dt>Manager</dt><dd>{a.manager_name ?? '—'}</dd>
            <dt>Dates</dt><dd>{fmtDate(a.start_date)} – {a.end_date ? fmtDate(a.end_date) : 'ongoing'}{a.ended_reason && <span className="muted"> ({a.ended_reason})</span>}</dd>
            <dt>Hours per week</dt><dd>{a.contracted_hours_per_week ?? 'Not set'}</dd>
            <dt>Responsibilities</dt><dd>{a.responsibilities ?? '—'}</dd>
          </dl>
          <h4 style={{ marginTop: 16 }}>Properties</h4>
          {a.properties.length === 0 ? <p className="muted">None allocated.</p> : <ul className="list">{a.properties.map((x: any) => <li key={x.id}><span><Link to={`/properties/${x.property_id}`}>{x.name}</Link> <span className="muted small">{x.ref} · {fmtDate(x.from_date)} – {x.to_date ? fmtDate(x.to_date) : 'now'}</span></span>{!x.to_date && manageable(a.company_id) && <Button variant="ghost" busy={endAlloc.busy} onClick={() => endAlloc.run(x.id)}>End allocation</Button>}</li>)}</ul>}
          {manageable(a.company_id) && a.status !== 'ended' && <Button variant="secondary" onClick={() => { setF({ property_id: '', override_reason: '' }); alloc.setError(null); setDlg({ kind: 'property', appt: a }); }}>Allocate a property</Button>}
          {a.rates && (
            <>
              <h4 style={{ marginTop: 16 }}>Rates <span className="muted small">(restricted)</span></h4>
              {a.rates.length === 0 ? <p className="muted">No rate recorded.</p> : <div className="table-wrap"><table><thead><tr><th>Type</th><th className="num">Amount</th><th>From</th><th>To</th></tr></thead><tbody>{a.rates.map((r: any) => <tr key={r.id}><td>{label(r.rate_type)}</td><td className="num">{money(r.amount)}</td><td>{fmtDate(r.effective_from)}</td><td>{r.effective_to ? fmtDate(r.effective_to) : 'current'}</td></tr>)}</tbody></table></div>}
              {can.manageRates.includes(a.company_id) && a.status !== 'ended' && !isMe && <p style={{ marginTop: 8 }}><Button variant="secondary" onClick={() => { setF({ rate_type: 'hourly', amount: '', effective_from: londonToday() }); setDlg({ kind: 'rate', appt: a }); }}>Add a new rate</Button></p>}
            </>
          )}
        </section>
      ))}

      <Dialog open={dlg?.kind === 'new'} onClose={() => setDlg(null)} title={`New appointment for ${p.full_name}`} footer={<Button busy={create.busy} onClick={() => create.run()}>Add appointment</Button>}>
        <ErrorSummary error={create.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={set('company_id')}>{addable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {dlg?.kind === 'new' && <AppointmentFields f={f} set={set} errors={create.error?.fields ?? {}} companyId={f.company_id} />}
      </Dialog>
      <Dialog open={dlg?.kind === 'edit'} onClose={() => setDlg(null)} title="Edit appointment" footer={<Button busy={edit.busy} onClick={() => edit.run()}>Save Changes</Button>}>
        <ErrorSummary error={edit.error} />
        {dlg?.kind === 'edit' && <AppointmentFields f={f} set={set} errors={edit.error?.fields ?? {}} companyId={dlg.appt.company_id} />}
      </Dialog>
      <Dialog open={dlg?.kind === 'end'} onClose={() => setDlg(null)} title={`End ${dlg?.appt?.job_title ?? ''} appointment`} footer={<Button variant="danger" busy={end.busy} onClick={() => end.run()}>End appointment</Button>}>
        <p>This ends only this appointment with {dlg?.appt?.company_name}. Other appointments stay as they are. Property allocations and this company’s access end on the date given.</p>
        <ErrorSummary error={end.error} />
        <Field label="Last day" error={end.error?.fields.end_date}><input name="end_date" type="date" value={f.end_date ?? ''} onChange={set('end_date')} /></Field>
        <Field label="Reason" error={end.error?.fields.reason}><textarea name="reason" value={f.reason ?? ''} onChange={set('reason')} /></Field>
        <Field label="Transfer their open tasks and reviews to" hint="Required if they own or review open tasks in this company." error={end.error?.fields.transfer_to}>
          <select name="transfer_to" value={f.transfer_to ?? ''} onChange={set('transfer_to')}><option value="">No transfer needed</option>{colleagues.data?.filter((c) => c.id !== p.id).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
        </Field>
      </Dialog>
      <Dialog open={dlg?.kind === 'rate'} onClose={() => setDlg(null)} title="Add a new rate" footer={<Button busy={rate.busy} onClick={() => rate.run()}>Save rate</Button>}>
        <p className="small muted">The current rate ends the day before the new one starts. Past timesheets keep the rates they were approved with.</p>
        <ErrorSummary error={rate.error} />
        <Field label="Rate type"><select name="rate_type" value={f.rate_type} onChange={set('rate_type')}>{['hourly', 'daily', 'annual_salary'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
        <Field label="Amount (£)" error={rate.error?.fields.amount}><input name="amount" inputMode="decimal" value={f.amount ?? ''} onChange={set('amount')} /></Field>
        <Field label="Effective from" error={rate.error?.fields.effective_from}><input name="effective_from" type="date" value={f.effective_from ?? ''} onChange={set('effective_from')} /></Field>
      </Dialog>
      <Dialog open={dlg?.kind === 'property'} onClose={() => setDlg(null)} title="Allocate a property" footer={<Button busy={alloc.busy} onClick={() => alloc.run()}>{clearanceErr && f.override_reason ? 'Authorise exception and allocate' : 'Allocate'}</Button>}>
        <ErrorSummary error={alloc.error} />
        <Field label="Property"><select name="property_id" value={f.property_id ?? ''} onChange={set('property_id')}><option value="">Choose…</option>{props.data?.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.ref})</option>)}</select></Field>
        {clearanceErr && alloc.error?.details?.canOverride && (
          <Field label="Reason for authorising an exception" hint="This is recorded with your name. Only use it where you have the authority to do so." error={alloc.error?.fields.override_reason}><textarea name="override_reason" value={f.override_reason ?? ''} onChange={set('override_reason')} /></Field>
        )}
      </Dialog>
    </>
  );
}

const CLEAR: [string, string][] = [['pending', 'Pending'], ['cleared', 'Cleared'], ['cleared_with_restrictions', 'Cleared with Restrictions'], ['not_authorised', 'Not Currently Authorised']];
const CHECK_STATUS: [string, string][] = [['evidence_missing', 'Evidence missing'], ['requested', 'Requested'], ['awaiting_verification', 'Awaiting verification'], ['verified', 'Verified'], ['adverse_finding', 'Adverse finding (details held outside the Hub)'], ['not_required', 'Not required']];

function ClearanceTab({ d, reload }: { d: any; reload: () => void }) {
  const { person: p, clearance, checks, can, appointments } = d;
  const toast = useToast();
  const [dlg, setDlg] = useState<null | 'decide' | 'check'>(null);
  const [f, setF] = useState<any>({});
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const decide = useSubmit(async () => { await post('/clearance', { person_id: p.id, company_id: f.company_id, status: f.status, restrictions: f.restrictions || undefined, evidence_summary: f.evidence_summary, review_date: f.review_date || null }); setDlg(null); toast('Clearance decision recorded.'); reload(); });
  const saveCheck = useSubmit(async () => {
    const body = { check_type: f.check_type, label: f.label, status: f.status, requested_on: f.requested_on || null, issued_on: f.issued_on || null, verified_on: f.verified_on || null, reference_number: f.reference_number || null, follow_up_on: f.follow_up_on || null, next_review_on: f.next_review_on || null, actions: f.actions || null };
    if (f.id) await patch(`/checks/${f.id}`, body); else await post('/checks', { ...body, person_id: p.id, company_id: f.company_id });
    setDlg(null); toast('Check saved.'); reload();
  });
  const companies = [...new Map(appointments.map((a: any) => [a.company_id, a])).values()] as any[];
  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="cl-h">
        <div className="row between"><h2 id="cl-h">Deployment clearance</h2>{can.decideClearance.length > 0 && <Button variant="secondary" onClick={() => { setF({ company_id: can.decideClearance[0], status: 'cleared', restrictions: '', evidence_summary: '', review_date: '' }); setDlg('decide'); }}>Record a decision</Button>}</div>
        <p className="small muted">Clearance is decided separately for each company.</p>
        {companies.map((a: any) => {
          const c = clearance.find((x: any) => x.company_id === a.company_id);
          return (
            <div key={a.company_id} className="card" style={{ marginTop: 12 }}>
              <div className="row between"><strong><CompanyBadge code={a.company_code} name={a.company_name} /> {a.company_name}</strong><Status s={c?.status ?? 'none'} /></div>
              {c ? <dl className="facts" style={{ marginTop: 8 }}>
                {c.restrictions && <><dt>Restrictions</dt><dd>{c.restrictions}</dd></>}
                <dt>Evidence</dt><dd>{c.evidence_summary ?? '—'}</dd>
                <dt>Decided by</dt><dd>{c.decided_by_name ?? '—'}, {fmtDate(c.decided_at)}</dd>
                <dt>Review date</dt><dd>{fmtDate(c.review_date)}</dd>
              </dl> : <p className="muted">No decision recorded. Deployment may be blocked.</p>}
            </div>
          );
        })}
      </section>
      {checks && (
        <section className="card" aria-labelledby="ch-h">
          <div className="row between"><h2 id="ch-h">Employment checks <span className="muted small">(restricted)</span></h2>{can.manageChecks.length > 0 && <Button variant="secondary" onClick={() => { setF({ company_id: can.manageChecks[0], check_type: 'dbs', label: 'Enhanced DBS', status: 'requested', requested_on: londonToday() }); setDlg('check'); }}>Add a check</Button>}</div>
          <p className="small muted">The Hub records dates and status only. It does not hold criminal-record details or certificate images. There is no automatic DBS expiry — set an organisational review date where your policy requires one.</p>
          {checks.length === 0 ? <Empty>No checks recorded.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Check</th><th>Status</th><th>Dates</th><th>Next step</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{checks.map((c: any) => (
              <tr key={c.id}><td>{c.label}<div><CompanyBadge code={c.company_code} name={c.company_name} /></div></td><td><Status s={c.status} /></td>
                <td className="small">{c.requested_on && <>Requested {fmtDate(c.requested_on)}<br /></>}{c.issued_on && <>Issued {fmtDate(c.issued_on)}<br /></>}{c.verified_on && <>Verified {fmtDate(c.verified_on)} by {c.reviewer_name}<br /></>}{c.next_review_on && <>Review {fmtDate(c.next_review_on)}</>}</td>
                <td className="small">{c.follow_up_on && <>Follow up {fmtDate(c.follow_up_on)}<br /></>}{c.actions}</td>
                <td>{can.manageChecks.includes(c.company_id) && <Button variant="ghost" onClick={() => { setF({ ...c }); setDlg('check'); }}>Update</Button>}</td></tr>
            ))}</tbody>
          </table></div>}
        </section>
      )}
      <Dialog open={dlg === 'decide'} onClose={() => setDlg(null)} title="Record a clearance decision" footer={<Button busy={decide.busy} onClick={() => decide.run()}>Save decision</Button>}>
        <ErrorSummary error={decide.error} />
        <Field label="Company"><select name="company_id" value={f.company_id} onChange={set('company_id')}>{can.decideClearance.map((cid: string) => <option key={cid} value={cid}>{companies.find((a) => a.company_id === cid)?.company_name}</option>)}</select></Field>
        <Field label="Decision"><select name="status" value={f.status} onChange={set('status')}>{CLEAR.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        {f.status === 'cleared_with_restrictions' && <Field label="Restrictions" error={decide.error?.fields.restrictions}><textarea name="restrictions" value={f.restrictions} onChange={set('restrictions')} /></Field>}
        <Field label="Evidence considered" hint="Summarise what was checked. Do not record criminal-record details." error={decide.error?.fields.evidence_summary}><textarea name="evidence_summary" value={f.evidence_summary} onChange={set('evidence_summary')} /></Field>
        <Field label="Review date" optional><input name="review_date" type="date" value={f.review_date} onChange={set('review_date')} /></Field>
      </Dialog>
      <Dialog open={dlg === 'check'} onClose={() => setDlg(null)} title={f.id ? 'Update check' : 'Add a check'} footer={<Button busy={saveCheck.busy} onClick={() => saveCheck.run()}>Save</Button>}>
        <ErrorSummary error={saveCheck.error} />
        {!f.id && <Field label="Company"><select name="company_id" value={f.company_id} onChange={set('company_id')}>{can.manageChecks.map((cid: string) => <option key={cid} value={cid}>{companies.find((a) => a.company_id === cid)?.company_name}</option>)}</select></Field>}
        <div className="form-grid">
          <Field label="Type"><select name="check_type" value={f.check_type} onChange={set('check_type')}>{['dbs', 'right_to_work', 'reference', 'qualification', 'other'].map((k) => <option key={k} value={k}>{k === 'dbs' ? 'DBS' : label(k)}</option>)}</select></Field>
          <Field label="Label" error={saveCheck.error?.fields.label}><input name="label" value={f.label ?? ''} onChange={set('label')} /></Field>
        </div>
        <Field label="Status"><select name="status" value={f.status} onChange={set('status')}>{CHECK_STATUS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <div className="form-grid">
          {['requested_on', 'issued_on', 'verified_on', 'follow_up_on', 'next_review_on'].map((k) => <Field key={k} label={label(k.replace('_on', ''))} optional><input name={k} type="date" value={f[k] ?? ''} onChange={set(k)} /></Field>)}
        </div>
        <Field label="Reference number" optional><input name="reference_number" value={f.reference_number ?? ''} onChange={set('reference_number')} /></Field>
        <Field label="Actions" optional><textarea name="actions" value={f.actions ?? ''} onChange={set('actions')} /></Field>
      </Dialog>
    </div>
  );
}

function PersonalTab({ d, reload, editable }: { d: any; reload: () => void; editable: boolean }) {
  const r = d.restricted ?? {};
  const toast = useToast();
  const [f, setF] = useState<any>({ personal_phone: r.personal_phone ?? '', personal_email: r.personal_email ?? '', home_address: r.home_address ?? '', emergency_contact_name: r.emergency_contact_name ?? '', emergency_contact_phone: r.emergency_contact_phone ?? '' });
  const save = useSubmit(async () => { await api('PUT', `/people/${d.person.id}/restricted`, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || null]))); toast('Personal details saved.'); reload(); });
  const fields: [string, string][] = [['personal_phone', 'Personal phone'], ['personal_email', 'Personal email'], ['home_address', 'Home address'], ['emergency_contact_name', 'Emergency contact name'], ['emergency_contact_phone', 'Emergency contact phone']];
  return (
    <section className="card" aria-labelledby="pd-h" style={{ maxWidth: 720 }}>
      <h2 id="pd-h">Personal details <span className="muted small">(restricted)</span></h2>
      <p className="small muted">Only authorised HR staff and the person themself can see this. It never appears on the resume.</p>
      {editable ? (
        <form noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }}>
          <ErrorSummary error={save.error} />
          {fields.map(([k, t]) => <Field key={k} label={t} optional error={save.error?.fields[k]}>{k === 'home_address' ? <textarea name={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /> : <input name={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>)}
          <Button type="submit" busy={save.busy}>Save Changes</Button>
        </form>
      ) : <dl className="facts">{fields.flatMap(([k, t]) => [<dt key={`${k}t`}>{t}</dt>, <dd key={k}>{r[k] ?? '—'}</dd>])}</dl>}
      {!editable && <p className="small muted" style={{ marginTop: 16 }}>To change these, contact HR.</p>}
    </section>
  );
}

// Professional profile for printing or saving as PDF: no salary, DBS, address, grievances or private feedback.
export function Resume() {
  const { id } = useParams();
  const d = useApi<any>(`/people/${id}/resume`);
  if (d.error) return <LoadError error={d.error} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { person: p, appointments, qualifications } = d.data;
  return (
    <>
      <div className="no-print"><PageHead title="Professional profile" crumbs={[['People', '/people'], [p.full_name, `/people/${p.id}`], ['Professional profile']]} intro="Contains professional information only. Use your browser’s Print option and choose “Save as PDF” to export it." actions={<Button onClick={() => print()}>Print or save as PDF</Button>} /></div>
      <article className="card" style={{ maxWidth: 820 }}>
        <div className="row"><Avatar personId={p.id} name={p.full_name} hasPhoto={p.has_photo} size="lg" /><div><h2 style={{ margin: 0 }}>{p.full_name}</h2><p className="muted" style={{ margin: 0 }}>{p.staff_ref} · {p.email}{p.work_phone && ` · ${p.work_phone}`}</p></div></div>
        {p.professional_summary && <><h3 style={{ marginTop: 24 }}>Summary</h3><p>{p.professional_summary}</p></>}
        <h3 style={{ marginTop: 24 }}>Roles</h3>
        <ul className="list">{appointments.map((a: any, i: number) => <li key={i}><span><CompanyBadge code={a.company_code} name={a.company_name} /> <strong>{a.job_title}</strong>, {a.company_name}<br /><span className="muted small">{label(a.relationship)} · {fmtDate(a.start_date)} – {a.end_date ? fmtDate(a.end_date) : 'present'}</span></span></li>)}</ul>
        {qualifications.length > 0 && <><h3 style={{ marginTop: 24 }}>Qualifications</h3><ul className="list">{qualifications.map((q: any, i: number) => <li key={i}><span>{q.title}{q.issuer && `, ${q.issuer}`} ({fmtDate(q.awarded_on)})</span>{q.verified ? <Status s="verified" /> : <Status s="awaiting_verification" text="Not yet verified" />}</li>)}</ul></>}
        {(p.skills.length > 0 || p.languages.length > 0) && <><h3 style={{ marginTop: 24 }}>Skills and languages</h3><p>{[...p.skills, ...p.languages.map((l: string) => `${l} (language)`)].join(' · ')}</p></>}
        {p.development_goals && <><h3 style={{ marginTop: 24 }}>Development goals</h3><p>{p.development_goals}</p></>}
        <p className="small muted" style={{ marginTop: 24 }}>Generated from the Valor &amp; Wellbeing Hub on {fmtDate(londonToday())}.</p>
      </article>
    </>
  );
}
