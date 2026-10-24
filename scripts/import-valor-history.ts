// Import extracted workbook sheets; originals and extracted personal data stay outside git.
// Preview is the default. Usage: tsx scripts/import-valor-history.ts INPUT.json ACTOR_UUID [--apply]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type Db, one, pool, q, tx } from '../server/db.ts';

type Sheet = { name: string; rows: { row: number; cells: { ref: string; value: string }[] }[] };
type Row = Record<string, string>;
const SOURCE = 'Valor_Housing_Meetings_Sample_Data_Aug-Oct_2026.xlsx';
const normal = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const date = (n: string) => {
  if (!n || !Number.isFinite(Number(n))) throw new Error('Invalid Excel date');
  return new Date(Date.UTC(1899, 11, 30) + Number(n) * 86400000).toISOString().slice(0, 10);
};
const key = (sheet: string, ref: string) => {
  const h = createHash('sha256').update(`${SOURCE}:${sheet}:${ref}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const rows = (sheets: Sheet[], name: string): Row[] => (sheets.find(s => s.name === name)?.rows ?? [])
  .filter(r => r.row > 4).map(r => Object.fromEntries(r.cells.map(c => [c.ref.replace(/\d/g, ''), c.value]))).filter(r => r.A);

export async function importValorHistory(db: Db, sheets: Sheet[], actorId: string, apply = false, through = '2026-10-24') {
  const company = await one<{ id: string }>("select id from companies where code = 'VH'", [], db);
  if (!company) throw new Error('Valor Housing company not found');
  const actor = await one(`select p.id from people p join role_grants g on g.person_id = p.id
    where p.id = $1 and g.revoked_at is null and g.valid_from <= now() and (g.expires_at is null or g.expires_at > now())
    and (g.role_key = 'super_admin' or (g.role_key = 'company_admin' and g.company_id = $2))`, [actorId, company.id], db);
  if (!actor) throw new Error('Actor must be a current Valor company admin or super admin');
  const people = await q<{ id: string; full_name: string; preferred_name: string | null }>(`select p.id, p.full_name, p.preferred_name from people p
    where exists (select 1 from appointments a where a.person_id = p.id and a.company_id = $1)
      or exists (select 1 from role_grants g where g.person_id = p.id and (g.company_id = $1 or g.role_key = 'super_admin'))`, [company.id], db);
  const properties = await q<{ id: string; name: string; ref: string; address_line1: string }>('select id, name, ref, address_line1 from properties where company_id = $1', [company.id], db);
  const person = (name: string) => {
    const matches = people.filter(p => normal(p.full_name) === normal(name) || (p.preferred_name && normal(p.preferred_name) === normal(name)));
    return matches.length === 1 ? matches[0].id : null;
  };
  const property = (name: string) => {
    const matches = properties.filter(p => [p.name, p.ref, p.address_line1].some(x => normal(x) === normal(name)));
    return matches.length === 1 ? matches[0].id : null;
  };
  const report = { mode: apply ? 'apply' : 'preview', eligible: {} as Record<string, number>, inserted: {} as Record<string, number>, unresolved: [] as { sheet: string; ref: string; reason: string }[] };
  const eligible = (sheet: string, r: Row, column: string) => {
    const d = date(r[column]);
    if (d < '2026-08-01' || d > through) return false;
    report.eligible[sheet] = (report.eligible[sheet] ?? 0) + 1;
    return true;
  };
  const source = (sheet: string, r: Row) => `${SOURCE}; ${sheet}; ${r.A}. Owner confirmed template labels were stale on 24 October 2026. Retrospectively entered; source occurrence dates preserved.`;
  const insert = async (table: string, values: Record<string, unknown>) => {
    if (!apply) return;
    const cols = Object.keys(values);
    const result = await q(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict (id) do nothing returning id`, Object.values(values), db);
    report.inserted[table] = (report.inserted[table] ?? 0) + result.length;
  };
  const meetings = new Set<string>();
  for (const r of rows(sheets, 'Meetings')) {
    if (!eligible('Meetings', r, 'B')) continue;
    meetings.add(r.A);
    const attendance = rows(sheets, 'Attendance').filter(a => a.A === r.A).map(a => ({
      name: a.D, role: a.E, status: normal(a.F) === 'present' ? 'present' : normal(a.F) === 'apologies' ? 'apologies' : 'absent',
      ...(person(a.D) ? { person_id: person(a.D) } : {}),
    }));
    const chair = person(r.H);
    if (!chair) report.unresolved.push({ sheet: 'Meetings', ref: r.A, reason: 'Chair profile not uniquely matched; source name retained in minutes' });
    await insert('meetings', { id: key('Meetings', r.A), title: `${r.F} [${r.A}]`, company_ids: [company.id], held_on: date(r.B), chair_id: chair,
      agenda: JSON.stringify((r.K ?? '').split('\n').filter(Boolean).map(item => ({ item }))), attendance: JSON.stringify(attendance),
      minutes: `${r.L ?? ''}\n\nSource chair: ${r.H}; location: ${r.G}; start: ${r.C}; duration: ${r.D} minutes.\nSource minutes status: ${r.M}. Source approval identity/date was not supplied; imported as draft for review.\n${source('Meetings', r)}`,
      minutes_status: 'draft', created_by: actorId });
  }
  for (const r of rows(sheets, 'Decisions')) {
    if (!eligible('Decisions', r, 'C')) continue;
    const authoriser = person(r.F);
    if (!authoriser || !meetings.has(r.B)) { report.unresolved.push({ sheet: 'Decisions', ref: r.A, reason: 'Authoriser profile or meeting not matched; no substitute authoriser used' }); continue; }
    await insert('decisions', { id: key('Decisions', r.A), meeting_id: key('Meetings', r.B), company_id: company.id, title: r.E,
      rationale: `Source records this decision as ${r.G}; no separate rationale was supplied.`, evidence: source('Decisions', r), authoriser_id: authoriser, decided_on: date(r.C), created_by: actorId });
  }
  for (const r of rows(sheets, 'Actions')) {
    if (!eligible('Actions', r, 'C')) continue;
    if (!meetings.has(r.B)) { report.unresolved.push({ sheet: 'Actions', ref: r.A, reason: 'Source meeting not in selected period' }); continue; }
    const owner = person(r.E);
    if (!owner) report.unresolved.push({ sheet: 'Actions', ref: r.A, reason: 'Owner not matched; source owner retained in evidence note' });
    const completed = r.H && date(r.H) <= through ? date(r.H) : null;
    await insert('improvement_actions', { id: key('Actions', r.A), company_id: company.id, source_type: 'meeting', source_id: key('Meetings', r.B),
      finding: `Meeting action ${r.A}, raised ${date(r.C)}`, action: r.D, owner_id: owner, due_on: r.F ? date(r.F) : null,
      status: completed ? 'evidence_submitted' : 'open',
      evidence_note: `Source owner: ${r.E}; source status: ${r.G}; completion date: ${completed ?? 'not recorded as completed by cutoff'}. Independent verification was not supplied.\n${source('Actions', r)}`, created_by: actorId });
  }
  for (const r of rows(sheets, 'Maintenance')) {
    if (!eligible('Maintenance', r, 'B')) continue;
    const propertyId = property(r.C);
    if (!propertyId) { report.unresolved.push({ sheet: 'Maintenance', ref: r.A, reason: 'Property not uniquely matched; job not assigned to a guessed property' }); continue; }
    const completed = r.K && date(r.K) <= through ? date(r.K) : null;
    const urgency = normal(r.G);
    if (!['routine', 'urgent', 'emergency'].includes(urgency)) throw new Error(`Unknown priority for ${r.A}`);
    await insert('repairs', { id: key('Maintenance', r.A), company_id: company.id, property_id: propertyId, title: `${r.F} [${r.A}]`, urgency,
      description: `Reported ${date(r.B)} by ${r.H}; area: ${r.D}; category: ${r.E}; source status: ${r.L}; source cost: GBP ${r.M || 'not supplied'} (not a payment).\n${source('Maintenance', r)}`,
      contractor: r.I || null, due_on: r.J ? date(r.J) : null, completed_on: completed, status: completed ? 'awaiting_verification' : 'reported', reported_by: actorId });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [path, actorId] = process.argv.slice(2);
    if (!path || !/^[0-9a-f-]{36}$/i.test(actorId ?? '')) throw new Error('Usage: INPUT.json ACTOR_UUID [--apply]');
    const sheets: Sheet[] = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const apply = process.argv.includes('--apply');
    console.log(JSON.stringify(await tx(db => importValorHistory(db, sheets, actorId, apply)), null, 2));
  } finally { await pool.end(); }
}
