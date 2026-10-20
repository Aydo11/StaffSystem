import { Link } from 'react-router-dom';
import { post, useApi, useSubmit } from '../api.ts';
import { fmtDate, fmtDateTime } from '../format.ts';
import { useHub } from '../hub.tsx';
import { Button, CompanyBadge, Empty, LoadError, PageHead, Skeleton, Status } from '../ui.tsx';
import { EmailPreferences } from './Messages.tsx';

const GROUPS: [string, string][] = [['action', 'Action Required'], ['review', 'Awaiting Your Review'], ['info', 'Coming up']];

export function Inbox() {
  const hub = useHub();
  const d = useApi<any[]>(`/inbox${hub.q()}`);
  return (
    <>
      <PageHead title="Needs Your Review" intro="Approvals and exceptions for you: overdue work, missing finish times, overdue check-ins, returned work and reviews due. Each item says who owns it and what happens next." />
      {d.error && <LoadError error={d.error} retry={d.reload} />}
      {d.loading && !d.data ? <Skeleton lines={6} /> : (d.data ?? []).length === 0 ? <Empty>Nothing needs your attention. All clear.</Empty> : GROUPS.map(([sev, title]) => {
        const items = d.data!.filter((i) => i.severity === sev);
        if (!items.length) return null;
        return (
          <section key={sev} className="card" aria-labelledby={`g-${sev}`}>
            <h2 id={`g-${sev}`}>{title} <span className="muted">({items.length})</span></h2>
            <ul className="list">{items.map((i, n) => (
              <li key={n}>
                <div>
                  <Link to={i.link}><strong>{i.title}</strong></Link>
                  <div className="row small" style={{ gap: 8, marginTop: 4 }}><CompanyBadge code={i.company_code} name={i.company_name} /><span>Owner: {i.owner}</span>{i.due && <span>· {sev === 'info' ? 'Due' : 'Since'} {fmtDate(i.due)}</span>}</div>
                  <div className="small muted">Next step: {i.next_step}</div>
                </div>
                <Status s={sev} />
              </li>
            ))}</ul>
          </section>
        );
      })}
    </>
  );
}

export function Notifications() {
  const { reloadMe } = useHub();
  const d = useApi<any[]>('/notifications');
  const read = useSubmit(async () => { await post('/notifications/read'); await d.reload(); await reloadMe(); });
  return (
    <>
      <PageHead title="Notifications" intro="In-app notifications. These are always kept here, even if an email or message could not be delivered." actions={<Button variant="secondary" busy={read.busy} onClick={() => read.run()}>Mark all as read</Button>} />
      {d.loading && !d.data ? <Skeleton /> : (d.data ?? []).length === 0 ? <Empty>No notifications.</Empty> : (
        <ul className="list card">{d.data!.map((n) => (
          <li key={n.id}><div>{!n.read_at && <span className="badge st-info" style={{ marginRight: 8 }}>New</span>}{n.link ? <Link to={n.link}>{n.title}</Link> : n.title}{n.body && <div className="small">“{n.body}”</div>}<div className="muted small">{n.company_name ?? 'All companies'} · {fmtDateTime(n.created_at)}</div></div></li>
        ))}</ul>
      )}
      <EmailPreferences />
    </>
  );
}
