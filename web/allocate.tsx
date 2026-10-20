import { useMemo, useState } from 'react';
import { ApiError, post } from './api.ts';
import { Avatar, Button, CompanyBadge, Dialog, Empty, Field, Skeleton, useToast } from './ui.tsx';

// One row the manager can tick: an appointment + property pair, shown as a name with a sub-line.
export type AllocOption = { key: string; appointmentId: string; propertyId: string; title: string; sub?: string; companyCode?: string; personId?: string; hasPhoto?: boolean };
type Held = AllocOption & { message: string; canOverride: boolean };

// Tick several, allocate in one go. Anyone blocked by deployment clearance stays ticked with the reason, and can be
// allocated with a recorded exception if the manager is allowed to authorise one (same server rule as a single allocation).
export function AllocateDialog({ title, options, loading, searchLabel, onClose, onDone }: { title: string; options: AllocOption[] | null; loading?: boolean; searchLabel: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [held, setHeld] = useState<Held[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false); // some were allocated: the page must refresh on close
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (options ?? []).filter((o) => !q || `${o.title} ${o.sub ?? ''} ${o.companyCode ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const overriding = held.some((h) => h.canOverride) && reason.trim().length >= 5;

  const run = async () => {
    setBusy(true);
    const todo = (options ?? []).filter((o) => picked.has(o.key));
    const ok: string[] = [], notes: string[] = [], stillHeld: Held[] = [];
    for (const o of todo) {
      const isHeld = held.find((h) => h.key === o.key);
      try {
        const r = await post(`/appointments/${o.appointmentId}/properties`, { property_id: o.propertyId, override_reason: isHeld?.canOverride && overriding ? reason.trim() : undefined });
        ok.push(o.key);
        if (r.warnings?.length) notes.push(`${o.title}: ${r.warnings.join(' ')}`);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'error', String(e));
        stillHeld.push({ ...o, message: err.message, canOverride: err.code === 'clearance_required' && !!err.details?.canOverride });
      }
    }
    setBusy(false);
    if (ok.length) toast(`${ok.length} allocated.${notes.length ? ` Note: ${notes.join(' ')}` : ''}`);
    if (!stillHeld.length) { onDone(); return; }
    if (ok.length) setChanged(true);
    setHeld(stillHeld);
    setPicked(new Set(stillHeld.map((h) => h.key)));
  };

  const count = picked.size;
  return (
    <Dialog open onClose={() => { if (!busy) (changed ? onDone : onClose)(); }} title={title}
      footer={<Button busy={busy} busyText="Allocating…" disabled={!count} onClick={run}>{overriding ? 'Authorise exception and allocate' : count > 1 ? `Allocate ${count}` : 'Allocate'}</Button>}>
      {held.length > 0 && (
        <div className="error-summary" role="alert">
          <h2>{held.length === 1 ? 'One was not allocated' : `${held.length} were not allocated`}</h2>
          <ul>{held.map((h) => <li key={h.key}><strong>{h.title}</strong>: {h.message}</li>)}</ul>
        </div>
      )}
      {held.some((h) => h.canOverride) && (
        <Field label="Reason for authorising an exception" hint="Recorded with your name against each one. Only use it where you have the authority to do so.">
          <textarea name="override_reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {loading && !options ? <Skeleton /> : !options?.length ? <Empty>Nothing left to allocate here.</Empty> : (
        <>
          {options.length > 6 && <Field label={searchLabel}><input name="alloc_search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" /></Field>}
          <p className="small muted" aria-live="polite">{count ? `${count} selected` : 'Tick one or more.'}</p>
          <ul className="pick-list">
            {shown.map((o) => (
              <li key={o.key}>
                <label>
                  <input type="checkbox" checked={picked.has(o.key)} onChange={() => toggle(o.key)} />
                  {o.personId && <Avatar personId={o.personId} name={o.title} hasPhoto={o.hasPhoto} />}
                  <span className="grow"><strong>{o.title}</strong>{o.sub && <><br /><span className="muted small">{o.sub}</span></>}</span>
                  <CompanyBadge code={o.companyCode} />
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="muted">No matches.</li>}
          </ul>
        </>
      )}
    </Dialog>
  );
}
