// House mood ratings, complaints and maintenance: the visit form sections and the property display.
import { Field, Icon } from './ui.tsx';

export const ASPECTS: [string, string][] = [['kitchen', 'Kitchen'], ['bathroom', 'Bathroom'], ['bedrooms', 'Bedrooms'], ['living_areas', 'Living areas'], ['garden', 'Garden and outside'], ['communal', 'Hallways and communal areas']];
const TIPS: Record<string, string> = {
  kitchen: 'Deep clean the kitchen, check appliances and worktops, and agree a cleaning rota.',
  bathroom: 'Check for damp, mould and leaks, renew sealant and arrange a deep clean.',
  bedrooms: 'Check windows, heating, furniture and smoke alarms; report any damp or damage.',
  living_areas: 'Declutter, check furniture and lighting, and make the space more welcoming.',
  garden: 'Clear rubbish and overgrowth, check bins and fences, and book a garden tidy.',
  communal: 'Clean hallways and stairs, keep fire exits clear and check lighting and fire doors.',
};
export const SOURCES: [string, string][] = [['resident', 'A resident'], ['neighbour', 'A neighbour'], ['visitor', 'A visitor or family member'], ['staff', 'A member of staff'], ['other', 'Someone else']];
export const CATEGORIES: [string, string][] = [['noise', 'Noise'], ['cleanliness', 'Cleanliness'], ['repairs', 'Repairs or condition'], ['behaviour', 'Behaviour'], ['staff_conduct', 'Staff conduct'], ['safety', 'Safety'], ['other', 'Other']];

export type Tone = 'low' | 'mid' | 'high' | 'none';
export const tone = (score: number | null | undefined): Tone => score == null ? 'none' : score < 60 ? 'low' : score < 80 ? 'mid' : 'high';
const TONE_TEXT: Record<Tone, string> = { low: 'Needs attention', mid: 'Fair', high: 'Good', none: 'Not rated yet' };

// Overall score as a coloured bar: red under 60%, amber under 80%, green above.
export function ConditionBar({ score, compact }: { score: number | null | undefined; compact?: boolean }) {
  const t = tone(score);
  return (
    <div className={`cond cond-${t}${compact ? ' compact' : ''}`}>
      <div className="cond-head"><span>House mood</span><strong>{score == null ? '—' : `${score}%`} <span className="cond-word">{TONE_TEXT[t]}</span></strong></div>
      <div className="cond-track" role="meter" aria-label="House mood score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score ?? 0} aria-valuetext={score == null ? 'Not rated yet' : `${score}%, ${TONE_TEXT[t]}`}>
        <span style={{ width: `${score ?? 0}%` }} />
      </div>
    </div>
  );
}

export function Stars({ n }: { n: number }) {
  return <span className="stars" role="img" aria-label={`${n} out of 5 stars`}>{[1, 2, 3, 4, 5].map((i) => <span key={i} aria-hidden="true" className={i <= n ? 'on' : ''}>★</span>)}</span>;
}

// One aspect: five star radios plus "Not checked".
function StarInput({ name, label, value, onChange }: { name: string; label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <fieldset className="star-input">
      <legend>{label}</legend>
      <div className="star-row">
        {[1, 2, 3, 4, 5].map((i) => (
          <label key={i} className={value != null && i <= value ? 'on' : ''}>
            <input type="radio" name={name} checked={value === i} onChange={() => onChange(i)} className="sr-only" />
            <span aria-hidden="true">★</span><span className="sr-only">{i} star{i === 1 ? '' : 's'}</span>
          </label>
        ))}
        <label className={`star-na${value == null ? ' picked' : ''}`}><input type="radio" name={name} checked={value == null} onChange={() => onChange(null)} className="sr-only" />Not checked</label>
      </div>
    </fieldset>
  );
}

export const EXTRA_LABELS = { rating: 'House mood rating', 'complaint.summary': 'Complaint', 'repair.title': 'Maintenance' };
export type Extras = { rating: Record<string, number | null>; note: string; complaint: { source: string; category: string; summary: string }; repair: { title: string; urgency: string; description: string } };
export const blankExtras = (): Extras => ({ rating: Object.fromEntries(ASPECTS.map(([k]) => [k, null])), note: '', complaint: { source: 'resident', category: 'noise', summary: '' }, repair: { title: '', urgency: 'routine', description: '' } });
export const rated = (x: Extras) => ASPECTS.some(([k]) => x.rating[k] != null);
// What the visit save sends; the complaint and repair are only sent when filled in.
export const extrasPayload = (x: Extras) => ({
  rating: rated(x) ? { ...x.rating, note: x.note.trim() || null } : undefined,
  complaint: x.complaint.summary.trim() ? { ...x.complaint, summary: x.complaint.summary.trim() } : undefined,
  repair: x.repair.title.trim() ? { title: x.repair.title.trim(), urgency: x.repair.urgency, description: x.repair.description.trim() || null } : undefined,
});

export function ComplaintFields({ value: c, onChange, error }: { value: Extras['complaint']; onChange: (c: Extras['complaint']) => void; error?: string }) {
  return <>
    <div className="grid-2 tight">
      <Field label="Who made the complaint?"><select value={c.source} onChange={(e) => onChange({ ...c, source: e.target.value })}>{SOURCES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      <Field label="What is it about?"><select value={c.category} onChange={(e) => onChange({ ...c, category: e.target.value })}>{CATEGORIES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
    </div>
    <Field label="What was the complaint?" error={error} hint="What happened and what they would like done. Only include personal details the complaints manager needs."><textarea rows={3} maxLength={4000} value={c.summary} onChange={(e) => onChange({ ...c, summary: e.target.value })} /></Field>
  </>;
}

// The three fold-away sections of the visit form.
export function VisitExtras({ value: x, onChange, ratingError, fieldErrors = {} }: { value: Extras; onChange: (x: Extras) => void; ratingError?: string; fieldErrors?: Record<string, string> }) {
  const n = ASPECTS.filter(([k]) => x.rating[k] != null).length;
  return (
    <div className="extras">
      <details className="extra" open>
        <summary><Icon name="smile" size={18} /><span>House mood rating <span className="req">required</span></span><span className="extra-state">{n ? `${n} rated` : 'Not rated'}</span></summary>
        <div className="extra-body">
          {ratingError && <p className="err" role="alert">Error: {ratingError}</p>}
          <p className="small muted">Rate each part of the home you saw, from 1 (poor) to 5 (excellent). Choose “Not checked” for anything you did not see.</p>
          {ASPECTS.map(([k, t]) => <StarInput key={k} name={`rate-${k}`} label={t} value={x.rating[k]} onChange={(v) => onChange({ ...x, rating: { ...x.rating, [k]: v } })} />)}
          <Field label="What needs improving?" optional><textarea rows={2} maxLength={1000} value={x.note} onChange={(e) => onChange({ ...x, note: e.target.value })} /></Field>
        </div>
      </details>
      <details className="extra">
        <summary><Icon name="note" size={18} /><span>Log a complaint</span><span className="extra-state">{x.complaint.summary.trim() ? 'Added' : 'Optional'}</span></summary>
        <div className="extra-body">
          <p className="small muted">It goes straight to your company’s complaints manager as a task, and is kept on the property’s record.</p>
          <ComplaintFields value={x.complaint} onChange={(c) => onChange({ ...x, complaint: c })} error={fieldErrors['complaint.summary']} />
        </div>
      </details>
      <details className="extra">
        <summary><Icon name="settings" size={18} /><span>Report maintenance</span><span className="extra-state">{x.repair.title.trim() ? 'Added' : 'Optional'}</span></summary>
        <div className="extra-body">
          <Field label="What needs fixing?" error={fieldErrors['repair.title']}><input maxLength={200} value={x.repair.title} onChange={(e) => onChange({ ...x, repair: { ...x.repair, title: e.target.value } })} placeholder="e.g. Kitchen tap leaking" /></Field>
          <Field label="How urgent is it?"><select value={x.repair.urgency} onChange={(e) => onChange({ ...x, repair: { ...x.repair, urgency: e.target.value } })}><option value="routine">Routine (within 28 days)</option><option value="urgent">Urgent (within 7 days)</option><option value="emergency">Emergency (within 24 hours)</option></select></Field>
          <Field label="Details" optional hint="Describe the property issue only, not residents."><textarea rows={2} maxLength={4000} value={x.repair.description} onChange={(e) => onChange({ ...x, repair: { ...x.repair, description: e.target.value } })} /></Field>
        </div>
      </details>
    </div>
  );
}

// Suggestions: the lowest-rated parts first, then open complaints and repairs.
export function suggestions(aspects: Record<string, number> | null, openComplaints: number, openRepairs: number) {
  const out = ASPECTS.filter(([k]) => aspects?.[k] != null && aspects[k] <= 3).sort(([a], [b]) => aspects![a] - aspects![b]).map(([k, t]) => `${t} (${aspects![k]}/5): ${TIPS[k]}`);
  if (openComplaints) out.push(`Resolve ${openComplaints} open complaint${openComplaints === 1 ? '' : 's'}.`);
  if (openRepairs) out.push(`Complete ${openRepairs} outstanding repair${openRepairs === 1 ? '' : 's'}.`);
  return out;
}
