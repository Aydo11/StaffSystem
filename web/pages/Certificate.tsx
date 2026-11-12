// A certificate of completion for a Hub course, laid out for A4 landscape. "Save as PDF" is the browser's print dialog.
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { useApi } from '../api.ts';
import { fmtDate } from '../format.ts';
import { Button, LoadError, Skeleton } from '../ui.tsx';

export function CertificatePage() {
  const { id } = useParams();
  const d = useApi<any>(`/training/certificates/${id}`);
  useEffect(() => { if (d.data) document.title = `Certificate – ${d.data.title} – ${d.data.full_name}`; return () => { document.title = 'Hub'; }; }, [d.data]);
  if (d.error) return <LoadError error={d.error} retry={d.reload} />;
  if (!d.data) return <Skeleton lines={8} />;
  const c = d.data;
  const org = c.company?.legal_name || c.company?.name || 'Your organisation';
  return (
    <div className="cert-wrap">
      <div className="no-print row between" style={{ marginBottom: 16 }}>
        <Link to="/training?tab=record">← Back to training</Link>
        <Button onClick={() => window.print()}><Printer size={18} aria-hidden="true" />Save as PDF or print</Button>
      </div>
      <article className="cert" style={c.company?.brand_primary ? ({ '--cert': c.company.brand_primary } as any) : undefined} aria-label="Certificate of completion">
        <p className="cert-org">{org}</p>
        <h1 className="cert-title">Certificate of completion</h1>
        <p className="cert-small">This is to certify that</p>
        <p className="cert-name">{c.full_name}</p>
        <p className="cert-small">has completed</p>
        <p className="cert-course">{c.title}</p>
        <div className="cert-foot">
          <div><span className="cert-line">{fmtDate(c.completed_on)}</span><span className="cert-small">Date completed</span></div>
          <div><span className="cert-line">{c.issued_by_name ?? org}</span><span className="cert-small">{c.issued_by_name ? `Issued by, for ${org}` : 'Issued by'}</span></div>
        </div>
        <p className="cert-note">Internal training issued by {org}. Not an accredited or externally recognised qualification. Ref {c.id.slice(0, 8).toUpperCase()}</p>
      </article>
    </div>
  );
}
