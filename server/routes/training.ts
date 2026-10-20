import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, isoDate, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { type Access, can, need, scope } from '../perm.ts';
import { saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const training = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// ── Visibility: company courses to that company; shared courses (company_id null) to everyone. ──
// Editing: company courses need training.manage there; shared courses need a super administrator.
const canManageCourse = (a: Access, c: { company_id: string | null }) => (c.company_id ? can(a, 'training.manage', c.company_id) : a.superAdmin);
async function loadCourse(a: Access, id: string, db: Db = pool) {
  const c = await one('select * from courses where id = $1', [id], db);
  if (!c || (c.company_id && !a.perms.has(c.company_id))) throw notFound();
  const manage = canManageCourse(a, c);
  if (c.status === 'draft' && !manage) throw notFound();
  return { c, manage };
}
// Learners never receive which answers are correct.
const publicQuestions = (qs: any[]) => qs.map(({ options, ...rest }) => ({ ...rest, options: (options ?? []).map(({ correct: _c, ...o }: any) => o) }));

const httpsUrl = z.url({ protocol: /^https$/ });
const lessonSchema = z.object({
  title: text(160).min(1), body: text(20000).default(''),
  image_file_id: uuid.nullable().optional(), image_alt: text(300).nullable().optional(),
  video_url: httpsUrl.nullable().optional(), transcript: text(20000).nullable().optional(),
  resources: z.array(z.object({ label: text(120).min(1), url: httpsUrl })).max(20).optional(),
  scenario: text(4000).nullable().optional(),
}).refine((l) => !l.image_file_id || !!l.image_alt, { message: 'Every image needs a text description (alternative text)', path: ['image_alt'] })
  .refine((l) => !l.video_url || !!l.transcript, { message: 'Every video needs a transcript or captions text', path: ['transcript'] });
const questionSchema = z.object({
  id: z.string().min(1).max(40), type: z.enum(['single', 'multiple', 'true_false', 'written']), prompt: text(2000).min(3),
  image_file_id: uuid.nullable().optional(), image_alt: text(300).nullable().optional(),
  options: z.array(z.object({ id: z.string().min(1).max(40), text: text(500).min(1), correct: z.boolean() })).max(10).default([]),
  marks: z.coerce.number().int().min(1).max(20).default(1),
}).refine((x) => !x.image_file_id || !!x.image_alt, { message: 'Every image needs a text description', path: ['image_alt'] })
  .refine((x) => x.type === 'written' ? x.options.length === 0 : x.options.length >= 2, { message: 'Choice questions need at least two options; written answers have none', path: ['options'] })
  .refine((x) => x.type === 'written' || (x.type === 'multiple' ? x.options.some((o) => o.correct) : x.options.filter((o) => o.correct).length === 1), { message: 'Mark the correct answer (exactly one for single choice and true/false)', path: ['options'] });
const courseFields = z.object({
  title: text(200).min(3), summary: text(2000).nullable(),
  lessons: z.array(lessonSchema).max(100), questions: z.array(questionSchema).max(200)
    .refine((qs) => new Set(qs.map((x) => x.id)).size === qs.length, 'Question ids must be unique'),
  draw_count: z.coerce.number().int().min(1).nullable(), pass_mark: z.coerce.number().int().min(1).max(100).nullable(),
  attempt_limit: z.coerce.number().int().min(1).max(20).nullable(), time_limit_minutes: z.coerce.number().int().min(1).max(240).nullable(),
}).partial();

training.get('/courses', async (req, res) => {
  const a = req.access;
  const rows = await q(`
    select c.id, c.root_id, c.version, c.company_id, co.code as company_code, co.name as company_name, c.title, c.summary, c.status, c.pass_mark, c.time_limit_minutes, c.attempt_limit,
           jsonb_array_length(c.lessons) as lesson_count, jsonb_array_length(c.questions) as question_count, c.published_at,
           (select lesson_index from course_progress p where p.course_id = c.id and p.person_id = $1) as my_lesson,
           (select max(completed_on) from training_records r where r.course_root_id = c.root_id and r.person_id = $1) as my_completed_on
      from courses c left join companies co on co.id = c.company_id
     where (c.company_id is null or c.company_id = any($2::uuid[])) and c.status <> 'retired'
       and ($3::uuid is null or c.company_id is null or c.company_id = $3)
     order by c.title, c.version desc`, [a.personId, [...a.perms.keys()], req.query.company ? parse(uuid, req.query.company) : null]);
  res.json(rows.filter((c) => c.status === 'published' || canManageCourse(a, c)).map((c) => ({ ...c, can_manage: canManageCourse(a, c) })));
});

training.get('/courses/:id', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  const progress = await one('select lesson_index from course_progress where person_id = $1 and course_id = $2', [req.person.id, c.id]);
  const attempts = await q('select id, status, score, max_score, passed, started_at, submitted_at from quiz_attempts where person_id = $1 and course_id = $2 order by started_at desc', [req.person.id, c.id]);
  const versions = await q('select id, version, status, published_at from courses where root_id = $1 order by version desc', [c.root_id]);
  res.json({ course: manage ? c : { ...c, questions: publicQuestions(c.questions) }, progress: progress?.lesson_index ?? 0, attempts, versions, can: { manage, edit: manage && c.status === 'draft' } });
});

training.post('/courses', async (req, res) => {
  const b = parse(z.object({ company_id: uuid.nullable(), title: text(200).min(3), summary: text(2000).nullable().optional() }), req.body);
  if (!canManageCourse(req.access, b)) throw forbidden(b.company_id ? undefined : 'Only a super administrator can create shared courses.');
  const id = randomUUID();
  const c = await one(`insert into courses (id, root_id, company_id, title, summary, created_by) values ($1,$1,$2,$3,$4,$5) returning *`, [id, b.company_id, b.title, b.summary ?? null, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'course', id, 'create', { title: b.title });
  res.status(201).json(c);
});

training.patch('/courses/:id', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage || c.status !== 'draft') throw forbidden('Only a draft can be edited. Create a new version of a published course.');
  const b = parse(courseFields.strict(), req.body);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  const row = await one(`update courses set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
    [c.id, ...keys.map((k) => (['lessons', 'questions'].includes(k) ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
  res.json(row);
});

training.post('/courses/:id/images', upload.single('file'), async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage || c.status !== 'draft') throw forbidden();
  if (!req.file) throw bad('Choose an image.');
  const f = await tx((db) => saveFile(db, { companyId: c.company_id, entityType: 'course', entityId: c.root_id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true }));
  res.status(201).json({ id: f.id });
});

training.post('/courses/:id/publish', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage || c.status !== 'draft') throw forbidden();
  if (!c.lessons.length) throw bad('Add at least one lesson before publishing.');
  if (c.questions.length && !c.pass_mark) throw bad('Set a pass mark for the quiz.', { fields: { pass_mark: 'Required' } });
  if (c.draw_count && c.draw_count > c.questions.length) throw bad('The number of questions to draw is larger than the question bank.', { fields: { draw_count: 'Too many' } });
  // Validate the stored content once more with the same rules as editing.
  parse(courseFields, { lessons: c.lessons, questions: c.questions });
  await tx(async (db) => {
    await q(`update courses set status = 'retired', updated_at = now() where root_id = $1 and status = 'published'`, [c.root_id], db);
    await q(`update courses set status = 'published', published_by = $2, published_at = now(), updated_at = now() where id = $1`, [c.id, req.person.id], db);
    await audit(db, req.person.id, c.company_id, 'course', c.id, 'publish', { version: c.version });
  });
  res.json({ ok: true });
});

training.post('/courses/:id/new-version', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage || c.status === 'draft') throw forbidden();
  const draft = await one('select id from courses where root_id = $1 and status = $2', [c.root_id, 'draft']);
  if (draft) return res.json(draft); // one draft at a time: reopen it
  const v = (await one<{ v: number }>('select max(version) + 1 v from courses where root_id = $1', [c.root_id]))!.v;
  const row = await one(`insert into courses (root_id, version, company_id, title, summary, lessons, questions, draw_count, pass_mark, attempt_limit, time_limit_minutes, created_by)
                         select root_id, $2, company_id, title, summary, lessons, questions, draw_count, pass_mark, attempt_limit, time_limit_minutes, $3 from courses where id = $1 returning id`, [c.id, v, req.person.id]);
  res.status(201).json(row);
});

// ── Learning: progress, declaration, quiz attempts ──
training.put('/courses/:id/progress', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  if (c.status !== 'published') throw bad('Only published courses record progress.');
  const { lesson_index } = parse(z.object({ lesson_index: z.coerce.number().int().min(0) }), req.body);
  const i = Math.min(lesson_index, Math.max(0, c.lessons.length - 1));
  await q(`insert into course_progress (person_id, course_id, lesson_index) values ($1,$2,$3)
           on conflict (person_id, course_id) do update set lesson_index = greatest(course_progress.lesson_index, excluded.lesson_index), updated_at = now()`, [req.person.id, c.id, i]);
  res.json({ lesson_index: i });
});

// Courses without a quiz complete only when the last lesson was reached AND the learner confirms the declaration — never on opening.
training.post('/courses/:id/complete', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  parse(z.object({ declaration: z.literal(true, { message: 'Confirm that you have read and understood the course' }) }), req.body);
  if (c.status !== 'published' || c.questions.length) throw bad('This course is completed by passing its quiz.');
  const p = await one('select lesson_index from course_progress where person_id = $1 and course_id = $2', [req.person.id, c.id]);
  if (!p || p.lesson_index < c.lessons.length - 1) throw bad('Work through every lesson before completing the course.');
  const r = await one(`insert into training_records (person_id, course_root_id, course_id, title, source, completed_on, created_by) values ($1,$2,$3,$4,'course', ${LONDON_TODAY}, $1) returning *`, [req.person.id, c.root_id, c.id, c.title]);
  res.status(201).json(r);
});

function drawQuestions(c: any) {
  const qs = [...c.questions];
  if (!c.draw_count) return qs;
  for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
  return qs.slice(0, c.draw_count);
}
async function loadAttempt(a: Access, id: string, db: Db = pool) {
  const at = await one('select qa.*, c.title, c.pass_mark, c.root_id, c.company_id as course_company_id from quiz_attempts qa join courses c on c.id = qa.course_id where qa.id = $1', [id], db);
  if (!at) throw notFound();
  const own = at.person_id === a.personId;
  if (!own && !(await canMark(a, at))) throw notFound();
  return { at, own };
}
// Markers: training.manage in a company where the learner holds an appointment (and the course is visible there).
async function canMark(a: Access, at: any) {
  if (at.person_id === a.personId) return false;
  const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [at.person_id])).map((r) => r.company_id);
  return cos.some((c) => can(a, 'training.manage', c) && (!at.course_company_id || at.course_company_id === c));
}
// Learners never see the answer key (it would spoil later attempts); markers see it.
const attemptView = (at: any, own: boolean) => ({ ...at, questions: own ? publicQuestions(at.questions) : at.questions });

training.post('/courses/:id/attempts', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  if (c.status !== 'published' || !c.questions.length) throw bad('This course has no quiz.');
  const out = await tx(async (db) => {
    const open = await one(`select * from quiz_attempts where person_id = $1 and course_id = $2 and status = 'in_progress'`, [req.person.id, c.id], db);
    if (open) return open; // resume rather than start again
    const used = (await one<{ n: number }>(`select count(*)::int n from quiz_attempts where person_id = $1 and course_id = $2`, [req.person.id, c.id], db))!.n;
    if (c.attempt_limit && used >= c.attempt_limit) throw conflict(`You have used all ${c.attempt_limit} attempts. Ask your manager or trainer for help.`);
    return one(`insert into quiz_attempts (person_id, course_id, questions, deadline) values ($1,$2,$3, case when $4::int is null then null else now() + make_interval(mins => $4::int) end) returning *`,
      [req.person.id, c.id, JSON.stringify(drawQuestions(c)), c.time_limit_minutes], db);
  });
  res.status(201).json(attemptView(out, true));
});
training.get('/attempts/:id', async (req, res) => {
  const { at, own } = await loadAttempt(req.access, idParam(req.params.id));
  res.json(attemptView(at, own));
});
const answersSchema = z.record(z.string().max(40), z.union([z.string().max(4000), z.array(z.string().max(40)).max(10)]));
const GRACE_MS = 60_000; // allow for a slow connection at the time limit
training.put('/attempts/:id/answers', async (req, res) => {
  const { at, own } = await loadAttempt(req.access, idParam(req.params.id));
  if (!own || at.status !== 'in_progress') throw forbidden();
  if (at.deadline && Date.now() > Date.parse(at.deadline) + GRACE_MS) throw conflict('Time is up. Your saved answers will be submitted.');
  const { answers } = parse(z.object({ answers: answersSchema }), req.body);
  await q('update quiz_attempts set answers = $2 where id = $1', [at.id, JSON.stringify(answers)]);
  res.json({ ok: true });
});

function autoMark(questions: any[], answers: Record<string, any>) {
  let marks = 0, max = 0, written = false;
  for (const qn of questions) {
    max += qn.marks;
    if (qn.type === 'written') { written = true; continue; }
    const correct = qn.options.filter((o: any) => o.correct).map((o: any) => o.id).sort();
    const given = ([] as string[]).concat(answers[qn.id] ?? []).sort();
    if (JSON.stringify(correct) === JSON.stringify(given)) marks += qn.marks; // all-or-nothing per question
  }
  return { marks, max, written };
}
async function finish(db: Db, at: any, score: number, max: number, markedBy: string | null) {
  const passed = Math.round((score * 100) / max) >= at.pass_mark;
  await q(`update quiz_attempts set status = 'marked', score = $2, max_score = $3, passed = $4, marked_by = $5, marked_at = now() where id = $1`, [at.id, score, max, passed, markedBy], db);
  if (passed) await q(`insert into training_records (person_id, course_root_id, course_id, title, source, completed_on, attempt_id, created_by) values ($1,$2,$3,$4,'course', ${LONDON_TODAY}, $5, $1)`, [at.person_id, at.root_id, at.course_id, at.title, at.id], db);
  return passed;
}
training.post('/attempts/:id/submit', async (req, res) => {
  const result = await tx(async (db) => {
    const { at, own } = await loadAttempt(req.access, idParam(req.params.id), db);
    if (!own || at.status !== 'in_progress') throw forbidden();
    const late = at.deadline && Date.now() > Date.parse(at.deadline) + GRACE_MS;
    // Answers sent after the time limit are ignored; the last answers saved in time are marked.
    const answers = !late && req.body?.answers ? parse(answersSchema, req.body.answers) : at.answers;
    const m = autoMark(at.questions, answers);
    await q(`update quiz_attempts set answers = $2, submitted_at = now(), auto_marks = $3, status = $4 where id = $1`, [at.id, JSON.stringify(answers), m.marks, m.written ? 'awaiting_marking' : 'in_progress'], db);
    if (m.written) return { status: 'awaiting_marking', late };
    const passed = await finish(db, at, m.marks, m.max, null);
    return { status: 'marked', score: m.marks, max: m.max, passed, late };
  });
  res.json(result);
});
training.get('/marking', async (req, res) => {
  const cs = scope(req.access, 'training.manage', req.query.company);
  const rows = await q(`select qa.id, qa.submitted_at, qa.person_id, ${name('p')} as person_name, c.title, c.company_id as course_company_id
                          from quiz_attempts qa join courses c on c.id = qa.course_id join people p on p.id = qa.person_id
                         where qa.status = 'awaiting_marking' and qa.person_id <> $1
                           and exists (select 1 from appointments a where a.person_id = qa.person_id and a.company_id = any($2::uuid[]) and (c.company_id is null or c.company_id = a.company_id))
                         order by qa.submitted_at`, [req.person.id, cs]);
  res.json(rows);
});
training.post('/attempts/:id/mark', async (req, res) => {
  const { marks } = parse(z.object({ marks: z.record(z.string(), z.coerce.number().int().min(0)) }), req.body);
  const result = await tx(async (db) => {
    const { at, own } = await loadAttempt(req.access, idParam(req.params.id), db);
    if (own || at.status !== 'awaiting_marking') throw forbidden('You cannot mark your own attempt.');
    let manual = 0;
    for (const qn of at.questions.filter((x: any) => x.type === 'written')) {
      const m = marks[qn.id];
      if (m === undefined || m > qn.marks) throw bad(`Give a mark from 0 to ${qn.marks} for every written answer.`);
      manual += m;
    }
    const max = at.questions.reduce((s: number, x: any) => s + x.marks, 0);
    await q('update quiz_attempts set manual_marks = $2 where id = $1', [at.id, JSON.stringify(marks)], db);
    const passed = await finish(db, at, at.auto_marks + manual, max, req.person.id);
    await audit(db, req.person.id, at.course_company_id, 'quiz_attempt', at.id, 'mark', { score: at.auto_marks + manual, max, passed });
    await notify(db, at.person_id, at.course_company_id, `Your ${at.title} quiz has been marked: ${passed ? 'passed' : 'not passed yet'}`, '/training');
    return { passed, score: at.auto_marks + manual, max };
  });
  res.json(result);
});

// ── Matrix, requirements, assignments, equivalences ──
training.get('/training/matrix', async (req, res) => {
  const a = req.access;
  const person = req.query.person === 'me' ? a.personId : req.query.person ? parse(uuid, req.query.person) : null;
  const cs = person === a.personId ? scope(a, null, req.query.company) : scope(a, 'training.view_all', req.query.company);
  res.json(await q(`select m.*, ${name('p')} as person_name, co.code as company_code, co.name as company_name,
                           (select title from courses c where c.root_id = m.course_root_id and c.status = 'published' order by version desc limit 1) as course_title,
                           (select id from courses c where c.root_id = m.course_root_id and c.status = 'published' order by version desc limit 1) as course_id
                      from training_matrix(${LONDON_TODAY}) m join people p on p.id = m.person_id join companies co on co.id = m.company_id
                     where m.company_id = any($1::uuid[]) and ($2::uuid is null or m.person_id = $2) and p.status <> 'left'
                     order by p.full_name, course_title`, [cs, person]));
});
training.get('/training/requirements', async (req, res) => {
  res.json(await q(`select r.*, co.code as company_code, (select title from courses c where c.root_id = r.course_root_id order by version desc limit 1) as course_title
                      from training_requirements r join companies co on co.id = r.company_id where r.company_id = any($1::uuid[]) and r.retired_at is null order by co.code, course_title`,
    [scope(req.access, null, req.query.company)]));
});
async function rootVisibleTo(companyId: string, rootId: string) {
  return !!(await one(`select 1 from courses where root_id = $1 and status = 'published' and (company_id is null or company_id = $2)`, [rootId, companyId]));
}
training.post('/training/requirements', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, course_root_id: uuid, job_title: text(120).nullable().optional(), due_within_days: z.coerce.number().int().min(0).max(365), refresher_months: z.coerce.number().int().min(1).max(120).nullable().optional() }), req.body);
  need(req.access, 'training.manage', b.company_id);
  if (!(await rootVisibleTo(b.company_id, b.course_root_id))) throw bad('Choose a published course from this company or shared learning.');
  const r = await one('insert into training_requirements (company_id, course_root_id, job_title, due_within_days, refresher_months, created_by) values ($1,$2,$3,$4,$5,$6) returning *',
    [b.company_id, b.course_root_id, b.job_title || null, b.due_within_days, b.refresher_months ?? null, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'training_requirement', r.id, 'create', { course_root_id: b.course_root_id, job_title: b.job_title ?? null });
  res.status(201).json(r);
});
training.post('/training/requirements/:id/retire', async (req, res) => {
  const r = await one('select * from training_requirements where id = $1', [idParam(req.params.id)]);
  if (!r) throw notFound();
  need(req.access, 'training.manage', r.company_id);
  await q('update training_requirements set retired_at = now() where id = $1', [r.id]);
  await audit(pool, req.person.id, r.company_id, 'training_requirement', r.id, 'retire', {});
  res.json({ ok: true });
});
training.post('/training/assignments', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, person_id: uuid, course_root_id: uuid, due_on: isoDate }), req.body);
  need(req.access, 'training.manage', b.company_id);
  if (!(await rootVisibleTo(b.company_id, b.course_root_id))) throw bad('Choose a published course from this company or shared learning.');
  if (!(await one('select 1 from appointments where person_id = $1 and company_id = $2', [b.person_id, b.company_id]))) throw bad('This person has no appointment in this company.');
  const r = await one(`insert into training_assignments (company_id, person_id, course_root_id, due_on, assigned_by) values ($1,$2,$3,$4,$5)
                       on conflict (company_id, person_id, course_root_id) do update set due_on = excluded.due_on returning *`, [b.company_id, b.person_id, b.course_root_id, b.due_on, req.person.id]);
  await notify(pool, b.person_id, b.company_id, 'New training assigned to you', '/training');
  res.status(201).json(r);
});
training.post('/training/equivalences', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, course_root_id: uuid, equivalent_root_id: uuid }), req.body);
  need(req.access, 'training.manage', b.company_id);
  if (b.course_root_id === b.equivalent_root_id) throw bad('Choose a different course.');
  await q('insert into course_equivalences (company_id, course_root_id, equivalent_root_id, accepted_by) values ($1,$2,$3,$4) on conflict do nothing', [b.company_id, b.course_root_id, b.equivalent_root_id, req.person.id]);
  await audit(pool, req.person.id, b.company_id, 'course_equivalence', null, 'accept', b);
  res.status(201).json({ ok: true });
});

// ── Records: completions, and external certificates that count once verified ──
training.get('/training/records', async (req, res) => {
  const a = req.access;
  const person = req.query.person && req.query.person !== 'me' ? parse(uuid, req.query.person) : a.personId;
  if (person !== a.personId) {
    const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [person])).map((r) => r.company_id);
    if (!cos.some((c) => can(a, 'training.view_all', c))) throw notFound();
  }
  res.json(await q(`select r.*, ${name('v')} as verified_by_name from training_records r left join people v on v.id = r.verified_by where r.person_id = $1 order by r.completed_on desc`, [person]));
});
training.get('/training/verify-queue', async (req, res) => {
  const cs = scope(req.access, 'training.manage', req.query.company);
  res.json(await q(`select r.*, ${name('p')} as person_name from training_records r join people p on p.id = r.person_id
                     where r.source = 'external' and r.verified_at is null and r.person_id <> $1
                       and exists (select 1 from appointments a where a.person_id = r.person_id and a.company_id = any($2::uuid[])) order by r.created_at`, [req.person.id, cs]));
});
training.post('/training/records', async (req, res) => {
  const b = parse(z.object({ title: text(200).min(3), provider: text(200).nullable().optional(), completed_on: isoDate, course_root_id: uuid.nullable().optional() }), req.body);
  if ((await one<{ f: boolean }>(`select $1::date > ${LONDON_TODAY} f`, [b.completed_on]))!.f) throw bad('The completion date cannot be in the future.', { fields: { completed_on: 'In the future' } });
  const r = await one(`insert into training_records (person_id, course_root_id, title, source, completed_on, provider, created_by) values ($1,$2,$3,'external',$4,$5,$1) returning *`,
    [req.person.id, b.course_root_id ?? null, b.title, b.completed_on, b.provider ?? null]);
  res.status(201).json(r);
});
training.post('/training/records/:id/certificate', upload.single('file'), async (req, res) => {
  const r = await one('select * from training_records where id = $1', [idParam(req.params.id)]);
  if (!r || r.person_id !== req.person.id || r.source !== 'external' || r.verified_at) throw notFound();
  if (!req.file) throw bad('Choose the certificate (PDF or image).');
  const f = await tx(async (db) => {
    const saved = await saveFile(db, { companyId: null, entityType: 'training_record', entityId: r.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id });
    await q('update training_records set certificate_file_id = $2 where id = $1', [r.id, saved.id], db);
    return saved;
  });
  res.status(201).json({ id: f.id });
});
training.post('/training/records/:id/verify', async (req, res) => {
  const r = await one('select * from training_records where id = $1', [idParam(req.params.id)]);
  if (!r || r.source !== 'external') throw notFound();
  if (r.person_id === req.person.id) throw forbidden('You cannot verify your own certificate.');
  const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [r.person_id])).map((x) => x.company_id);
  const co = cos.find((c) => can(req.access, 'training.manage', c));
  if (!co) throw forbidden();
  const { approve, note } = parse(z.object({ approve: z.boolean(), note: text(500).optional() }), req.body);
  if (approve) await q('update training_records set verified_by = $2, verified_at = now() where id = $1', [r.id, req.person.id]);
  else await q('delete from training_records where id = $1 and verified_at is null', [r.id]);
  await audit(pool, req.person.id, co, 'training_record', r.id, approve ? 'verify' : 'reject', { title: r.title, note: note ?? null });
  await notify(pool, r.person_id, co, `Your certificate “${r.title}” was ${approve ? 'verified' : 'not accepted'}`, '/training', note);
  res.json({ ok: true });
});
