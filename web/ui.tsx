import { cloneElement, createContext, type ReactElement, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, blobUrl } from './api.ts';
import { initials, label } from './format.ts';

// ── Icons (inline, decorative: always paired with a visible or sr-only label) ──
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  building: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M2 21h20',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  check: 'M4 12l5 5L20 6',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  menu: 'M3 6h18M3 12h18M3 18h18',
  x: 'M18 6L6 18M6 6l12 12',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  play: 'M6 4l14 8-14 8z',
  note: 'M4 4h16v12H8l-4 4z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ── Buttons ──
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'go' | 'danger' | 'ghost'; busy?: boolean; big?: boolean; block?: boolean; busyText?: string };
export function Button({ variant = 'primary', busy, big, block, busyText = 'Saving…', className = '', children, disabled, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'primary' && variant, big && 'big', block && 'block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <><span className="spinner" aria-hidden="true" />{busyText}</> : children}
    </button>
  );
}

// ── Form fields: label, hint and error are wired to the control for screen readers ──
export function Field({ label: text, error, hint, children, optional }: { label: string; error?: string; hint?: ReactNode; children: ReactElement<any>; optional?: boolean }) {
  const id = useId();
  const name = (children.props as any).name ?? id;
  const fid = `f-${name}`;
  const desc = [hint && `${fid}-hint`, error && `${fid}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{text}{optional && <span className="muted"> (optional)</span>}</label>
      {hint && <span className="hint" id={`${fid}-hint`}>{hint}</span>}
      {error && <span className="err" id={`${fid}-err`}>Error: {error}</span>}
      {cloneElement(children, { id: fid, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined })}
    </div>
  );
}

// GOV.UK-style error summary: focused when it appears, links jump to the field.
export function ErrorSummary({ error, labels = {} }: { error: ApiError | null; labels?: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  if (!error) return null;
  const fields = Object.entries(error.fields);
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <h2>{fields.length ? 'There is a problem' : 'This was not saved'}</h2>
      <p style={{ margin: fields.length ? '0 0 8px' : 0 }}>{error.message}</p>
      {fields.length > 0 && (
        <ul>{fields.map(([k, v]) => <li key={k}><a href={`#f-${k}`}>{labels[k] ?? label(k)}: {v}</a></li>)}</ul>
      )}
    </div>
  );
}

// ── Badges: names and words, never colour alone ──
export function CompanyBadge({ code, name }: { code?: string; name?: string }) {
  if (!code) return null;
  return <span className="badge co" title={name}><span aria-hidden="true">●</span>{code}<span className="sr-only"> — {name}</span></span>;
}
const STATUS: Record<string, [string, string]> = {
  // visits
  in_progress: ['st-info', 'In progress'], submitted: ['st-warn', 'Needs review'], approved: ['st-ok', 'Approved'], rejected: ['st-bad', 'Returned'], cancelled: ['st-neutral', 'Cancelled'],
  scheduled: ['st-info', 'Scheduled'], missed: ['st-bad', 'Missed'], completed: ['st-ok', 'Completed'], correction: ['st-warn', 'Correction required'],
  // tasks
  not_started: ['st-neutral', 'Not Started'], changes_requested: ['st-bad', 'Changes Requested'],
  // clearance
  pending: ['st-warn', 'Pending'], cleared: ['st-ok', 'Cleared'], cleared_with_restrictions: ['st-warn', 'Cleared with Restrictions'], not_authorised: ['st-bad', 'Not Currently Authorised'], none: ['st-bad', 'No decision'],
  // checks
  evidence_missing: ['st-bad', 'Evidence Missing'], requested: ['st-info', 'Requested'], awaiting_verification: ['st-warn', 'Awaiting Verification'], verified: ['st-ok', 'Verified'], adverse_finding: ['st-bad', 'Adverse finding'], not_required: ['st-neutral', 'Not Applicable'],
  // properties / appointments / people
  active: ['st-ok', 'Active'], void: ['st-neutral', 'Void'], under_works: ['st-warn', 'Under works'], offboarded: ['st-neutral', 'Offboarded'], planned: ['st-info', 'Planned'], suspended: ['st-warn', 'Suspended'], ended: ['st-neutral', 'Ended'], invited: ['st-info', 'Invited'], left: ['st-neutral', 'Left'],
  // priority
  low: ['st-neutral', 'Low'], normal: ['st-info', 'Normal'], high: ['st-warn', 'High'], urgent: ['st-bad', 'Urgent'],
  action: ['st-bad', 'Action Required'], review: ['st-warn', 'Awaiting Review'], info: ['st-info', 'For information'],
};
export function Status({ s, text }: { s: string; text?: string }) {
  const [cls, t] = STATUS[s] ?? ['st-neutral', label(s)];
  return <span className={`badge ${cls}`}>{text ?? t}</span>;
}

// ── Dialog using native <dialog>: focus is trapped and Esc closes; focus returns to the opener ──
export function Dialog({ open, onClose, title, children, variant = 'panel', footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; variant?: 'panel' | 'modal'; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={variant} aria-labelledby={titleId} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn ghost icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
          <div className="dialog-body">{children}{footer && <div className="row" style={{ marginTop: 24 }}>{footer}</div>}</div>
        </>
      )}
    </dialog>
  );
}

// ── Toasts: only after the server confirms; announced politely ──
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const show = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div className="toast" key={t.id}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Avatar({ personId, name, hasPhoto, size }: { personId?: string; name?: string; hasPhoto?: boolean; size?: 'lg' }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    if (hasPhoto && personId) blobUrl(`/people/${personId}/photo`).then((x) => { u = x; setSrc(x); });
    else setSrc(null);
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [personId, hasPhoto]);
  return <span className={`avatar ${size ?? ''}`}>{src ? <img src={src} alt={`Photo of ${name}`} /> : <span aria-hidden="true">{initials(name)}</span>}</span>;
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return <div role="status" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}
export function LoadError({ error, retry }: { error: ApiError; retry?: () => void }) {
  return <div className="notice bad" role="alert"><strong>{error.status === 404 ? 'Not found.' : 'Could not load this.'}</strong> {error.message} {retry && <Button variant="secondary" onClick={retry}>Try again</Button>}</div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ title, intro, crumbs, actions }: { title: string; intro?: ReactNode; crumbs?: [string, string?][]; actions?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Valor & Wellbeing Hub`; }, [title]);
  return (
    <>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>{crumbs.map(([t, to], i) => <li key={i}>{to ? <Link to={to}>{t}</Link> : <span aria-current="page">{t}</span>}</li>)}</ol>
        </nav>
      )}
      <div className="page-head">
        <div><h1 tabIndex={-1} id="page-title">{title}</h1>{intro && <p className="muted">{intro}</p>}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label: aria }: { tabs: [T, string][]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={aria}>
      {tabs.map(([k, t]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} tabIndex={value === k ? 0 : -1} onClick={() => onChange(k)}
          onKeyDown={(e) => {
            const i = tabs.findIndex(([x]) => x === k);
            const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
            if (n >= 0) { onChange(tabs[n][0]); (e.currentTarget.parentElement!.children[n] as HTMLElement).focus(); }
          }}>{t}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, label: aria }: { options: [T, string][]; value: T; onChange: (v: T) => void; label: string }) {
  return <div className="chips" role="group" aria-label={aria}>{options.map(([k, t]) => <button key={k} type="button" className="chip" aria-pressed={value === k} onClick={() => onChange(k)}>{t}</button>)}</div>;
}
