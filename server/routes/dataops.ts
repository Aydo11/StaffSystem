// CSV import (preview → commit, never overwriting), personal-data export, anonymising leavers, retention review.
import { Router } from 'express';
import { z } from 'zod';
import { parseCsv } from '../csv.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, forbidden, idParam, isoDate, LONDON_TODAY, notFound, parse, text, uuid } from '../http.ts';
import { type Access, can, need } from '../perm.ts';
import { deleteFile } from '../storage.ts';

export const dataops = Router();

// ── CSV import ──
const SPECS = {
  people: {
    perms: ['staff.create', 'appointments.manage'],
    fields: { email: true, full_name: true, preferred_name: false, job_title: true, relationship: true, start_date: true, legal_employer_name: false, contracted_hours_per_week: false },
    row: z.object({
      email: z.email(), full_name: text(120).min(2), preferred_name: text(60).optional(), job_title: text(120).min(2),
      relationship: z.enum(['employee', 'contractor', 'agency', 'secondment', 'volunteer', 'other']), start_date: isoDate,
      legal_employer_name: text(200).optional(), contracted_hours_per_week: z.coerce.number().min(0).max(168).optional(),
    }),
  },
  properties: {
    perms: ['properties.manage'],
    fields: { ref: true, name: true, address_line1: true, address_line2: false, city: true, postcode: true, managing_agent: false },
    row: z.object({ ref: text(20).min(2), name: text(120).min(2), address_line1: text(200).min(2), address_line2: text(200).optional(), city: text(80).min(2), postcode: text(10).min(3), managing_agent: text(200).optional() }),
  },
} as const;
const importBody = z.object({ entity: z.enum(['people', 'properties']), company_id: uuid, csv: z.string().min(1).max(2_000_000), mapping: z.record(z.string(), z.string()) });

async function analyse(db: Db, a: Access, body: z.infer<typeof importBody>) {
  const spec = SPECS[body.entity];
  for (const p of spec.perms) need(a, p, body.company_id);
  const rows = parseCsv(body.csv);
  if (rows.length < 2) throw bad('The file needs a header row and at least one data row.');
  if (rows.length > 2001) throw bad('Import up to 2,000 rows at a time.');
  const [header, ...data] = rows;
  for (const [field, required] of Object.entries(spec.fields)) if (required && !body.mapping[field]) throw bad(`Choose which column holds “${field.replace(/_/g, ' ')}”.`);
  const col = (field: string) => header.indexOf(body.mapping[field]);
  const seen = new Set<string>();
  const out: { line: number; data: any; errors: string[]; duplicate: string | null }[] = [];
  for (const [i, r] of data.entries()) {
    const raw = Object.fromEntries(Object.keys(spec.fields).filter((f) => body.mapping[f] && col(f) >= 0).map((f) => [f, r[col(f)]?.trim() || undefined]));
    const parsed = (spec.row as z.ZodType<any>).safeParse(raw);
    const key = body.entity === 'people' ? String(raw.email ?? '').toLowerCase() : String(raw.ref ?? '').toUpperCase();
    let duplicate: string | null = null;
    if (seen.has(key)) duplicate = 'Repeated earlier in this file';
    else if (body.entity === 'people' && (await one('select 1 from people where lower(email) = $1', [key], db))) duplicate = 'Already has a profile — add a role to it instead';
    else if (body.entity === 'properties' && (await one('select 1 from properties where company_id = $1 and upper(ref) = $2', [body.company_id, key], db))) duplicate = 'A property with this reference already exists';
    seen.add(key);
    out.push({ line: i + 2, data: parsed.success ? parsed.data : raw, errors: parsed.success ? [] : parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`), duplicate });
  }
  return { header, rows: out, summary: { total: out.length, valid: out.filter((r) => !r.errors.length && !r.duplicate).length, invalid: out.filter((r) => r.errors.length).length, duplicates: out.filter((r) => !r.errors.length && r.duplicate).length } };
}
dataops.post('/admin/import/preview', async (req, res) => {
  res.json(await analyse(pool, req.access, parse(importBody, req.body)));
});
// Commit re-checks everything; only valid, non-duplicate rows are created, all in one transaction. Existing records are never changed.
dataops.post('/admin/import/commit', async (req, res) => {
  const body = parse(importBody, req.body);
  const result = await tx(async (db) => {
    const r = await analyse(db, req.access, body);
    let created = 0;
    for (const row of r.rows.filter((x) => !x.errors.length && !x.duplicate)) {
      const d: any = row.data;
      if (body.entity === 'people') {
        const ref = (await one<{ ref: string }>(`select 'VWH-' || lpad((coalesce(max(substring(staff_ref from 5)::int), 0) + 1)::text, 4, '0') as ref from people where staff_ref ~ '^VWH-\\d+$'`, [], db))!.ref;
        const p = await one('insert into people (email, full_name, preferred_name, staff_ref, status) values ($1,$2,$3,$4,$5) returning id', [d.email, d.full_name, d.preferred_name ?? null, ref, 'invited'], db);
        await q(`insert into appointments (person_id, company_id, relationship, legal_employer_company_id, legal_employer_name, job_title, start_date, contracted_hours_per_week)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`, [p.id, body.company_id, d.relationship, d.legal_employer_name ? null : body.company_id, d.legal_employer_name ?? null, d.job_title, d.start_date, d.contracted_hours_per_week ?? null], db);
      } else {
        await q('insert into properties (company_id, ref, name, address_line1, address_line2, city, postcode, managing_agent) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [body.company_id, d.ref, d.name, d.address_line1, d.address_line2 ?? null, d.city, d.postcode, d.managing_agent ?? null], db);
      }
      created++;
    }
    await audit(db, req.person.id, body.company_id, 'import', null, body.entity, { created, ...r.summary });
    return { created, skipped_duplicates: r.summary.duplicates, invalid: r.summary.invalid };
  });
  res.json(result);
});

// ── Personal data export (subject access) ──
async function canSeeRestricted(a: Access, personId: string) {
  if (personId === a.personId) return true;
  const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [personId])).map((r) => r.company_id);
  return cos.some((c) => can(a, 'staff.restricted', c));
}
dataops.get('/people/:id/export', async (req, res) => {
  const id = idParam(req.params.id);
  if (!(await canSeeRestricted(req.access, id))) throw notFound();
  const get = (sql: string) => q(sql, [id]);
  const data = {
    exported_at: new Date().toISOString(),
    note: 'Personal data held about you in the Valor & Wellbeing Hub. Records about other people and confidential case notes written by handlers are not included.',
    profile: (await one('select id, email, full_name, preferred_name, staff_ref, professional_summary, work_phone, skills, languages, work_history, development_goals, status, created_at from people where id = $1', [id])),
    personal_details: await get('select personal_phone, personal_email, home_address, emergency_contact_name, emergency_contact_phone from person_restricted where person_id = $1'),
    appointments: await get('select a.*, c.name as company from appointments a join companies c on c.id = a.company_id where a.person_id = $1'),
    rates: await get('select r.* from appointment_rates r join appointments a on a.id = r.appointment_id where a.person_id = $1'),
    qualifications: await get('select * from qualifications where person_id = $1'),
    clearance_decisions: await get('select status, restrictions, evidence_summary, decided_at, review_date from clearance_decisions where person_id = $1'),
    employment_checks: await get('select check_type, label, status, requested_on, issued_on, verified_on, follow_up_on, next_review_on from employment_checks where person_id = $1'),
    visits: await get('select started_at, ended_at, status, entry_mode, work_category, summary from visits where person_id = $1 order by started_at'),
    time_entries: await get('select work_date, category, minutes, note, status from time_entries where person_id = $1'),
    timesheets: await get('select period_start, period_end, status, submitted_minutes, approved_minutes, cost_estimate from timesheets where person_id = $1'),
    reviews: await get(`select kind, period_start, period_end, objectives, achievements, development, feedback, staff_response, acknowledged_at from reviews where person_id = $1 and status = 'published'`),
    supervisions: await get(`select kind, held_on, minutes, agenda, shared_notes, support_agreed, staff_reflection from supervisions where person_id = $1 and status = 'completed'`),
    training: await get('select title, source, completed_on, provider, verified_at from training_records where person_id = $1'),
    policy_receipts: await get('select p.title, p.version, r.supplied_at, r.opened_at, r.acknowledged_at, r.explained_at from policy_receipts r join policies p on p.id = r.policy_id where r.person_id = $1'),
    recognition: await get(`select category, note, created_at from recognitions where person_id = $1 and status = 'approved'`),
    cases_raised_or_about_you: await get(`select kind, status, summary, outcome, employee_response, appeal, created_at from cases where raised_by = $1 or subject_person_id = $1`),
    finance_documents: await get(`select kind, number, issue_date, total, status from finance_documents where recipient_person_id = $1 or submitted_by = $1`),
    messages_written: await get('select body, created_at from messages where author_id = $1'),
    notifications: await get('select title, created_at, read_at from notifications where person_id = $1'),
    email_preferences: await get('select email_enabled, categories from messaging_preferences where person_id = $1'),
  };
  await audit(pool, req.person.id, null, 'person', id, 'data_export', {});
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="hub-personal-data-${data.profile?.staff_ref ?? 'export'}.json"`, 'Cache-Control': 'no-store' }).send(JSON.stringify(data, null, 2));
});

// ── Anonymising a leaver ──
// Business records (visits, timesheets, finance, audit) stay, linked by id; the identifying details are removed.
dataops.post('/people/:id/anonymise', async (req, res) => {
  if (!req.access.superAdmin) throw forbidden('Only a super administrator can anonymise a person.');
  const id = idParam(req.params.id);
  const { confirm_name } = parse(z.object({ confirm_name: text(120) }), req.body);
  const p = await one('select * from people where id = $1', [id]);
  if (!p) throw notFound();
  if (p.status !== 'left') throw bad('Only people who have left can be anonymised.');
  if (confirm_name !== p.full_name) throw bad('Type the person’s full name exactly to confirm.', { fields: { confirm_name: 'Does not match' } });
  if (await one(`select 1 from appointments a where a.person_id = $1 and (a.end_date is null or a.end_date >= ${LONDON_TODAY})`, [id])) throw bad('This person still has a current role.');
  const photoPath = await tx(async (db) => {
    const path = p.photo_path ? await deleteFile(db, p.photo_path) : null;
    await q(`update people set full_name = 'Former staff member ' || staff_ref, preferred_name = null, email = 'removed+' || id || '@invalid', work_phone = null, professional_summary = null,
               skills = '{}', languages = '{}', work_history = '[]', development_goals = null, photo_path = null, password_hash = null, totp_secret = null, totp_enabled_at = null, updated_at = now() where id = $1`, [id], db);
    for (const t of ['person_restricted', 'messaging_preferences', 'sessions', 'auth_tokens']) await q(`delete from ${t} where person_id = $1`, [id], db);
    await q('delete from qualifications where person_id = $1', [id], db);
    await audit(db, req.person.id, null, 'person', id, 'anonymise', { staff_ref: p.staff_ref });
    return path;
  });
  res.json({ ok: true });
});

// ── Retention review: what is past the organisation's retention period (nothing is deleted automatically) ──
dataops.get('/admin/retention', async (req, res) => {
  if (!req.access.superAdmin) throw forbidden();
  const years = parse(z.coerce.number().int().min(1).max(20).default(6), req.query.years ?? 6);
  res.json({
    years,
    leavers: await q(`select p.id, p.full_name, p.staff_ref, max(a.end_date)::text as left_on from people p join appointments a on a.person_id = p.id
                       where p.status = 'left' and p.email not like 'removed+%' group by p.id having max(a.end_date) < ${LONDON_TODAY} - make_interval(years => $1) order by left_on`, [years]),
    counts: (await one(`select (select count(*) from notifications where created_at < now() - interval '1 year')::int as old_notifications,
                               (select count(*) from outbound_messages where created_at < now() - interval '1 year')::int as old_outbound,
                               (select count(*) from audit_log where at < now() - make_interval(years => $1))::int as old_audit`, [years])),
  });
});
