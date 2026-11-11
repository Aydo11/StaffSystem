// My team: the staff assigned to me, and (for people who can assign) who manages whom. Server: routes/team.ts.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useApi, useSubmit } from '../api.ts';
import { useHub } from '../hub.tsx';
import { Avatar, Button, CompanyBadge, Dialog, Empty, ErrorSummary, LoadError, PageHead, Skeleton, Status, useToast } from '../ui.tsx';

export function Team() {
  const hub = useHub();
  const d = useApi<any>(`/team${hub.q()}`);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const { members, managedBy, managers, staff, canAssign } = d.data;
  return (
    <>
      <PageHead title="My team" intro="Staff assigned to you to manage. You can see and approve their visits, time, timesheets and leave, and see their tasks." />
      {managedBy.length > 0 && <p className="small muted">You are managed by {managedBy.map((m: any) => `${m.name} (${m.company_code})`).join(', ')}.</p>}
      <section className="card" aria-labelledby="mine-h">
        <h2 id="mine-h">Assigned to you ({members.length})</h2>
        {members.length === 0 ? <Empty>No one is assigned to you yet.{canAssign.length ? ' Use “Who manages whom” below to assign staff.' : ' A manager or administrator assigns staff.'}</Empty> : (
          <ul className="list">{members.map((m: any) => (
            <li key={m.assignment_id}>
              <span className="row" style={{ alignItems: 'center' }}>
                <Avatar personId={m.id} name={m.full_name} hasPhoto={m.has_photo} />
                <span><Link to={`/people/${m.id}`}><strong>{m.name}</strong></Link> <CompanyBadge code={m.company_code} name={m.company_name} />{m.away && <> <Status s="info" text="Away today" /></>}
                  <br /><span className="small muted">{m.job_title ?? 'No current role'}</span></span>
              </span>
              <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {m.visits_to_review > 0 && <Link className="badge st-warn" to="/inbox">{m.visits_to_review} visit{m.visits_to_review > 1 ? 's' : ''} to review</Link>}
                {m.time_to_review > 0 && <Link className="badge st-warn" to="/timesheets?tab=review">{m.time_to_review} time to review</Link>}
                {m.leave_to_decide > 0 && <Link className="badge st-warn" to="/leave">{m.leave_to_decide} leave to decide</Link>}
                {m.overdue_tasks > 0 && <Status s="action" text={`${m.overdue_tasks} overdue task${m.overdue_tasks > 1 ? 's' : ''}`} />}
                {m.training_overdue > 0 && <Status s="action" text={`${m.training_overdue} training overdue`} />}
                <span className="small muted">{m.open_tasks} open task{m.open_tasks === 1 ? '' : 's'}</span>
              </span>
            </li>))}</ul>)}
      </section>
      {canAssign.length > 0 && <Assignments managers={managers} staff={staff} reload={d.reload} />}
    </>
  );
}

function Assignments({ managers, staff, reload }: { managers: any[]; staff: any[]; reload: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState<any>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const end = useSubmit(async (a: any, m: any) => { await post(`/staff-assignments/${a.assignment_id}/end`); toast(`${a.name} is no longer assigned to ${m.name}.`); reload(); });
  const save = useSubmit(async () => {
    const r = await post('/staff-assignments', { company_id: adding.company_id, manager_id: adding.id, person_ids: picked });
    toast(`${r.added.length} assigned to ${adding.name}.`); setAdding(null); reload();
  });
  const choices = adding ? staff.filter((s) => s.company_id === adding.company_id && s.id !== adding.id && !adding.staff.some((x: any) => x.id === s.id)) : [];
  return (
    <section className="card" aria-labelledby="who-h">
      <h2 id="who-h">Who manages whom</h2>
      <p className="small muted">Managers already oversee all staff in their company; assigning staff to them builds their team list. Support managers see and approve only the staff assigned to them. Support, maintenance and cleaning staff can be assigned.</p>
      <ErrorSummary error={end.error} />
      {managers.length === 0 ? <Empty>No one has a manager or support manager role yet. Give someone that job role on their profile (Roles tab) first.</Empty> : (
        <ul className="list">{managers.map((m) => (
          <li key={`${m.company_id}-${m.id}`} style={{ alignItems: 'flex-start' }}>
            <span><Link to={`/people/${m.id}`}><strong>{m.name}</strong></Link> <CompanyBadge code={m.company_code} name={m.company_name} /><br /><span className="small muted">{m.job_title}</span>
              <span className="chips" style={{ marginTop: 6 }} aria-label={`Staff assigned to ${m.name}`}>
                {m.staff.length === 0 ? <span className="small muted">No staff assigned</span> : m.staff.map((s: any) => (
                  <span key={s.assignment_id} className="badge st-info">{s.name}
                    <button type="button" className="linkish" style={{ marginLeft: 6 }} disabled={end.busy} onClick={() => end.run(s, m)} aria-label={`Remove ${s.name} from ${m.name}'s team`}>×</button></span>))}
              </span></span>
            <Button variant="secondary" onClick={() => { setAdding(m); setPicked([]); }}>Assign staff</Button>
          </li>))}</ul>)}
      {adding && (
        <Dialog open onClose={() => setAdding(null)} title={`Assign staff to ${adding.name}`} footer={<Button busy={save.busy} disabled={!picked.length} onClick={() => save.run()}>Assign {picked.length || ''}</Button>}>
          <ErrorSummary error={save.error} />
          {choices.length === 0 ? <Empty>Everyone who can be assigned in {adding.company_name} is already assigned to {adding.name}.</Empty> : (
            <fieldset style={{ border: 0, padding: 0 }}><legend className="small muted">Support, maintenance and cleaning staff in {adding.company_name}</legend>
              {choices.map((s) => <label key={s.id} className="check"><input type="checkbox" checked={picked.includes(s.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} /> {s.name} <span className="small muted">· {s.job_title}</span></label>)}
            </fieldset>)}
        </Dialog>)}
    </section>
  );
}
