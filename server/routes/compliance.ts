// Selective property compliance (Windrush and other RSL contracts). Monitoring is OFF for every property until an
// administrator with compliance.manage turns it on for that property. Turning it off keeps every requirement and record;
// disabled properties produce no compliance figures or warnings anywhere.
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { type Access, can, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const compliance = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// The checklist used when a property has no framework. Intervals are common defaults; administrators can change each one.
export const DEFAULT_ITEMS = [
  { key: 'fra', name: 'Fire risk assessment', interval_days: 365 },
  { key: 'gas', name: 'Gas safety certificate (CP12)', interval_days: 365 },
  { key: 'eicr', name: 'Electrical installation condition report (EICR)', interval_days: 1825 },
  { key: 'epc', name: 'Energy performance certificate (EPC)', interval_days: 3650 },
  { key: 'legionella', name: 'Legionella risk assessment', interval_days: 730 },
  { key: 'emergency_lighting', name: 'Emergency lighting test', interval_days: 365 },
  { key: 'fire_alarm', name: 'Fire alarm service', interval_days: 182 },
  { key: 'fire_doors', name: 'Fire door inspection', interval_days: 90 },
  { key: 'smoke_co', name: 'Smoke and carbon monoxide alarm test', interval_days: 30 },
  { key: 'hhsrs', name: 'HHSRS assessment', interval_days: 365 },
  { key: 'damp_mould', name: 'Damp and mould inspection', interval_days: 182 },
  { key: 'licensing', name: 'Property licence (HMO / selective)', interval_days: 1825 },
];
const itemSchema = z.object({ key: z.string().regex(/^[a-z0-9_]{2,60}$/), name: text(200).min(2), interval_days: z.coerce.number().int().min(1).max(3660) });

const canView = (a: Access, c: string) => can(a, 'compliance.view', c) || can(a, 'compliance.record', c) || can(a, 'compliance.manage', c);
const viewCompanies = (a: Access, company?: unknown) => scope(a, null, company).filter((c) => canView(a, c));
export const AGENT_LABEL = (p: string) => `coalesce((select ag.name from agent_properties ap join agents ag on ag.id = ap.agent_id where ap.property_id = ${p}.id order by ag.name limit 1), nullif(trim(${p}.managing_agent), ''), 'No managing agent')`;

// Each requirement's current state, from its latest record.
const REQ = `
  select cr.*, ${name('rp')} as responsible_name, last.id as last_record_id, last.completed_on as last_done, last.next_due_on, last.outcome as last_outcome, last.verified_at as last_verified_at,
         case when cr.not_applicable then 'not_applicable' when last.id is null then 'never_done' when last.outcome = 'fail' then 'failed'
              when last.next_due_on < ${LONDON_TODAY} then 'overdue' when last.next_due_on <= ${LONDON_TODAY} + cr.reminder_days then 'due_soon' else 'in_date' end as state
    from compliance_requirements cr left join people rp on rp.id = cr.responsible_id
    left join lateral (select id, completed_on, next_due_on, outcome, verified_at from compliance_records r where r.requirement_id = cr.id order by completed_on desc, created_at desc limit 1) last on true
   where cr.retired_at is null`;
// Per-property counts. Compliant = in date (including due soon). Score = compliant ÷ applicable.
const PROPS = `
  select p.id, p.name, p.ref, p.company_id, c.code as company_code, p.compliance_enabled, p.classification, p.compliance_framework_id, f.name as framework_name, ${AGENT_LABEL('p')} as agent,
         count(s.id) filter (where s.state <> 'not_applicable')::int as applicable,
         count(s.id) filter (where s.state in ('in_date','due_soon'))::int as compliant,
         count(s.id) filter (where s.state = 'overdue')::int as overdue,
         count(s.id) filter (where s.state = 'due_soon')::int as due_soon,
         count(s.id) filter (where s.state = 'failed')::int as failed,
         count(s.id) filter (where s.state = 'never_done')::int as never_done
    from properties p join companies c on c.id = p.company_id left join compliance_frameworks f on f.id = p.compliance_framework_id
    left join (${REQ}) s on s.property_id = p.id
   where p.status <> 'offboarded'`;

compliance.get('/compliance/properties', async (req, res) => {
  const a = req.access;
  const f = parse(z.object({ company: uuid.optional(), agent: text(200).optional(), classification: z.enum(['windrush', 'other_rsl', 'standard', 'none']).optional(), enabled: z.enum(['true', 'false']).optional() }), req.query);
  const cs = viewCompanies(a, f.company);
  // Only administrators see properties where monitoring is off (so they can turn it on).
  const managed = cs.filter((c) => can(a, 'compliance.manage', c));
  const rows = await q(`${PROPS} and p.company_id = any($1::uuid[]) and (p.compliance_enabled or p.company_id = any($2::uuid[]))
      and ($3::text is null or ${AGENT_LABEL('p')} = $3) and ($4::text is null or coalesce(p.classification, 'none') = $4) and ($5::boolean is null or p.compliance_enabled = $5)
      group by p.id, c.code, f.name order by p.compliance_enabled desc, p.ref`, [cs, managed, f.agent ?? null, f.classification ?? null, f.enabled ? f.enabled === 'true' : null]);
  res.json(rows.map((r) => ({ ...r, score: r.compliance_enabled && r.applicable ? Math.round((100 * r.compliant) / r.applicable) : null })));
});

// Dashboard: enabled properties only. Every figure comes from requirement records; "never recorded" is shown as missing data, not as a pass or fail.
compliance.get('/compliance/dashboard', async (req, res) => {
  const a = req.access;
  const f = parse(z.object({ company: uuid.optional(), agent: text(200).optional(), classification: z.enum(['windrush', 'other_rsl', 'standard', 'none']).optional() }), req.query);
  const cs = viewCompanies(a, f.company);
  const args = [cs, f.agent ?? null, f.classification ?? null];
  const filter = `p.compliance_enabled and p.status <> 'offboarded' and p.company_id = any($1::uuid[]) and ($2::text is null or ${AGENT_LABEL('p')} = $2) and ($3::text is null or coalesce(p.classification, 'none') = $3)`;
  const props = await q(`${PROPS} and ${filter} group by p.id, c.code, f.name`, args);
  const items = await one(`select count(*) filter (where s.state = 'overdue')::int as overdue, count(*) filter (where s.state = 'failed')::int as failed, count(*) filter (where s.state = 'never_done')::int as never_done,
        count(*) filter (where s.state in ('in_date','due_soon') and s.next_due_on <= ${LONDON_TODAY} + 30)::int as expiring_30,
        count(*) filter (where s.state in ('in_date','due_soon') and s.next_due_on <= ${LONDON_TODAY} + 60)::int as expiring_60,
        count(*) filter (where s.state in ('in_date','due_soon') and s.next_due_on <= ${LONDON_TODAY} + 90)::int as expiring_90,
        count(*) filter (where s.last_record_id is not null and s.last_verified_at is null and not s.not_applicable)::int as unverified
      from (${REQ}) s join properties p on p.id = s.property_id where ${filter}`, args);
  const actions = await one<{ n: number }>(`select count(*)::int n from improvement_actions x join compliance_records r on r.id = x.source_id join compliance_requirements cr on cr.id = r.requirement_id join properties p on p.id = cr.property_id
      where x.source_type = 'compliance_record' and x.status <> 'closed' and ${filter}`, args);
  const applicable = props.reduce((n, p) => n + p.applicable, 0), compliant = props.reduce((n, p) => n + p.compliant, 0);
  const byAgent = new Map<string, any>();
  for (const p of props) {
    const g = byAgent.get(p.agent) ?? { agent: p.agent, properties: 0, compliant_properties: 0, applicable: 0, compliant: 0, overdue: 0, failed: 0 };
    g.properties++; g.applicable += p.applicable; g.compliant += p.compliant; g.overdue += p.overdue; g.failed += p.failed;
    if (p.applicable && p.compliant === p.applicable) g.compliant_properties++;
    byAgent.set(p.agent, g);
  }
  res.json({
    properties: props.length,
    compliant_properties: props.filter((p) => p.applicable && p.compliant === p.applicable).length,
    ...items, outstanding_actions: actions!.n,
    applicable, compliant, score: applicable ? Math.round((100 * compliant) / applicable) : null,
    by_agent: [...byAgent.values()].map((g) => ({ ...g, score: g.applicable ? Math.round((100 * g.compliant) / g.applicable) : null })).sort((x, y) => x.agent.localeCompare(y.agent)),
  });
});

async function loadProperty(a: Access, id: string) {
  const p = await one('select p.*, c.code as company_code from properties p join companies c on c.id = p.company_id where p.id = $1', [id]);
  if (!p || !canView(a, p.company_id)) throw notFound();
  const manage = can(a, 'compliance.manage', p.company_id);
  if (!p.compliance_enabled && !manage) throw notFound();
  return { p, manage, record: manage || can(a, 'compliance.record', p.company_id) };
}

// Turn monitoring on or off and set the classification / framework. Turning it on for the first time creates the checklist.
async function setCompliance(db: Db, actor: string, p: any, b: { enabled?: boolean; classification?: string | null; framework_id?: string | null }) {
  if (b.framework_id && !(await one('select 1 from compliance_frameworks where id = $1 and company_id = $2', [b.framework_id, p.company_id], db))) throw bad('Choose a framework of this company.');
  const next = { enabled: b.enabled ?? p.compliance_enabled, classification: b.classification === undefined ? p.classification : b.classification, framework: b.framework_id === undefined ? p.compliance_framework_id : b.framework_id };
  await q('update properties set compliance_enabled = $2, classification = $3, compliance_framework_id = $4 where id = $1', [p.id, next.enabled, next.classification, next.framework], db);
  if (next.enabled) {
    const items = next.framework ? (await one<{ items: any[] }>('select items from compliance_frameworks where id = $1', [next.framework], db))!.items : DEFAULT_ITEMS;
    // Adds what is missing; never removes or overwrites existing requirements or records.
    for (const it of items) await q(`insert into compliance_requirements (company_id, property_id, key, name, interval_days, created_by) values ($1,$2,$3,$4,$5,$6) on conflict (property_id, key) do nothing`,
      [p.company_id, p.id, it.key, it.name, it.interval_days, actor], db);
  }
  const changes: Record<string, unknown> = {};
  if (next.enabled !== p.compliance_enabled) changes.enabled = { from: p.compliance_enabled, to: next.enabled };
  if (next.classification !== p.classification) changes.classification = { from: p.classification, to: next.classification };
  if (next.framework !== p.compliance_framework_id) changes.framework_id = { from: p.compliance_framework_id, to: next.framework };
  if (Object.keys(changes).length) await audit(db, actor, p.company_id, 'property_compliance', p.id, next.enabled === p.compliance_enabled ? 'update' : next.enabled ? 'enable' : 'disable', changes);
}
const settingsBody = z.object({ enabled: z.boolean(), classification: z.enum(['windrush', 'other_rsl', 'standard']).nullable(), framework_id: uuid.nullable() }).partial();
compliance.patch('/compliance/properties/:id', async (req, res) => {
  const p = await one('select * from properties where id = $1', [idParam(req.params.id)]);
  if (!p || !canView(req.access, p.company_id)) throw notFound();
  if (!can(req.access, 'compliance.manage', p.company_id)) throw forbidden('Only an administrator can change compliance monitoring.');
  const b = parse(settingsBody.strict(), req.body);
  await tx((db) => setCompliance(db, req.person.id, p, b));
  res.json({ ok: true });
});
compliance.post('/compliance/properties/bulk', async (req, res) => {
  const b = parse(settingsBody.extend({ property_ids: z.array(uuid).min(1).max(500) }).strict(), req.body);
  const { property_ids, ...settings } = b;
  if (!Object.keys(settings).length) throw bad('Nothing to change.');
  const props = await q('select * from properties where id = any($1::uuid[])', [property_ids]);
  if (props.length !== new Set(property_ids).size) throw notFound();
  for (const p of props) if (!can(req.access, 'compliance.manage', p.company_id)) throw forbidden('Only an administrator can change compliance monitoring.');
  await tx(async (db) => { for (const p of props) await setCompliance(db, req.person.id, p, settings); });
  res.json({ updated: props.length });
});

compliance.get('/compliance/properties/:id', async (req, res) => {
  const { p, manage, record } = await loadProperty(req.access, idParam(req.params.id));
  const requirements = await q(`${REQ} and cr.property_id = $1 order by cr.not_applicable, cr.custom, cr.name`, [p.id]);
  res.json({
    property: { id: p.id, name: p.name, ref: p.ref, company_id: p.company_id, company_code: p.company_code, compliance_enabled: p.compliance_enabled, classification: p.classification, compliance_framework_id: p.compliance_framework_id },
    requirements,
    records: await q(`select r.*, ${name('rb')} as recorded_by_name, ${name('vb')} as verified_by_name, f.original_name as evidence_name from compliance_records r join compliance_requirements cr on cr.id = r.requirement_id
                        join people rb on rb.id = r.recorded_by left join people vb on vb.id = r.verified_by left join files f on f.id = r.evidence_file_id where cr.property_id = $1 order by r.completed_on desc, r.created_at desc`, [p.id]),
    actions: await q(`select x.id, x.action, x.status, x.due_on, r.requirement_id from improvement_actions x join compliance_records r on r.id = x.source_id join compliance_requirements cr on cr.id = r.requirement_id
                        where x.source_type = 'compliance_record' and cr.property_id = $1 order by x.created_at desc`, [p.id]),
    history: await q(`select l.at, l.action, l.detail, ${name('pp')} as actor_name from audit_log l left join people pp on pp.id = l.actor_person_id
                        where (l.entity = 'property_compliance' and l.entity_id = $1) or (l.entity in ('compliance_requirement','compliance_record') and l.detail->>'property_id' = $1::text) order by l.at desc limit 100`, [p.id]),
    can: { manage, record: record && p.compliance_enabled },
  });
});

compliance.post('/compliance/properties/:id/requirements', async (req, res) => {
  const { p, manage } = await loadProperty(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const b = parse(z.object({ name: text(200).min(2), interval_days: z.coerce.number().int().min(1).max(3660), notes: text(4000).nullable().optional() }), req.body);
  const key = 'custom_' + b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
  const r = await one(`insert into compliance_requirements (company_id, property_id, key, name, interval_days, notes, custom, created_by) values ($1,$2,$3,$4,$5,$6,true,$7) on conflict (property_id, key) do nothing returning *`,
    [p.company_id, p.id, key, b.name, b.interval_days, b.notes ?? null, req.person.id]);
  if (!r) throw conflict('This property already has a requirement with that name.');
  await audit(pool, req.person.id, p.company_id, 'compliance_requirement', r.id, 'create', { property_id: p.id, name: b.name });
  res.status(201).json(r);
});

async function loadRequirement(a: Access, id: string) {
  const r = await one('select * from compliance_requirements where id = $1 and retired_at is null', [id]);
  if (!r) throw notFound();
  return { r, ...(await loadProperty(a, r.property_id)) };
}
compliance.patch('/compliance/requirements/:id', async (req, res) => {
  const { r, p, manage, record } = await loadRequirement(req.access, idParam(req.params.id));
  const b = parse(z.object({ responsible_id: uuid.nullable(), responsible_text: text(200).nullable(), notes: text(4000).nullable(), interval_days: z.coerce.number().int().min(1).max(3660),
    reminder_days: z.coerce.number().int().min(0).max(365), not_applicable: z.boolean(), na_reason: text(1000).nullable(), retire: z.literal(true) }).partial().strict(), req.body);
  const adminOnly = ['interval_days', 'reminder_days', 'not_applicable', 'na_reason', 'retire'].some((k) => k in b);
  if (adminOnly ? !manage : !record) throw forbidden(adminOnly ? 'Only an administrator can change the schedule or mark an item not applicable.' : undefined);
  if (b.not_applicable && (b.na_reason ?? '').length < 3) throw bad('Give the reason it does not apply.', { fields: { na_reason: 'Required' } });
  if (b.responsible_id && !(await one(`select 1 from appointments where person_id = $1 and company_id = $2`, [b.responsible_id, p.company_id]))) throw bad('Choose someone from this company.');
  const { retire, ...fields } = b;
  const keys = Object.keys(fields);
  await tx(async (db) => {
    if (keys.length) await q(`update compliance_requirements set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [r.id, ...keys.map((k) => (fields as any)[k])], db);
    if (retire) await q('update compliance_requirements set retired_at = now() where id = $1', [r.id], db);
    await audit(db, req.person.id, p.company_id, 'compliance_requirement', r.id, retire ? 'retire' : 'update', { property_id: p.id, ...Object.fromEntries(keys.map((k) => [k, { from: r[k] ?? null, to: (fields as any)[k] }])) });
  });
  res.json({ ok: true });
});

// Recording a completion, with evidence. A fail opens a corrective improvement action that must be verified to close.
compliance.post('/compliance/requirements/:id/records', upload.single('file'), async (req, res) => {
  const { r, p, record } = await loadRequirement(req.access, idParam(req.params.id));
  if (!p.compliance_enabled) throw conflict('Compliance monitoring is off for this property.');
  if (!record) throw forbidden();
  if (r.not_applicable) throw conflict('This item is marked not applicable.');
  const b = parse(z.object({ completed_on: isoDate, next_due_on: isoDate.optional().or(z.literal('').transform(() => undefined)), outcome: z.enum(['pass', 'advisory', 'fail']), done_by_text: text(200).optional(),
    findings: text(4000).optional(), corrective_action: text(2000).optional() }), req.body);
  if (b.outcome !== 'pass' && !b.findings) throw bad('Describe what was found.', { fields: { findings: 'Required' } });
  if (b.outcome === 'fail' && !b.corrective_action) throw bad('Say what must be done to put it right.', { fields: { corrective_action: 'Required' } });
  const d = await one<{ future: boolean; next: string; bad_next: boolean }>(`select $1::date > ${LONDON_TODAY} as future, coalesce($2::date, $1::date + $3::int)::text as next, coalesce($2::date, $1::date) < $1::date as bad_next`, [b.completed_on, b.next_due_on ?? null, r.interval_days]);
  if (d!.future) throw bad('The completion date cannot be in the future.', { fields: { completed_on: 'In the future' } });
  if (d!.bad_next) throw bad('The next due date must be on or after the completion date.', { fields: { next_due_on: 'Check the date' } });
  const out = await tx(async (db) => {
    const rec = await one(`insert into compliance_records (requirement_id, completed_on, next_due_on, outcome, done_by_text, findings, corrective_action, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [r.id, b.completed_on, d!.next, b.outcome, b.done_by_text || null, b.findings || null, b.corrective_action || null, req.person.id], db);
    if (req.file) {
      const f = await saveFile(db, { companyId: p.company_id, entityType: 'compliance', entityId: rec.id, name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id });
      await q('update compliance_records set evidence_file_id = $2 where id = $1', [rec.id, f.id], db);
    }
    let action: any = null;
    if (b.outcome === 'fail') {
      const owner = r.responsible_id ?? p.manager_person_id;
      action = await one(`insert into improvement_actions (company_id, source_type, source_id, finding, action, significance, owner_id, due_on, created_by) values ($1,'compliance_record',$2,$3,$4,'significant',$5, ${LONDON_TODAY} + 14, $6) returning id`,
        [p.company_id, rec.id, `${r.name} failed at ${p.name}: ${b.findings}`, b.corrective_action, owner ?? null, req.person.id], db);
      if (owner) await notify(db, owner, p.company_id, `Compliance failure: ${r.name} at ${p.name}`, `/governance/actions/${action.id}`);
    }
    await audit(db, req.person.id, p.company_id, 'compliance_record', rec.id, 'record', { property_id: p.id, requirement: r.name, outcome: b.outcome });
    return { record: rec, action };
  });
  res.status(201).json(out);
});
compliance.post('/compliance/records/:id/verify', async (req, res) => {
  const rec = await one('select r.*, cr.property_id from compliance_records r join compliance_requirements cr on cr.id = r.requirement_id where r.id = $1', [idParam(req.params.id)]);
  if (!rec) throw notFound();
  const { p, manage } = await loadProperty(req.access, rec.property_id);
  if (!manage) throw forbidden();
  if (rec.recorded_by === req.person.id) throw forbidden('Someone other than the person who recorded it must verify it.');
  if (rec.verified_at) throw conflict('Already verified.');
  await q('update compliance_records set verified_by = $2, verified_at = now() where id = $1', [rec.id, req.person.id]);
  await audit(pool, req.person.id, p.company_id, 'compliance_record', rec.id, 'verify', { property_id: p.id });
  res.json({ ok: true });
});

// Frameworks (reusable checklists).
compliance.get('/compliance/frameworks', async (req, res) => {
  const cs = viewCompanies(req.access, req.query.company);
  res.json({ defaults: DEFAULT_ITEMS, frameworks: await q('select f.*, c.code as company_code from compliance_frameworks f join companies c on c.id = f.company_id where f.company_id = any($1::uuid[]) order by f.name', [cs]) });
});
compliance.post('/compliance/frameworks', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, name: text(200).min(2), description: text(2000).nullable().optional(), items: z.array(itemSchema).min(1).max(60) }), req.body);
  if (!can(req.access, 'compliance.manage', b.company_id)) throw forbidden();
  if (new Set(b.items.map((i) => i.key)).size !== b.items.length) throw bad('Each item needs its own key.');
  const f = await one('insert into compliance_frameworks (company_id, name, description, items, created_by) values ($1,$2,$3,$4,$5) on conflict (company_id, name) do nothing returning *',
    [b.company_id, b.name, b.description ?? null, JSON.stringify(b.items), req.person.id]);
  if (!f) throw conflict('A framework with that name already exists.');
  await audit(pool, req.person.id, b.company_id, 'compliance_framework', f.id, 'create', { name: b.name });
  res.status(201).json(f);
});

