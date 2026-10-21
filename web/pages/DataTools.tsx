import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, download, post, useApi, useSubmit } from '../api.ts';
import { fmtDate, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, Chips, Dialog, Empty, ErrorSummary, Field, FilePicker, LoadError, PageHead, Skeleton, useToast } from '../ui.tsx';

const FIELDS: Record<string, [string, boolean][]> = {
  people: [['email', true], ['full_name', true], ['preferred_name', false], ['job_title', true], ['relationship', true], ['start_date', true], ['legal_employer_name', false], ['contracted_hours_per_week', false]],
  properties: [['ref', true], ['name', true], ['address_line1', true], ['address_line2', false], ['city', true], ['postcode', true], ['managing_agent', false]],
};

export function ImportPage() {
  const hub = useHub();
  const toast = useToast();
  const [entity, setEntity] = useState<'people' | 'properties'>('people');
  const perm = entity === 'people' ? 'staff.create' : 'properties.manage';
  const cos = hub.me.companies.filter((c) => c.perms.includes(perm));
  const [company, setCompany] = useState(cos[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => { setPreview(null); setMapping({}); }, [entity]);
  const pick = async (f?: File) => {
    if (!f) return;
    const text = await f.text();
    setCsv(text); setPreview(null);
    const first = text.replace(/^﻿/, '').split(/\r?\n/)[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
    setHeader(first);
    // Suggest a mapping where a column name matches a field name.
    setMapping(Object.fromEntries(FIELDS[entity].map(([k]) => [k, first.find((h) => h.toLowerCase().replace(/[^a-z]/g, '') === k.replace(/_/g, '')) ?? ''])));
  };
  const check = useSubmit(async () => { if (!csv) throw new ApiError(400, 'invalid', 'Choose a CSV file first.'); setPreview(await post('/admin/import/preview', { entity, company_id: company, csv, mapping: clean(mapping) })); });
  const commit = useSubmit(async () => { const r = await post('/admin/import/commit', { entity, company_id: company, csv, mapping: clean(mapping) }); toast(`Created ${r.created}. Skipped ${r.skipped_duplicates} duplicates and ${r.invalid} rows with errors.`); setPreview(null); setCsv(''); setHeader([]); });
  return (
    <>
      <PageHead title="Import from a spreadsheet" crumbs={[['Admin Centre', '/admin'], ['Import']]} intro="Upload a CSV, match its columns, check the preview, then import. Existing records are never changed: duplicates are skipped and listed." />
      <section className="card">
        <Chips label="What to import" value={entity} onChange={setEntity} options={[['people', 'People with a role'], ['properties', 'Properties']]} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="Company"><select name="company" value={company} onChange={(e) => setCompany(e.target.value)}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <FilePicker label="CSV file" accept=".csv,text/csv" onChange={(fs) => pick(fs[0])} />
        </div>
        {header.length > 0 && (
          <fieldset style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600 }}>Match columns</legend>
            <div className="form-grid">{FIELDS[entity].map(([k, req]) => <Field key={k} label={label(k)} optional={!req}><select name={k} value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}><option value="">— not in file —</option>{header.map((h) => <option key={h} value={h}>{h}</option>)}</select></Field>)}</div>
            {entity === 'people' && <p className="small muted">Relationship must be employee, contractor, agency, secondment, volunteer or other. Dates as 2026-10-20. Leave the legal employer blank when the company itself employs them.</p>}
          </fieldset>
        )}
        <ErrorSummary error={check.error ?? commit.error} />
        <Button busy={check.busy} onClick={() => check.run()} disabled={!csv}>Check the file</Button>
      </section>
      {preview && (
        <section className="card" aria-labelledby="pv-h">
          <h2 id="pv-h">Preview</h2>
          <p><strong>{preview.summary.valid}</strong> will be created · {preview.summary.duplicates} duplicates skipped · {preview.summary.invalid} rows have errors</p>
          <div className="table-wrap"><table><thead><tr><th>Line</th><th>Data</th><th>Result</th></tr></thead>
            <tbody>{preview.rows.slice(0, 200).map((r: any) => <tr key={r.line}><td>{r.line}</td><td className="small">{Object.values(r.data).filter(Boolean).join(' · ')}</td><td>{r.errors.length ? <span style={{ color: 'var(--danger)' }}>Error: {r.errors.join('; ')}</span> : r.duplicate ? <span>Skipped: {r.duplicate}</span> : 'Will be created'}</td></tr>)}</tbody></table></div>
          <Button variant="go" busy={commit.busy} disabled={!preview.summary.valid} onClick={() => commit.run()}>Import {preview.summary.valid} {entity}</Button>
        </section>
      )}
    </>
  );
}
const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v));

export function RetentionPage() {
  const [years, setYears] = useState(6);
  const d = useApi<any>(`/admin/retention?years=${years}`);
  return (
    <>
      <PageHead title="Retention review" crumbs={[['Admin Centre', '/admin'], ['Retention']]} intro="Records past your retention period. Nothing is deleted automatically: check your retention schedule, then anonymise leavers from their profile. Business records such as visits and finance stay, without the person's details." />
      <Field label="Retention period for leavers (years)"><input name="years" type="number" min={1} max={20} value={years} onChange={(e) => setYears(Number(e.target.value) || 6)} style={{ maxWidth: 120 }} /></Field>
      {d.error ? <LoadError error={d.error} /> : !d.data ? <Skeleton /> : <>
        <section className="card"><h2 style={{ fontSize: '1.125rem' }}>Leavers past {d.data.years} years</h2>{d.data.leavers.length === 0 ? <Empty>None.</Empty> : <ul className="list">{d.data.leavers.map((p: any) => <li key={p.id}><Link to={`/people/${p.id}`}>{p.full_name} ({p.staff_ref})</Link><span className="small">left {fmtDate(p.left_on)}</span></li>)}</ul>}</section>
        <section className="card"><h2 style={{ fontSize: '1.125rem' }}>Other records</h2><ul><li>Notifications over a year old: {d.data.counts.old_notifications}</li><li>Email delivery records over a year old: {d.data.counts.old_outbound}</li><li>Audit entries over {d.data.years} years old: {d.data.counts.old_audit}</li></ul>
          <p className="small muted">AI drafts are deleted automatically after each company's AI retention setting.</p></section>
      </>}
    </>
  );
}

// Shown on a person's profile: download their data; super admins can anonymise a leaver.
export function PersonDataActions({ person }: { person: any }) {
  const hub = useHub();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const exp = useSubmit(async () => { await download(`/people/${person.id}/export`, `hub-personal-data-${person.staff_ref}.json`); });
  const anon = useSubmit(async () => { await post(`/people/${person.id}/anonymise`, { confirm_name: name }); setOpen(false); toast('Anonymised.'); location.reload(); });
  return (
    <>
      <Button variant="secondary" busy={exp.busy} onClick={() => exp.run()}>{person.id === hub.me.person.id ? 'Download my data' : 'Download their data'}</Button>
      {hub.me.superAdmin && person.status === 'left' && !person.email.startsWith('removed+') && <Button variant="danger" onClick={() => setOpen(true)}>Anonymise</Button>}
      <ErrorSummary error={exp.error} />
      <Dialog open={open} onClose={() => setOpen(false)} title="Anonymise this leaver" variant="modal" footer={<Button variant="danger" busy={anon.busy} onClick={() => anon.run()}>Anonymise permanently</Button>}>
        <p>This removes their name, email, contact and personal details, photo and qualifications. It cannot be undone. Visits, timesheets, finance and audit records are kept under "Former staff member".</p>
        <ErrorSummary error={anon.error} />
        <Field label={`Type “${person.full_name}” to confirm`} error={anon.error?.fields.confirm_name}><input name="confirm_name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

// Optional installation as an app. Never required; not an app-store app.
export function InstallPage() {
  const [prompt, setPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(matchMedia('(display-mode: standalone)').matches);
  useEffect(() => {
    const onPrompt = (e: any) => { e.preventDefault(); setPrompt(e); };
    addEventListener('beforeinstallprompt', onPrompt);
    addEventListener('appinstalled', () => setInstalled(true));
    return () => removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return (
    <>
      <PageHead title="Install the Hub on your phone" intro="Optional. Installing adds an icon to your home screen and opens the Hub full screen. It is the same website — there is no app-store app, and nothing personal is stored on the phone." />
      {installed ? <div className="notice ok">The Hub is installed on this device.</div> : prompt ? <Button big onClick={async () => { prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>Install the Hub</Button> : null}
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="card" aria-labelledby="and-h"><h2 id="and-h" style={{ fontSize: '1.25rem' }}>Android (Chrome)</h2><ol><li>Open the Hub in Chrome.</li><li>Tap the menu (three dots) at the top right.</li><li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>Confirm. The Hub icon appears on your home screen.</li></ol></section>
        <section className="card" aria-labelledby="ios-h"><h2 id="ios-h" style={{ fontSize: '1.25rem' }}>iPhone or iPad (Safari){ios && ' — this device'}</h2><ol><li>Open the Hub in Safari.</li><li>Tap the <strong>Share</strong> button (square with an arrow).</li><li>Scroll and tap <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong>.</li></ol></section>
        <section className="card" aria-labelledby="pc-h"><h2 id="pc-h" style={{ fontSize: '1.25rem' }}>Computer (Chrome or Edge)</h2><p>Look for the install icon at the right of the address bar, or use the browser menu and choose <strong>Install Valor &amp; Wellbeing Hub</strong>.</p></section>
        <section className="card" aria-labelledby="up-h"><h2 id="up-h" style={{ fontSize: '1.25rem' }}>Updates and offline use</h2><p>The installed Hub updates itself. You need a connection to save anything; if you go offline, the Hub tells you and saves nothing until you are back online.</p></section>
      </div>
    </>
  );
}

// A one-time sign-in link, shown when it could not be emailed so the admin can pass it on privately.
export function AccessLinkNotice({ link, email, purpose }: { link: string; email: string; purpose: string }) {
  const [copied, setCopied] = useState(false);
  if (email === 'sent') return <div className="notice ok" role="status">The {purpose === 'invite' ? 'invitation' : 'reset link'} has been emailed.</div>;
  return (
    <div className="notice" role="status">
      <p>{email === 'failed' ? 'The email could not be sent.' : 'Email is not set up yet, so nothing was sent.'} Give this one-time link to the person privately (for example in person or by text). It works once and expires in {purpose === 'invite' ? '7 days' : '1 hour'}.</p>
      <p><code style={{ wordBreak: 'break-all' }}>{link}</code></p>
      <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* select and copy by hand */ } }}>{copied ? 'Copied' : 'Copy link'}</Button>
    </div>
  );
}

// On a profile: change your own password, or (admins) send someone a new sign-in link.
export function SignInAccess({ person, isMe }: { person: any; isMe: boolean }) {
  const hub = useHub();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ current: '', password: '', reset_mfa: false, reason: '' });
  const [result, setResult] = useState<any>(null);
  const change = useSubmit(async () => {
    if (f.password.length < 12) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { password: 'Use at least 12 characters' } });
    await post('/auth/password', { current: f.current, password: f.password }); setOpen(false); toast('Password changed. Other devices have been signed out.');
  });
  const issue = useSubmit(async () => setResult(await post(`/people/${person.id}/access-link`, { reset_mfa: f.reset_mfa, reason: f.reason || undefined })));
  const admin = !isMe && person.status !== 'left' && (hub.me.superAdmin || hub.me.companies.some((c) => c.perms.includes('staff.create')));
  if (!isMe && !admin) return null;
  const close = () => { setOpen(false); setResult(null); setF({ current: '', password: '', reset_mfa: false, reason: '' }); };
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>{isMe ? 'Change password' : person.has_password ? 'Send new sign-in link' : 'Resend invitation'}</Button>
      {isMe ? (
        <Dialog open={open} onClose={close} title="Change password" footer={<Button busy={change.busy} onClick={() => change.run()}>Change password</Button>}>
          <ErrorSummary error={change.error} />
          <Field label="Current password" error={change.error?.fields.current}><input name="current" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 12 characters" error={change.error?.fields.password}><input name="password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        </Dialog>
      ) : (
        <Dialog open={open} onClose={close} title={person.has_password ? 'Send a new sign-in link' : 'Resend invitation'} footer={!result && <Button busy={issue.busy} onClick={() => issue.run()}>Create link</Button>}>
          {result ? <AccessLinkNotice link={result.link} email={result.email} purpose={result.purpose} /> : <>
            <p>{person.has_password ? 'They choose a new password with the link. Their two-step verification stays as it is unless you reset it below.' : 'They have not chosen a password yet. Any earlier invitation link stops working.'}</p>
            <p className="small muted">Two-step verification: {person.mfa_enabled ? 'set up' : 'not set up'}.</p>
            <ErrorSummary error={issue.error} />
            {hub.me.superAdmin && person.mfa_enabled && <>
              <label className="check"><input type="checkbox" checked={f.reset_mfa} onChange={(e) => setF({ ...f, reset_mfa: e.target.checked })} /> Also reset two-step verification (lost or new phone)</label>
              {f.reset_mfa && <Field label="Reason" error={issue.error?.fields.reason}><input name="reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>}
            </>}
          </>}
        </Dialog>
      )}
    </>
  );
}
