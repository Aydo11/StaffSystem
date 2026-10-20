import { useState } from 'react';
import { download, post, put, upload, useApi, useSubmit } from '../api.ts';
import { fmtDate, londonToday } from '../format.ts';
import { Button, Dialog, ErrorSummary, Field, FilePicker, Icon, Skeleton, Status, useToast } from '../ui.tsx';

const DAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const NOW: Record<string, [string, string]> = { available: ['approved', 'Available now'], on_visit: ['in_progress', 'On a visit'], away: ['suspended', 'Away'], off: ['ended', 'Not working now'] };

// Shown above the profile tabs: when the person works and is available, and their CPD roadmap with evidence.
export function ProfileOverview({ personId, isMe }: { personId: string; isMe: boolean }) {
  const d = useApi<any>(`/people/${personId}/overview`);
  const [hours, setHours] = useState<Record<string, string[]> | null>(null);
  const [evidence, setEvidence] = useState<any>(null);
  const toast = useToast();
  const verify = useSubmit(async (rid: string) => { await post(`/training/records/${rid}/verify`, { approve: true }); toast('Evidence verified.'); d.reload(); });
  const openFile = useSubmit(async (r: any) => { await download(`/files/${r.certificate_file_id}`, `${r.title}`); });
  if (d.loading && !d.data) return <Skeleton lines={3} />;
  if (!d.data) return null;
  const { availability: av, working_hours: wh, upcoming_leave, cpd, can } = d.data;
  const [st, stText] = NOW[av.status];
  const done = cpd?.steps.filter((s: any) => s.status === 'done').length ?? 0;

  return (
    <div className="grid-2 overview" style={{ marginBottom: 16 }}>
      <section className="card" aria-labelledby="av-h">
        <div className="row between">
          <h2 id="av-h" style={{ margin: 0 }}>Availability</h2>
          {can.editHours && <Button variant="secondary" onClick={() => setHours({ ...wh })}>{isMe ? 'Set my hours' : 'Edit hours'}</Button>}
        </div>
        <p className="avail-now"><Status s={st} text={av.status === 'away' ? `Away until ${fmtDate(av.away_until)}` : stText} />
          <span className="muted">{av.today ? `Today ${av.today[0]}–${av.today[1]}` : Object.keys(wh).length ? 'Not working today' : 'Usual hours not set yet'}</span></p>
        <ul className="week" aria-label="Usual working hours">
          {DAYS.map(([k, t]) => (
            <li key={k} className={`${wh[k] ? 'on' : ''} ${k === av.day ? 'today' : ''}`}>
              <strong>{t}</strong><span>{wh[k] ? `${wh[k][0]}–${wh[k][1]}` : 'Off'}</span>
            </li>
          ))}
        </ul>
        {upcoming_leave.length > 0 && <p className="small" style={{ marginTop: 12 }}><strong>Away:</strong> {upcoming_leave.map((l: any) => l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`).join(' · ')}</p>}
      </section>

      {cpd && (
        <section className="card" aria-labelledby="cpd-h">
          <div className="row between"><h2 id="cpd-h" style={{ margin: 0 }}>CPD roadmap</h2><span className="small"><strong>{done}</strong> of {cpd.steps.length} complete</span></div>
          <div className="bar" style={{ margin: '12px 0 16px' }} role="progressbar" aria-label="CPD roadmap progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={cpd.steps.length}><span style={{ width: `${(done / cpd.steps.length) * 100}%` }} /></div>
          <ol className="roadmap">
            {cpd.steps.map((s: any) => (
              <li key={s.key} className={s.status}>
                <span className="dot" aria-hidden="true">{s.status === 'done' ? <Icon name="check" size={16} /> : s.status === 'awaiting' ? <Icon name="clock" size={16} /> : null}</span>
                <div className="grow">
                  <strong>{s.title}</strong><span className="sr-only"> — {s.status === 'done' ? 'complete' : s.status === 'awaiting' ? 'awaiting verification' : 'not started'}</span>
                  {s.record && <div className="small muted">
                    {s.record.title} · {fmtDate(s.record.completed_on)}
                    {s.status === 'done' && (s.record.source === 'course' ? ' · Hub course passed' : ' · Verified')}
                    {s.status === 'awaiting' && ' · Awaiting verification'}
                  </div>}
                </div>
                <span className="row">
                  {s.record?.certificate_file_id && <Button variant="ghost" onClick={() => openFile.run(s.record)} aria-label={`Open evidence for ${s.title}`}><Icon name="file" size={18} />Evidence</Button>}
                  {s.status === 'awaiting' && can.verify && <Button variant="secondary" busy={verify.busy} onClick={() => verify.run(s.record.id)}>Verify</Button>}
                  {s.status === 'todo' && can.addEvidence && <Button variant="secondary" onClick={() => setEvidence(s)}>Add evidence</Button>}
                </span>
              </li>
            ))}
          </ol>
          <ErrorSummary error={verify.error ?? openFile.error} />
          {cpd.other.length > 0 && (
            <details style={{ marginTop: 12 }}><summary>Other training completed ({cpd.other.length})</summary>
              <ul className="list">{cpd.other.map((r: any) => <li key={r.id}><span>{r.title}</span><span className="small muted">{fmtDate(r.completed_on)}</span></li>)}</ul>
            </details>
          )}
        </section>
      )}
      {hours && <HoursDialog personId={personId} initial={hours} onClose={() => setHours(null)} onSaved={() => { setHours(null); toast('Working hours saved.'); d.reload(); }} />}
      {evidence && <EvidenceDialog step={evidence} onClose={() => setEvidence(null)} onSaved={() => { setEvidence(null); toast('Evidence added. It is ticked once a manager verifies it.'); d.reload(); }} />}
    </div>
  );
}

function HoursDialog({ personId, initial, onClose, onSaved }: { personId: string; initial: Record<string, string[]>; onClose: () => void; onSaved: () => void }) {
  const [h, setH] = useState(initial);
  const save = useSubmit(async () => { await put(`/people/${personId}/working-hours`, h); onSaved(); });
  return (
    <Dialog open onClose={onClose} title="Usual working hours" footer={<Button busy={save.busy} onClick={() => save.run()}>Save hours</Button>}>
      <p className="small muted">Colleagues see these so they know when you are available. Leave is shown as “Away” without saying why.</p>
      <ErrorSummary error={save.error} />
      {DAYS.map(([k, t]) => (
        <div key={k} className="row hours-row">
          <label className="check" style={{ minWidth: 96 }}><input type="checkbox" checked={!!h[k]} onChange={(e) => setH(e.target.checked ? { ...h, [k]: ['09:00', '17:00'] } : Object.fromEntries(Object.entries(h).filter(([d]) => d !== k)))} /> {t}</label>
          {h[k] && <>
            <input type="time" aria-label={`${t} start`} value={h[k][0]} onChange={(e) => setH({ ...h, [k]: [e.target.value, h[k][1]] })} style={{ width: 'auto' }} />
            <span aria-hidden="true">–</span>
            <input type="time" aria-label={`${t} finish`} value={h[k][1]} onChange={(e) => setH({ ...h, [k]: [h[k][0], e.target.value] })} style={{ width: 'auto' }} />
          </>}
        </div>
      ))}
    </Dialog>
  );
}

function EvidenceDialog({ step, onClose, onSaved }: { step: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ completed_on: londonToday(), provider: '', file: null as File | null });
  const [progress, setProgress] = useState<number | null>(null);
  const save = useSubmit(async () => {
    const r = await post('/training/records', { title: step.title, provider: f.provider || null, completed_on: f.completed_on });
    if (f.file) { setProgress(0); try { await upload(`/training/records/${r.id}/certificate`, f.file, f.file.name, setProgress); } finally { setProgress(null); } }
    onSaved();
  });
  return (
    <Dialog open onClose={onClose} title={`Evidence: ${step.title}`} footer={<Button busy={save.busy} onClick={() => save.run()}>Send for verification</Button>}>
      <ErrorSummary error={save.error} />
      <Field label="Completed on" error={save.error?.fields.completed_on}><input name="completed_on" type="date" max={londonToday()} value={f.completed_on} onChange={(e) => setF({ ...f, completed_on: e.target.value })} /></Field>
      <Field label="Provider" optional><input name="provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} /></Field>
      <FilePicker label="Certificate" hint="PDF or a photo of the certificate. A manager checks it before the step is ticked." accept="application/pdf,image/jpeg,image/png,image/webp" busy={progress !== null} progress={progress} onChange={(fs) => setF({ ...f, file: fs[0] ?? null })} />
    </Dialog>
  );
}
