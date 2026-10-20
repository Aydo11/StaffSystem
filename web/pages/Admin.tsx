import { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { ApiError, get, patch, post, useApi, useSubmit } from '../api.ts';
import { fmtDateTime, label } from '../format.ts';
import { useHub } from '../hub.tsx';
import { AiSettings } from './Assistant.tsx';
import { ImportPage, RetentionPage } from './DataTools.tsx';
import { TemplatesAdmin } from './Development.tsx';
import { Button, CompanyBadge, Dialog, Empty, ErrorSummary, Field, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

// Cards are honest about scope: built modules link through; later stages say so plainly.
const CARDS: { title: string; help: string; to?: string; perm?: string; stage?: number; note?: string }[] = [
  { title: 'Companies', help: 'Legal details, verification, support-system link, clearance rule.', to: 'companies', perm: 'company.manage' },
  { title: 'Users', help: 'Invite people and manage profiles.', to: '/people', perm: 'staff.create' },
  { title: 'Permissions', help: 'Grant, delegate (with expiry) and revoke roles. Access review.', to: 'access', perm: 'access.manage' },
  { title: 'Appointments', help: 'Add, change and end appointments from a person’s profile.', to: '/people', perm: 'appointments.manage' },
  { title: 'Properties', help: 'Add and edit properties, keys and visit plans.', to: '/properties', perm: 'properties.manage' },
  { title: 'Audit', help: 'Who changed what, and when.', to: 'audit', perm: 'audit.view' },
  { title: 'KPI definitions', help: 'Targets, minimum data and wording, kept as dated versions.', to: '/performance?tab=definitions', perm: 'performance.manage' },
  { title: 'Templates', help: 'Versioned job descriptions, competencies with rubrics, and onboarding checklists.', to: 'templates', perm: 'jobs.manage' },
  { title: 'Training', help: 'Training matrix, requirements, courses and quizzes.', to: '/training?tab=manage', perm: 'training.manage' },
  { title: 'Policies', help: 'Policies and staff handbooks: drafting, approval, adoption and who has read them.', to: '/policies', perm: 'policies.manage' },
  { title: 'Governance', help: 'Leads, meetings, decisions, risks, audits, actions, quality summaries and framework mapping.', to: '/governance', perm: 'governance.manage' },
  { title: 'Finance', help: 'Numbering, payment details, VAT and self-billing settings; budgets and cash flow.', to: '/finance?tab=settings', perm: 'finance.manage' },
  { title: 'Integrations', help: 'Email delivery status and log. WhatsApp is paused; the AI assistant is stage 8.', to: 'integrations', perm: 'messaging.configure' },
  { title: 'AI assistant', help: 'Switch on per company; model, permitted roles and tasks, usage limit, retention.', to: 'ai', perm: 'ai.configure' },
  { title: 'Import', help: 'Bring in people or properties from a spreadsheet, with a preview and duplicate checks.', to: 'import', perm: 'staff.create' },
  { title: 'Retention', help: 'Leavers and records past your retention period; anonymise leavers.', to: 'retention', perm: 'super_admin' },
];

export function Admin() {
  return (
    <Routes>
      <Route index element={<AdminHome />} />
      <Route path="companies" element={<Companies />} />
      <Route path="access" element={<Access />} />
      <Route path="audit" element={<Audit />} />
      <Route path="integrations" element={<Integrations />} />
      <Route path="ai" element={<AiSettings />} />
      <Route path="import" element={<ImportPage />} />
      <Route path="retention" element={<RetentionPage />} />
      <Route path="templates" element={<TemplatesAdmin />} />
    </Routes>
  );
}

function AdminHome() {
  const hub = useHub();
  const [term, setTerm] = useState('');
  const cards = CARDS.filter((c) => `${c.title} ${c.help}`.toLowerCase().includes(term.toLowerCase()));
  return (
    <>
      <PageHead title="Admin Centre" intro="Settings and controls for the companies you administer. Changes are recorded in the audit log." />
      <div className="field" style={{ maxWidth: 420 }}><label htmlFor="admin-q">Find a setting</label><input id="admin-q" type="search" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
      <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
        {cards.map((c) => {
          const allowed = !c.perm || (c.perm === 'super_admin' ? hub.me.superAdmin : hub.can(c.perm));
          const built = !!c.to;
          return (
            <li key={c.title} className="card">
              <h2 style={{ fontSize: '1.125rem' }}>{built && allowed ? <Link to={c.to!}>{c.title}</Link> : c.title}</h2>
              <p className="muted">{c.help}</p>
              {!built ? <Status s="planned" text={`Not built yet — stage ${c.stage}`} /> : !allowed ? <Status s="not_required" text="You do not have access" /> : null}
              {c.note && <p className="small muted" style={{ marginTop: 8 }}>{c.note}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Companies() {
  const hub = useHub();
  const toast = useToast();
  const cos = hub.me.companies.filter((c) => c.perms.includes('company.manage'));
  const [edit, setEdit] = useState<any>(null);
  const save = useSubmit(async () => {
    await patch(`/companies/${edit.id}`, { legal_name: edit.legal_name, company_number: edit.company_number || null, registered_address: edit.registered_address || null, details_verified: !!edit.details_verified, support_system_url: edit.support_system_url || null, help_contact: edit.help_contact || null, clearance_rule: edit.clearance_rule });
    setEdit(null); toast('Company saved.'); hub.reloadMe();
  });
  const open = async (id: string) => setEdit(await get(`/companies/${id}`));
  return (
    <>
      <PageHead title="Companies" crumbs={[['Admin Centre', '/admin'], ['Companies']]} intro="Each company is a separate legal entity. Leave details blank until they have been verified — never guess them." />
      {cos.length === 0 ? <Empty>You do not administer any company.</Empty> : (
        <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>{cos.map((c) => (
          <li key={c.id} className="card"><h2 style={{ fontSize: '1.125rem' }}><CompanyBadge code={c.code} name={c.name} /> {c.legal_name ?? c.name}</h2>
            <p>{c.details_verified ? <Status s="verified" text="Details verified" /> : <Status s="evidence_missing" text="Details not verified" />}</p>
            <p className="small">Clearance rule: <strong>{c.clearance_rule === 'block' ? 'Block deployment without clearance' : 'Warn only'}</strong><br />Support system link: {c.support_system_url ? 'set' : 'not set'}</p>
            <Button variant="secondary" onClick={() => open(c.id)}>Edit {c.code}</Button></li>
        ))}</ul>
      )}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.name ?? ''}`} footer={<Button busy={save.busy} onClick={() => save.run()}>Save Changes</Button>}>
        {edit && <>
          <ErrorSummary error={save.error} />
          <Field label="Legal name"><input name="legal_name" value={edit.legal_name ?? ''} onChange={(e) => setEdit({ ...edit, legal_name: e.target.value })} /></Field>
          <Field label="Company number" optional hint="From Companies House. Leave blank until checked."><input name="company_number" value={edit.company_number ?? ''} onChange={(e) => setEdit({ ...edit, company_number: e.target.value })} /></Field>
          <Field label="Registered address" optional><textarea name="registered_address" value={edit.registered_address ?? ''} onChange={(e) => setEdit({ ...edit, registered_address: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={!!edit.details_verified} onChange={(e) => setEdit({ ...edit, details_verified: e.target.checked })} /> I have verified these legal details against an official source</label>
          <Field label="Open Support System link" optional hint="A link only (https). The Hub does not connect to or sign in to the support system." error={save.error?.fields.support_system_url}><input name="support_system_url" type="url" value={edit.support_system_url ?? ''} onChange={(e) => setEdit({ ...edit, support_system_url: e.target.value })} /></Field>
          <Field label="Help contact shown to staff" optional><input name="help_contact" value={edit.help_contact ?? ''} onChange={(e) => setEdit({ ...edit, help_contact: e.target.value })} /></Field>
          <Field label="When someone has no deployment clearance"><select name="clearance_rule" value={edit.clearance_rule} onChange={(e) => setEdit({ ...edit, clearance_rule: e.target.value })}><option value="block">Block property allocation and visits (exceptions need authorisation)</option><option value="warn">Warn but allow</option></select></Field>
        </>}
      </Dialog>
    </>
  );
}

function Access() {
  const hub = useHub();
  const toast = useToast();
  const grants = useApi<any[]>('/admin/grants');
  const roles = useApi<any>('/admin/roles');
  const people = useApi<any[]>('/people');
  const [f, setF] = useState<any>(null);
  const [showInactive, setShowInactive] = useState(false);
  const cos = hub.me.companies.filter((c) => c.perms.includes('access.manage'));
  const grant = useSubmit(async () => {
    if (!f.person_id) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { person_id: 'Choose a person' } });
    await post('/admin/grants', { person_id: f.person_id, role_key: f.role_key, company_id: f.role_key === 'super_admin' ? null : f.company_id, reason: f.reason, expires_at: f.expires_at ? new Date(`${f.expires_at}T23:59:00`).toISOString() : null });
    setF(null); toast('Role granted.'); grants.reload();
  });
  const revoke = useSubmit(async (id: string) => { await post(`/admin/grants/${id}/revoke`); toast('Role revoked.'); grants.reload(); });
  const rows = (grants.data ?? []).filter((g) => showInactive || g.active);
  const role = roles.data?.roles.find((r: any) => r.key === f?.role_key);
  return (
    <>
      <PageHead title="Permissions and access review" crumbs={[['Admin Centre', '/admin'], ['Permissions']]} intro="Everyone with a current appointment has staff access in that company. Extra roles are granted here. Responsibility for something is separate from access to it."
        actions={<Button onClick={() => setF({ person_id: '', role_key: 'manager', company_id: cos[0]?.id ?? '', reason: '', expires_at: '' })}>Grant a role</Button>} />
      {grants.error && <LoadError error={grants.error} />}
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show revoked and expired grants</label>
      <ErrorSummary error={revoke.error} />
      {grants.loading && !grants.data ? <Skeleton /> : rows.length === 0 ? <Empty>No grants.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Company</th><th>Granted</th><th>Ends</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rows.map((g) => (
            <tr key={g.id}>
              <td>{g.person_name}<div className="muted small">{g.email}</div></td>
              <td>{g.role_label}{g.privileged && <div><Status s="info" text="Needs two-step verification" /></div>}</td>
              <td>{g.company_id ? <CompanyBadge code={g.company_code} name={g.company_name} /> : 'All companies'}</td>
              <td className="small">{fmtDateTime(g.valid_from)}<br />{g.granted_by_name ?? 'Setup'} — {g.reason}</td>
              <td>{g.expires_at ? fmtDateTime(g.expires_at) : 'No end date'}</td>
              <td>{g.active ? <Status s="active" /> : <Status s="ended" text={g.revoked_at ? 'Revoked' : 'Expired'} />}</td>
              <td>{g.active && g.person_id !== hub.me.person.id && <Button variant="ghost" busy={revoke.busy} onClick={() => revoke.run(g.id)}>Revoke<span className="sr-only"> {g.role_label} from {g.person_name}</span></Button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Dialog open={!!f} onClose={() => setF(null)} title="Grant a role" footer={<Button busy={grant.busy} onClick={() => grant.run()}>Grant role</Button>}>
        {f && <>
          <ErrorSummary error={grant.error} />
          <Field label="Person" error={grant.error?.fields.person_id}><select name="person_id" value={f.person_id} onChange={(e) => setF({ ...f, person_id: e.target.value })}><option value="">Choose…</option>{people.data?.filter((p) => p.id !== hub.me.person.id && p.status !== 'left').map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Role"><select name="role_key" value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })}>{roles.data?.roles.filter((r: any) => r.key !== 'staff' && (r.key !== 'super_admin' || hub.me.superAdmin)).map((r: any) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
          {role && <p className="small muted">{role.description} Permissions: {role.permissions.map((p: string) => label(p.replace('.', ' '))).join(', ')}.</p>}
          {f.role_key !== 'super_admin' && <Field label="Company" error={grant.error?.fields.company_id}><select name="company_id" value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <Field label="End date" optional={f.role_key !== 'reviewer'} hint="Use for temporary delegation. Time-limited reviewers must have one." error={grant.error?.fields.expires_at}><input name="expires_at" type="date" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} /></Field>
          <Field label="Reason" error={grant.error?.fields.reason}><input name="reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </>}
      </Dialog>
    </>
  );
}

function Audit() {
  const hub = useHub();
  const [before, setBefore] = useState<number | null>(null);
  const d = useApi<any[]>(`/audit${hub.q({ before: before ? String(before) : undefined })}`);
  return (
    <>
      <PageHead title="Audit log" crumbs={[['Admin Centre', '/admin'], ['Audit']]} intro="Material changes and sensitive access. Personal values are not copied into the log." />
      {d.error && <LoadError error={d.error} />}
      {d.loading && !d.data ? <Skeleton lines={8} /> : (d.data ?? []).length === 0 ? <Empty>No entries.</Empty> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>Company</th><th>Record</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>{d.data!.map((l) => <tr key={l.id}><td>{fmtDateTime(l.at)}</td><td>{l.actor_name ?? 'System'}</td><td>{l.company_code ?? '—'}</td><td>{label(l.entity)}</td><td>{label(l.action)}</td><td className="small"><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(l.detail)}</code></td></tr>)}</tbody>
          </table></div>
          <div className="row" style={{ marginTop: 16 }}>{before && <Button variant="secondary" onClick={() => setBefore(null)}>Newest</Button>}{d.data!.length === 100 && <Button variant="secondary" onClick={() => setBefore(d.data![d.data!.length - 1].id)}>Older entries</Button>}</div>
        </>
      )}
    </>
  );
}

function Integrations() {
  const hub = useHub();
  const d = useApi<any[]>(`/outbound${hub.q()}`);
  return (
    <>
      <PageHead title="Integrations" crumbs={[['Admin Centre', '/admin'], ['Integrations']]} intro="Outbound email reminders. Messages only point people to the Hub; they never carry personal details." />
      <div className="notice">Email sends through the provider set in the server environment (RESEND_API_KEY and EMAIL_FROM). Until both are set, messages are recorded as "Not configured" and nothing is sent. WhatsApp Business is paused. In-app notifications always work.</div>
      {d.error && <LoadError error={d.error} />}
      {(d.data ?? []).length === 0 ? <Empty>No outbound messages yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Company</th><th>What</th><th>Status</th><th className="num">Attempts</th><th>Last error</th></tr></thead>
          <tbody>{d.data!.map((o) => <tr key={o.id}><td>{fmtDateTime(o.created_at)}</td><td>{o.person_name}</td><td>{o.company_code}</td><td>{label(o.category)}</td>
            <td><Status s={o.status === 'failed' ? 'action' : o.status === 'sent' || o.status === 'delivered' ? 'verified' : o.status === 'not_configured' ? 'not_required' : 'review'} text={label(o.status)} /></td><td className="num">{o.attempts}</td><td className="small">{o.last_error ?? '—'}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}
