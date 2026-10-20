import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { clearanceGate, currentClearance } from '../clearance.ts';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, HttpError, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid, idParam } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need } from '../perm.ts';
import { deleteFile, readFile, saveFile } from '../storage.ts';
import { issueAccessLink, sendAccessEmail } from './account.ts';
import { personVisible } from '../visibility.ts';

export const people = Router();
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

async function visiblePerson(a: Access, id: string) {
  const p = await one(`select p.* from people p where p.id = $1 and ${personVisible('p', 2, 3)}`, [id, a.personId, companiesWith(a, 'staff.view')]);
  if (!p) throw notFound();
  // Sign-in secrets never leave the server; only whether they are set.
  const { password_hash, totp_secret, totp_last_step: _s, failed_logins: _f, locked_until: _l, ...safe } = p;
  return { ...safe, has_password: !!password_hash, mfa_enabled: !!p.totp_enabled_at };
}
// Companies where this person holds (or held) an appointment and the viewer has `perm`.
async function sharedCompanies(a: Access, personId: string, perm: string) {
  const rows = await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [personId]);
  return rows.map((r) => r.company_id).filter((c) => can(a, perm, c));
}
async function needOnPerson(a: Access, personId: string, perm: string) {
  const cs = await sharedCompanies(a, personId, perm);
  if (!cs.length) throw forbidden();
  return cs;
}

people.get('/people', async (req, res) => {
  const a = req.access;
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const term = req.query.q ? `%${parse(text(80), req.query.q)}%` : null;
  const rows = await q(`
    select p.id, p.full_name, p.preferred_name, p.staff_ref, p.status, p.photo_path is not null as has_photo,
           coalesce(json_agg(json_build_object('appointment_id', ap.id, 'company_id', c.id, 'company_code', c.code, 'company_name', c.name, 'job_title', ap.job_title, 'status', ap.status, 'end_date', ap.end_date))
                    filter (where ap.id is not null), '[]') as appointments
      from people p
      left join appointments ap on ap.person_id = p.id and ap.company_id = any($2::uuid[]) and (ap.end_date is null or ap.end_date >= ${LONDON_TODAY} - 365)
      left join companies c on c.id = ap.company_id
     where ${personVisible('p', 1, 2)}
       and ($3::uuid is null or exists (select 1 from appointments x where x.person_id = p.id and x.company_id = $3))
       and ($4::text is null or p.full_name ilike $4 or p.preferred_name ilike $4 or p.staff_ref ilike $4)
     group by p.id order by p.full_name`, [a.personId, companiesWith(a, 'staff.view'), company, term]);
  res.json(rows);
});

people.get('/people/:id', async (req, res) => {
  const a = req.access;
  const id = idParam(req.params.id);
  const p = await visiblePerson(a, id);
  const self = id === a.personId;
  const apptCos = [...new Set([...companiesWith(a, 'staff.view'), ...companiesWith(a, 'appointments.view')])];
  const appointments = await q(`
    select ap.*, c.name as company_name, c.code as company_code, ${name('m')} as manager_name, le.name as legal_employer_company_name,
           (${ACTIVE_APPT('ap')}) as is_current,
           coalesce((select json_agg(json_build_object('id', x.id, 'property_id', pr.id, 'name', pr.name, 'ref', pr.ref, 'from_date', x.from_date, 'to_date', x.to_date) order by x.from_date)
                       from appointment_properties x join properties pr on pr.id = x.property_id where x.appointment_id = ap.id), '[]') as properties
      from appointments ap join companies c on c.id = ap.company_id left join people m on m.id = ap.manager_person_id left join companies le on le.id = ap.legal_employer_company_id
     where ap.person_id = $1 and ($2 or ap.company_id = any($3::uuid[])) order by ap.start_date desc`, [id, self, apptCos]);
  for (const ap of appointments) {
    // Rates are restricted: shown to the person themself or to holders of rates.view in that company.
    ap.rates = self || can(a, 'rates.view', ap.company_id)
      ? await q('select id, rate_type, amount, effective_from, effective_to, created_at from appointment_rates where appointment_id = $1 order by effective_from desc', [ap.id])
      : null;
  }
  const restrictedCos = await sharedCompanies(a, id, 'staff.restricted');
  const clearanceCos = self ? appointments.map((x) => x.company_id) : await sharedCompanies(a, id, 'clearance.view');
  const checkCos = await sharedCompanies(a, id, 'checks.view');
  const editCos = await sharedCompanies(a, id, 'staff.edit');
  // Sensitive access is audited: someone else viewing restricted personal details or employment checks.
  if (!self && (restrictedCos.length || checkCos.length)) await audit(pool, a.personId, null, 'person_restricted', id, 'view', { personal: restrictedCos.length > 0, checks: checkCos.length > 0 });
  res.json({
    person: { ...p, has_photo: !!p.photo_path, photo_path: undefined },
    appointments,
    qualifications: await q(`select qf.*, ${name('v')} as verified_by_name from qualifications qf left join people v on v.id = qf.verified_by where qf.person_id = $1 order by awarded_on desc nulls last`, [id]),
    restricted: self || restrictedCos.length ? (await one('select * from person_restricted where person_id = $1', [id])) ?? {} : null,
    clearance: clearanceCos.length ? await currentClearance(pool, id, clearanceCos) : null,
    checks: checkCos.length ? await q(`select e.*, c.name as company_name, c.code as company_code, ${name('r')} as reviewer_name from employment_checks e join companies c on c.id = e.company_id left join people r on r.id = e.reviewer_id where e.person_id = $1 and e.company_id = any($2::uuid[]) order by e.check_type`, [id, checkCos]) : null,
    documents: self || editCos.length ? await q(PERSON_DOCS, [id]) : null,
    changeRequests: self || editCos.length ? await q('select * from profile_change_requests where person_id = $1 order by requested_at desc limit 20', [id]) : [],
    can: {
      edit: editCos.length > 0,
      editRestricted: restrictedCos.length > 0,
      verify: editCos.length > 0 && !self,
      decideClearance: (await sharedCompanies(a, id, 'clearance.decide')).filter(() => !self),
      manageChecks: await sharedCompanies(a, id, 'checks.manage'),
      manageAppointments: companiesWith(a, 'appointments.manage'),
      manageRates: companiesWith(a, 'rates.manage'),
    },
  });
});

// Professional profile / resume: only the safe, professional fields. No salary, DBS, address, grievances or private feedback.
people.get('/people/:id/resume', async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visiblePerson(req.access, id);
  res.json({
    person: { id: p.id, full_name: p.full_name, preferred_name: p.preferred_name, staff_ref: p.staff_ref, professional_summary: p.professional_summary, work_phone: p.work_phone, email: p.email, skills: p.skills, languages: p.languages, work_history: p.work_history, development_goals: p.development_goals, has_photo: !!p.photo_path },
    appointments: await q(`select c.name as company_name, c.code as company_code, ap.job_title, ap.relationship, ap.start_date, ap.end_date, (${ACTIVE_APPT('ap')}) as is_current
                             from appointments ap join companies c on c.id = ap.company_id where ap.person_id = $1 order by ap.start_date desc`, [id]),
    qualifications: await q('select title, issuer, awarded_on, verified_at is not null as verified from qualifications where person_id = $1 order by awarded_on desc nulls last', [id]),
  });
});

const apptFields = {
  relationship: z.enum(['employee', 'contractor', 'agency', 'secondment', 'volunteer', 'other']),
  legal_employer_company_id: uuid.nullable().optional(),
  legal_employer_name: text(200).nullable().optional(),
  job_title: text(120).min(2),
  responsibilities: text(2000).nullable().optional(),
  manager_person_id: uuid.nullable().optional(),
  start_date: isoDate,
  end_date: isoDate.nullable().optional(),
  contracted_hours_per_week: z.coerce.number().min(0).max(168).nullable().optional(),
  status: z.enum(['planned', 'active', 'suspended']).default('active'),
};

async function insertAppointment(db: any, personId: string, companyId: string, b: any, actor: string) {
  if (!b.legal_employer_company_id && !b.legal_employer_name) throw bad('Say who the legal employer or contracting entity is.', { fields: { legal_employer_name: 'Required' } });
  const ap = await one(`insert into appointments (person_id, company_id, relationship, legal_employer_company_id, legal_employer_name, job_title, responsibilities, manager_person_id, start_date, end_date, contracted_hours_per_week, status)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [personId, companyId, b.relationship, b.legal_employer_company_id ?? null, b.legal_employer_name ?? null, b.job_title, b.responsibilities ?? null, b.manager_person_id ?? null, b.start_date, b.end_date ?? null, b.contracted_hours_per_week ?? null, b.status], db);
  await audit(db, actor, companyId, 'appointment', ap.id, 'create', { person_id: personId, job_title: b.job_title });
  return ap;
}

// Invite a new person with their first appointment (a profile with no appointment would be invisible to everyone but super admins).
people.post('/people', async (req, res) => {
  const b = parse(z.object({ email: z.email(), full_name: text(120).min(2), preferred_name: text(60).optional(), company_id: uuid, ...apptFields }), req.body);
  need(req.access, 'staff.create', b.company_id);
  need(req.access, 'appointments.manage', b.company_id);
  const existing = await one('select id from people where lower(email) = lower($1)', [b.email]);
  if (existing) throw conflict('Someone with this email already has a profile. Add an appointment to their existing profile instead of creating a second one.');
  const { link, ...result } = await tx(async (db) => {
    const ref = (await one<{ ref: string }>(`select 'VWH-' || lpad((coalesce(max(substring(staff_ref from 5)::int), 0) + 1)::text, 4, '0') as ref from people where staff_ref ~ '^VWH-\\d+$'`, [], db))!.ref;
    const p = await one('insert into people (email, full_name, preferred_name, staff_ref, status) values ($1,$2,$3,$4,$5) returning id, staff_ref', [b.email, b.full_name, b.preferred_name ?? null, ref, 'invited'], db);
    await insertAppointment(db, p.id, b.company_id, b, req.person.id);
    await audit(db, req.person.id, b.company_id, 'person', p.id, 'invite', {});
    return { ...p, link: await issueAccessLink(db, p.id, 'invite') };
  });
  // The link is also returned so the admin can pass it on when email is not set up.
  res.status(201).json({ ...result, invitation: await sendAccessEmail(b.email, link, 'invite'), invite_link: (process.env.APP_URL ?? 'http://localhost:5173') + link });
});

const centralFields = z.object({
  full_name: text(120).min(2).optional(),
  preferred_name: text(60).nullable().optional(),
  professional_summary: text(2000).nullable().optional(),
  work_phone: text(40).nullable().optional(),
  skills: z.array(text(60)).max(40).optional(),
  languages: z.array(text(40)).max(20).optional(),
  work_history: z.array(z.object({ role: text(120), organisation: text(120), from: text(20).optional(), to: text(20).optional(), summary: text(500).optional() })).max(30).optional(),
  development_goals: text(2000).nullable().optional(),
}).strict();

people.patch('/people/:id', async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  await needOnPerson(req.access, id, 'staff.edit');
  const b = parse(centralFields, req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  const row = await one(`update people set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning id`,
    [id, ...keys.map((k) => (k === 'work_history' ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
  await audit(pool, req.person.id, null, 'person', id, 'update', { fields: keys });
  res.json(row);
});

people.put('/people/:id/restricted', async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  await needOnPerson(req.access, id, 'staff.restricted');
  const b = parse(z.object({ personal_phone: text(40).nullable(), personal_email: z.email().nullable().or(z.literal('').transform(() => null)), home_address: text(300).nullable(), emergency_contact_name: text(120).nullable(), emergency_contact_phone: text(40).nullable() }).partial(), req.body);
  await q(`insert into person_restricted (person_id, personal_phone, personal_email, home_address, emergency_contact_name, emergency_contact_phone, updated_at) values ($1,$2,$3,$4,$5,$6, now())
           on conflict (person_id) do update set personal_phone = excluded.personal_phone, personal_email = excluded.personal_email, home_address = excluded.home_address,
             emergency_contact_name = excluded.emergency_contact_name, emergency_contact_phone = excluded.emergency_contact_phone, updated_at = now()`,
    [id, b.personal_phone ?? null, b.personal_email ?? null, b.home_address ?? null, b.emergency_contact_name ?? null, b.emergency_contact_phone ?? null]);
  await audit(pool, req.person.id, null, 'person_restricted', id, 'update', { fields: Object.keys(b) }); // field names only, never values
  res.json({ ok: true });
});

// ── Photo ──
async function canEditPhoto(a: Access, id: string) {
  if (id !== a.personId) await needOnPerson(a, id, 'staff.edit');
}
people.post('/people/:id/photo', upload.single('file'), async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  await canEditPhoto(req.access, id);
  if (!req.file) throw bad('Choose a photo to upload.');
  const f = await tx(async (db) => {
    const old = await one<{ photo_path: string | null }>('select photo_path from people where id = $1 for update', [id], db);
    const saved = await saveFile(db, { companyId: null, entityType: 'person_photo', entityId: id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true });
    await q('update people set photo_path = $2, updated_at = now() where id = $1', [id, saved.id], db);
    const oldPath = old?.photo_path ? await deleteFile(db, old.photo_path) : null;
    await audit(db, req.person.id, null, 'person', id, 'photo_replace', {});
    return { ...saved, oldPath };
  });
  res.status(201).json({ id: f.id });
});
people.delete('/people/:id/photo', async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  await canEditPhoto(req.access, id);
  const oldPath = await tx(async (db) => {
    const old = await one<{ photo_path: string | null }>('select photo_path from people where id = $1 for update', [id], db);
    await q('update people set photo_path = null, updated_at = now() where id = $1', [id], db);
    const path = old?.photo_path ? await deleteFile(db, old.photo_path) : null;
    await audit(db, req.person.id, null, 'person', id, 'photo_remove', {});
    return path;
  });
  res.json({ ok: true });
});
people.get('/people/:id/photo', async (req, res) => {
  const id = idParam(req.params.id);
  const p = await visiblePerson(req.access, id);
  if (!p.photo_path) throw notFound();
  const f = await one<{ storage_path: string; mime_type: string }>('select storage_path, mime_type from files where id = $1', [p.photo_path]);
  if (!f) throw notFound();
  res.set({ 'Content-Type': f.mime_type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(await readFile(f.storage_path));
});

// ── Documents (CVs, certificates, references): the person themself and anyone who can edit their profile ──
async function canSeeDocs(a: Access, id: string) {
  return id === a.personId || (await sharedCompanies(a, id, 'staff.edit')).length > 0;
}
const PERSON_DOCS = `select f.id, f.original_name, f.mime_type, f.size_bytes, f.uploaded_at, f.uploaded_by, coalesce(u.preferred_name, u.full_name) as uploaded_by_name
  from files f join people u on u.id = f.uploaded_by where f.entity_type = 'person_doc' and f.entity_id = $1 order by f.uploaded_at desc`;
people.post('/people/:id/documents', upload.single('file'), async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  if (!(await canSeeDocs(req.access, id))) throw forbidden();
  if (!req.file) throw bad('Choose a document to upload.');
  const f = await tx(async (db) => {
    const saved = await saveFile(db, { companyId: null, entityType: 'person_doc', entityId: id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, allowWord: true });
    await audit(db, req.person.id, null, 'person', id, 'document_add', { file_id: saved.id, name: saved.original_name });
    return saved;
  });
  res.status(201).json({ ...f, storage_path: undefined });
});
people.delete('/people/:id/documents/:fileId', async (req, res) => {
  const id = idParam(req.params.id);
  const fileId = idParam(req.params.fileId);
  await visiblePerson(req.access, id);
  const f = await one('select * from files where id = $1 and entity_type = $2 and entity_id = $3', [fileId, 'person_doc', id]);
  if (!f) throw notFound();
  // Uploaders may remove their own; otherwise only profile editors (not the person on someone else's upload).
  if (f.uploaded_by !== req.person.id && !(await sharedCompanies(req.access, id, 'staff.edit')).length) throw forbidden();
  await tx(async (db) => { await deleteFile(db, f.id); await audit(db, req.person.id, null, 'person', id, 'document_remove', { file_id: f.id, name: f.original_name }); });
  res.json({ ok: true });
});

// ── Overview at the top of a profile: availability, usual hours and the CPD roadmap ──
// Core learning everyone in supported housing is expected to hold, in roadmap order. A training record counts towards a step
// when its title contains one of the step's words; it is ticked once it is evidenced (a passed Hub course or a verified certificate).
// shortcut: matching is by title words, so a record must be named sensibly; link records to steps if titles prove unreliable.
export const CPD_STEPS = [
  { key: 'safeguarding', title: 'Safeguarding adults', words: ['safeguard'] },
  { key: 'health_safety', title: 'Health and safety', words: ['health and safety', 'health & safety'] },
  { key: 'first_aid', title: 'First aid', words: ['first aid'] },
  { key: 'fire_safety', title: 'Fire safety', words: ['fire'] },
  { key: 'data_protection', title: 'Data protection (GDPR)', words: ['gdpr', 'data protection'] },
  { key: 'mental_health', title: 'Mental health awareness', words: ['mental health'] },
  { key: 'equality', title: 'Equality, diversity and inclusion', words: ['equality', 'diversity'] },
  { key: 'lone_working', title: 'Lone working', words: ['lone work'] },
  { key: 'infection', title: 'Infection prevention and control', words: ['infection'] },
  { key: 'substances', title: 'Drug and alcohol awareness', words: ['drug', 'alcohol', 'substance'] },
] as const;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:00');
const workingHours = z.object(Object.fromEntries(DAYS.map((d) => [d, z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, 'The finish must be after the start').optional()])) as Record<(typeof DAYS)[number], any>).strict();

export function cpdRoadmap(records: { id: string; title: string; source: string; completed_on: string; certificate_file_id: string | null; verified_at: string | null }[]) {
  const done = (r: (typeof records)[number]) => r.source === 'course' || !!r.verified_at;
  const used = new Set<string>();
  const steps = CPD_STEPS.map((s) => {
    const hits = records.filter((r) => s.words.some((w) => r.title.toLowerCase().includes(w)));
    const r = hits.find(done) ?? hits[0]; // records arrive newest first
    if (r) used.add(r.id);
    return { key: s.key, title: s.title, status: !r ? 'todo' : done(r) ? 'done' : 'awaiting', record: r ?? null };
  });
  return { steps, other: records.filter((r) => done(r) && !used.has(r.id)) };
}

people.get('/people/:id/overview', async (req, res) => {
  const a = req.access;
  const id = idParam(req.params.id);
  const p = await visiblePerson(a, id);
  const self = id === a.personId;
  const now = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const day = now.weekday.toLowerCase().slice(0, 3) as (typeof DAYS)[number];
  const today: [string, string] | undefined = p.working_hours?.[day];
  // Leave shows only as "away" with dates: the kind of leave (sickness, for example) is not shared.
  const [awayNow, upcoming, onVisit] = await Promise.all([
    one<{ end_date: string }>(`select end_date from leave_requests where person_id = $1 and status = 'approved' and ${LONDON_TODAY} between start_date and end_date order by end_date desc limit 1`, [id]),
    q(`select start_date, end_date from leave_requests where person_id = $1 and status = 'approved' and start_date > ${LONDON_TODAY} order by start_date limit 5`, [id]),
    one(`select 1 from visits where person_id = $1 and status = 'in_progress'`, [id]),
  ]);
  const time = `${now.hour}:${now.minute}`;
  const status = awayNow ? 'away' : onVisit ? 'on_visit' : today && time >= today[0] && time < today[1] ? 'available' : 'off';
  const trainingCos = await sharedCompanies(a, id, 'training.view_all');
  const cpd = self || trainingCos.length
    ? cpdRoadmap(await q('select id, title, source, completed_on, certificate_file_id, verified_at from training_records where person_id = $1 order by completed_on desc, created_at desc', [id]))
    : null;
  res.json({
    availability: { status, away_until: awayNow?.end_date ?? null, today: today ?? null, day },
    working_hours: p.working_hours ?? {}, upcoming_leave: upcoming, cpd,
    can: { editHours: self || (await sharedCompanies(a, id, 'staff.edit')).length > 0, addEvidence: self, verify: !self && (await sharedCompanies(a, id, 'training.manage')).length > 0 },
  });
});

people.put('/people/:id/working-hours', async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  if (id !== req.access.personId) await needOnPerson(req.access, id, 'staff.edit');
  const b = parse(workingHours, req.body);
  await q('update people set working_hours = $2, updated_at = now() where id = $1', [id, JSON.stringify(b)]);
  await audit(pool, req.person.id, null, 'person', id, 'working_hours', b);
  res.json({ working_hours: b });
});

// ── Proposed profile changes (staff propose; HR verifies) ──
const proposable = z.object({
  field: z.enum(['preferred_name', 'professional_summary', 'work_phone', 'skills', 'languages', 'development_goals']),
  value: z.union([text(2000), z.array(text(60)).max(40)]),
});
people.post('/me/change-requests', async (req, res) => {
  const b = parse(proposable, req.body);
  const isList = b.field === 'skills' || b.field === 'languages';
  if (isList !== Array.isArray(b.value)) throw bad(isList ? 'Give a list.' : 'Give text.');
  const row = await one('insert into profile_change_requests (person_id, field, proposed_value) values ($1,$2,$3) returning *', [req.person.id, b.field, JSON.stringify(b.value)]);
  res.status(201).json(row);
});
people.post('/change-requests/:id/decide', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ approve: z.boolean(), note: text(500).optional() }), req.body);
  const r = await one('select * from profile_change_requests where id = $1', [id]);
  if (!r) throw notFound();
  if (r.person_id === req.person.id) throw forbidden('You cannot verify your own changes.');
  await needOnPerson(req.access, r.person_id, 'staff.edit');
  await tx(async (db) => {
    const done = await one(`update profile_change_requests set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1 and status = 'pending' returning id`, [id, b.approve ? 'approved' : 'rejected', req.person.id, b.note ?? null], db);
    if (!done) throw conflict('This request has already been decided.');
    if (b.approve) {
      const v = r.proposed_value;
      await q(`update people set ${r.field} = $2, updated_at = now() where id = $1`, [r.person_id, v], db); // field is constrained by a CHECK to a fixed list
    }
    await audit(db, req.person.id, null, 'profile_change_request', id, b.approve ? 'approve' : 'reject', { field: r.field });
    await notify(db, r.person_id, null, `Your profile change (${r.field.replace('_', ' ')}) was ${b.approve ? 'approved' : 'not approved'}`, '/profile', b.note);
  });
  res.json({ ok: true });
});

// ── Qualifications ──
people.post('/people/:id/qualifications', async (req, res) => {
  const id = idParam(req.params.id);
  await visiblePerson(req.access, id);
  if (id !== req.person.id) await needOnPerson(req.access, id, 'staff.edit');
  const b = parse(z.object({ title: text(200).min(2), issuer: text(200).nullable().optional(), awarded_on: isoDate.nullable().optional() }), req.body);
  res.status(201).json(await one('insert into qualifications (person_id, title, issuer, awarded_on) values ($1,$2,$3,$4) returning *', [id, b.title, b.issuer ?? null, b.awarded_on ?? null]));
});
people.post('/qualifications/:id/verify', async (req, res) => {
  const id = idParam(req.params.id);
  const qf = await one('select * from qualifications where id = $1', [id]);
  if (!qf) throw notFound();
  if (qf.person_id === req.person.id) throw forbidden('You cannot verify your own qualification.');
  await needOnPerson(req.access, qf.person_id, 'staff.edit');
  await q('update qualifications set verified_by = $2, verified_at = now() where id = $1', [id, req.person.id]);
  await audit(pool, req.person.id, null, 'qualification', id, 'verify', {});
  res.json({ ok: true });
});

// ── Appointments ──
people.post('/appointments', async (req, res) => {
  const b = parse(z.object({ person_id: uuid.optional(), person_email: z.email().optional(), company_id: uuid, ...apptFields }), req.body);
  need(req.access, 'appointments.manage', b.company_id);
  const p = b.person_id ? await one('select id from people where id = $1', [b.person_id]) : b.person_email ? await one('select id from people where lower(email) = lower($1)', [b.person_email]) : null;
  if (!p) throw bad('Choose an existing person, by profile or by email.', { fields: { person_email: 'No profile with this email' } });
  const ap = await tx((db) => insertAppointment(db, p.id, b.company_id, b, req.person.id));
  await notify(pool, p.id, b.company_id, `New appointment: ${b.job_title}`, '/profile');
  res.status(201).json(ap);
});

async function loadAppointment(a: Access, id: string, perm: string) {
  const ap = await one('select * from appointments where id = $1', [id]);
  if (!ap || !a.perms.has(ap.company_id)) throw notFound();
  need(a, perm, ap.company_id);
  return ap;
}

people.patch('/appointments/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const ap = await loadAppointment(req.access, id, 'appointments.manage');
  if (ap.status === 'ended') throw conflict('This appointment has ended. Create a new appointment instead of changing history.');
  const b = parse(z.object({ job_title: apptFields.job_title, responsibilities: apptFields.responsibilities, manager_person_id: apptFields.manager_person_id, contracted_hours_per_week: apptFields.contracted_hours_per_week, status: z.enum(['planned', 'active', 'suspended']), legal_employer_company_id: apptFields.legal_employer_company_id, legal_employer_name: apptFields.legal_employer_name, relationship: apptFields.relationship }).partial().strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  const row = await tx(async (db) => {
    const r = await one(`update appointments set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [id, ...keys.map((k) => (b as any)[k])], db);
    // History: the audit log keeps the before/after values of every appointment change.
    await audit(db, req.person.id, ap.company_id, 'appointment', id, 'update', { before: Object.fromEntries(keys.map((k) => [k, ap[k]])), after: b });
    return r;
  });
  res.json(row);
});

people.post('/appointments/:id/end', async (req, res) => {
  const id = idParam(req.params.id);
  const ap = await loadAppointment(req.access, id, 'appointments.manage');
  const b = parse(z.object({ end_date: isoDate, reason: text(500).min(3), transfer_to: uuid.optional() }), req.body);
  if (ap.status === 'ended') throw conflict('This appointment has already ended.');
  if (b.end_date < ap.start_date) throw bad('End date cannot be before the start date.', { fields: { end_date: 'Before start date' } });
  const result = await tx(async (db) => {
    const openTasks = (await one<{ n: number }>(`select count(*) n from tasks where company_id = $1 and status <> 'completed' and (owner_id = $2 or reviewer_id = $2)`, [ap.company_id, ap.person_id], db))!.n;
    if (openTasks && !b.transfer_to) throw new HttpError(409, 'transfer_required', `${openTasks} open task(s) in this company must be transferred before the appointment ends.`, { openTasks });
    if (b.transfer_to) {
      const ok = await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and a.id <> $3 and ${ACTIVE_APPT('a')}`, [b.transfer_to, ap.company_id, id], db);
      if (!ok || b.transfer_to === ap.person_id) throw bad('Transfer to someone else with a current appointment in this company.', { fields: { transfer_to: 'Not eligible' } });
      await q(`update tasks set owner_id = case when owner_id = $2 then $3 else owner_id end, reviewer_id = case when reviewer_id = $2 then $3 else reviewer_id end, updated_at = now()
                where company_id = $1 and status <> 'completed' and (owner_id = $2 or reviewer_id = $2)`, [ap.company_id, ap.person_id, b.transfer_to], db);
    }
    const past = b.end_date <= (await one<{ d: string }>(`select ${LONDON_TODAY}::text d`, [], db))!.d;
    await q(`update appointments set end_date = $2, ended_reason = $3, status = case when $4 then 'ended' else status end, updated_at = now() where id = $1`, [id, b.end_date, b.reason, past], db);
    await q('update appointment_properties set to_date = $2 where appointment_id = $1 and (to_date is null or to_date > $2)', [id, b.end_date], db);
    await q('update appointment_rates set effective_to = $2 where appointment_id = $1 and effective_to is null and effective_from <= $2', [id, b.end_date], db);
    await q(`update scheduled_visits set status = 'cancelled' where appointment_id = $1 and status = 'scheduled' and (planned_start at time zone 'Europe/London')::date > $2`, [id, b.end_date], db);
    // Remove this company's explicit roles only if no other appointment in the same company remains. Other companies are untouched.
    const other = await one(`select 1 from appointments a where a.person_id = $1 and a.company_id = $2 and a.id <> $3 and a.status <> 'ended' and (a.end_date is null or a.end_date > $4)`, [ap.person_id, ap.company_id, id, b.end_date], db);
    let revoked = 0;
    if (!other && past) revoked = (await q(`update role_grants set revoked_at = now(), revoked_by = $3, reason = coalesce(reason, '') || ' [appointment ended]' where person_id = $1 and company_id = $2 and revoked_at is null returning id`, [ap.person_id, ap.company_id, req.person.id], db)).length;
    // A future end date: the roles expire at the end of the last day (London), so no later job is needed.
    if (!other && !past) revoked = (await q(`update role_grants set expires_at = least(coalesce(expires_at, 'infinity'), ($3::date + 1)::timestamp at time zone 'Europe/London') where person_id = $1 and company_id = $2 and revoked_at is null returning id`, [ap.person_id, ap.company_id, b.end_date], db)).length;
    // A leaver with no remaining appointment anywhere loses sign-in access.
    const anyLeft = await one(`select 1 from appointments a where a.person_id = $1 and a.status <> 'ended' and (a.end_date is null or a.end_date > $2)`, [ap.person_id, b.end_date], db);
    const isSuper = await one(`select 1 from role_grants where person_id = $1 and role_key = 'super_admin' and revoked_at is null`, [ap.person_id], db);
    const leaver = !anyLeft && past && !isSuper;
    if (leaver) await q(`update people set status = 'left', updated_at = now() where id = $1`, [ap.person_id], db);
    const keys = await q(`select k.label, pr.name as property_name from property_keys k join properties pr on pr.id = k.property_id where k.holder_person_id = $1 and k.returned_at is null and k.lost_reported_at is null and pr.company_id = $2`, [ap.person_id, ap.company_id], db);
    await audit(db, req.person.id, ap.company_id, 'appointment', id, 'end', { end_date: b.end_date, transferred_to: b.transfer_to ?? null, revoked_grants: revoked, leaver });
    return { revokedGrants: revoked, leaver, accessEndsOn: past ? null : b.end_date, keysStillHeld: keys };
  });
  res.json(result);
});

people.post('/appointments/:id/rates', async (req, res) => {
  const id = idParam(req.params.id);
  const ap = await loadAppointment(req.access, id, 'rates.manage');
  const b = parse(z.object({ rate_type: z.enum(['hourly', 'daily', 'annual_salary']), amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 13.50'), effective_from: isoDate }), req.body);
  const row = await tx(async (db) => {
    const later = await one('select 1 from appointment_rates where appointment_id = $1 and effective_from >= $2', [id, b.effective_from], db);
    if (later) throw conflict('A rate already starts on or after this date. Rates are effective-dated; add a later date instead of rewriting history.');
    await q(`update appointment_rates set effective_to = $2::date - 1 where appointment_id = $1 and effective_to is null`, [id, b.effective_from], db);
    const r = await one('insert into appointment_rates (appointment_id, rate_type, amount, effective_from, created_by) values ($1,$2,$3::numeric,$4,$5) returning *', [id, b.rate_type, b.amount, b.effective_from, req.person.id], db);
    await audit(db, req.person.id, ap.company_id, 'appointment_rate', r.id, 'create', { appointment_id: id, effective_from: b.effective_from });
    return r;
  });
  res.status(201).json(row);
});

people.post('/appointments/:id/properties', async (req, res) => {
  const id = idParam(req.params.id);
  const ap = await loadAppointment(req.access, id, 'appointments.manage');
  const b = parse(z.object({ property_id: uuid, from_date: isoDate.optional(), override_reason: text(500).min(5).optional() }), req.body);
  if (!(ap.status === 'active' || ap.status === 'planned')) throw conflict('Only current appointments can be given properties.');
  const pr = await one(`select p.id from properties p where p.id = $1 and (p.company_id = $2 or exists (select 1 from property_company_links l where l.property_id = p.id and l.company_id = $2))`, [b.property_id, ap.company_id]);
  if (!pr) throw bad('This property is not part of this company or an authorised arrangement.', { fields: { property_id: 'Wrong company' } });
  const out = await tx(async (db) => {
    const warnings = await clearanceGate(db, req.access, ap.person_id, ap.company_id, `Property allocation (appointment ${id})`, b.override_reason);
    const dup = await one('select 1 from appointment_properties where appointment_id = $1 and property_id = $2 and to_date is null', [id, b.property_id], db);
    if (dup) throw conflict('Already allocated.');
    const row = await one(`insert into appointment_properties (appointment_id, property_id, from_date, created_by) values ($1,$2,coalesce($3::date, ${LONDON_TODAY}),$4) returning *`, [id, b.property_id, b.from_date ?? null, req.person.id], db);
    await audit(db, req.person.id, ap.company_id, 'appointment_property', row.id, 'allocate', { property_id: b.property_id, warnings });
    return { ...row, warnings };
  });
  res.status(201).json(out);
});

people.post('/appointment-properties/:id/end', async (req, res) => {
  const id = idParam(req.params.id);
  const row = await one('select ap.*, a.company_id from appointment_properties ap join appointments a on a.id = ap.appointment_id where ap.id = $1', [id]);
  if (!row || !req.access.perms.has(row.company_id)) throw notFound();
  need(req.access, 'appointments.manage', row.company_id);
  await q(`update appointment_properties set to_date = greatest(from_date, ${LONDON_TODAY}) where id = $1 and to_date is null`, [id]);
  await audit(pool, req.person.id, row.company_id, 'appointment_property', id, 'end', {});
  res.json({ ok: true });
});

// ── Clearance and employment checks (restricted) ──
people.get('/clearance', async (req, res) => {
  const cs = companiesWith(req.access, 'clearance.view').filter((c) => !req.query.company || c === req.query.company);
  res.json(await q(`select cc.*, c.name as company_name, c.code as company_code, ${name('p')} as person_name
                      from current_clearance cc join companies c on c.id = cc.company_id join people p on p.id = cc.person_id
                     where cc.company_id = any($1::uuid[]) and p.status <> 'left' order by c.name, p.full_name`, [cs]));
});

people.post('/clearance', async (req, res) => {
  const b = parse(z.object({ person_id: uuid, company_id: uuid, status: z.enum(['pending', 'cleared', 'cleared_with_restrictions', 'not_authorised']), restrictions: text(1000).optional(), evidence_summary: text(1000).min(3), review_date: isoDate.nullable().optional() }), req.body);
  need(req.access, 'clearance.decide', b.company_id);
  if (b.person_id === req.person.id) throw forbidden('You cannot record your own clearance.');
  if (b.status === 'cleared_with_restrictions' && !b.restrictions) throw bad('Describe the restrictions.', { fields: { restrictions: 'Required' } });
  const has = await one('select 1 from appointments where person_id = $1 and company_id = $2', [b.person_id, b.company_id]);
  if (!has) throw bad('This person has no appointment in this company.');
  const row = await one('insert into clearance_decisions (person_id, company_id, status, restrictions, evidence_summary, decided_by, review_date) values ($1,$2,$3,$4,$5,$6,$7) returning *',
    [b.person_id, b.company_id, b.status, b.restrictions ?? null, b.evidence_summary, req.person.id, b.review_date ?? null]);
  await audit(pool, req.person.id, b.company_id, 'clearance_decision', row.id, 'decide', { person_id: b.person_id, status: b.status });
  await notify(pool, b.person_id, b.company_id, 'Your deployment clearance was updated', '/profile');
  res.status(201).json(row);
});

const checkBody = z.object({
  check_type: z.enum(['dbs', 'right_to_work', 'reference', 'qualification', 'other']),
  label: text(120).min(2),
  status: z.enum(['evidence_missing', 'requested', 'awaiting_verification', 'verified', 'adverse_finding', 'not_required']),
  requested_on: isoDate.nullable().optional(), issued_on: isoDate.nullable().optional(), verified_on: isoDate.nullable().optional(),
  reference_number: text(60).nullable().optional(), follow_up_on: isoDate.nullable().optional(), next_review_on: isoDate.nullable().optional(),
  actions: text(1000).nullable().optional(),
});
const checkCols = ['check_type', 'label', 'status', 'requested_on', 'issued_on', 'verified_on', 'reference_number', 'follow_up_on', 'next_review_on', 'actions'] as const;

people.post('/checks', async (req, res) => {
  const b = parse(checkBody.extend({ person_id: uuid, company_id: uuid }), req.body);
  need(req.access, 'checks.manage', b.company_id);
  if (b.person_id === req.person.id) throw forbidden('You cannot record your own employment checks.');
  const reviewer = b.status === 'verified' ? req.person.id : null;
  const row = await one(`insert into employment_checks (person_id, company_id, reviewer_id, ${checkCols.join(', ')}) values ($1,$2,$3,${checkCols.map((_, i) => `$${i + 4}`).join(',')}) returning *`,
    [b.person_id, b.company_id, reviewer, ...checkCols.map((k) => (b as any)[k] ?? null)]);
  await audit(pool, req.person.id, b.company_id, 'employment_check', row.id, 'create', { person_id: b.person_id, check_type: b.check_type, status: b.status });
  res.status(201).json(row);
});
people.patch('/checks/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const ex = await one('select * from employment_checks where id = $1', [id]);
  if (!ex || !req.access.perms.has(ex.company_id)) throw notFound();
  need(req.access, 'checks.manage', ex.company_id);
  if (ex.person_id === req.person.id) throw forbidden('You cannot change your own employment checks.');
  const b = parse(checkBody.partial(), req.body);
  const keys = Object.keys(b) as (typeof checkCols[number])[];
  if (!keys.length) throw bad('Nothing to save.');
  const row = await one(`update employment_checks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, reviewer_id = case when $${keys.length + 2} then $${keys.length + 3}::uuid else reviewer_id end, updated_at = now() where id = $1 returning *`,
    [id, ...keys.map((k) => (b as any)[k]), b.status === 'verified', req.person.id]);
  await audit(pool, req.person.id, ex.company_id, 'employment_check', id, 'update', { before_status: ex.status, after_status: row.status });
  res.json(row);
});
