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

export const CATEGORIES = ['fundamentals', 'safeguarding', 'health_safety', 'practice', 'leadership', 'other'] as const;
const httpsUrl = z.url({ protocol: /^https$/ });
const lessonSchema = z.object({
  title: text(160).min(1), body: text(20000).default(''),
  image_file_id: uuid.nullable().optional(), image_alt: text(300).nullable().optional(),
  video_url: httpsUrl.nullable().optional(), transcript: text(20000).nullable().optional(),
  resources: z.array(z.object({ label: text(120).min(1), url: httpsUrl })).max(20).optional(),
  scenario: text(4000).nullable().optional(),
  module: text(120).nullable().optional(),                       // lessons with the same module are grouped in the curriculum
  key_points: z.array(text(300).min(1)).max(12).optional(),
  // Knowledge checks are for practice: the learner sees the feedback straight away and nothing is scored.
  checks: z.array(z.object({ prompt: text(1000).min(3), options: z.array(z.object({ text: text(400).min(1), correct: z.boolean(), feedback: text(1000).optional() })).min(2).max(6) })
    .refine((c) => c.options.some((o) => o.correct), 'Mark at least one good answer')).max(6).optional(),
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
  category: z.enum(CATEGORIES).nullable(), difficulty: z.enum(['foundation', 'intermediate', 'advanced']).nullable(),
  duration_minutes: z.coerce.number().int().min(1).max(1200).nullable(), audience: text(1000).nullable(),
  roles: z.array(text(40)).max(30), objectives: z.array(text(300).min(1)).max(20),
  source_refs: z.array(z.object({ label: text(300).min(1), url: httpsUrl.nullable().optional() })).max(40),
  certificate_eligible: z.boolean(), content_owner: text(200).nullable(), review_on: isoDate.nullable(),
}).partial();
const JSON_FIELDS = ['lessons', 'questions', 'objectives', 'source_refs'];
// Minimum time on a lesson before it can be marked done: a quarter of its reading time at 250 words a minute, 5 s to 2 min.
// shortcut: counts words only, so a lesson that is mostly a video gets the 5 s floor; add the video length when videos are hosted here.
export const minSeconds = (l: any) => {
  const words = [l.body, l.scenario, ...(l.key_points ?? []), ...(l.checks ?? []).map((c: any) => c.prompt)].join(' ').split(/\s+/).filter(Boolean).length;
  return Math.min(120, Math.max(5, Math.round(words * 0.06)));
};

training.get('/courses', async (req, res) => {
  const a = req.access;
  const rows = await q(`
    select c.id, c.root_id, c.version, c.company_id, co.code as company_code, co.name as company_name, c.title, c.summary, c.status, c.pass_mark, c.time_limit_minutes, c.attempt_limit,
           jsonb_array_length(c.lessons) as lesson_count, jsonb_array_length(c.questions) as question_count, c.published_at,
           c.category, c.difficulty, c.duration_minutes, c.roles, c.certificate_eligible, c.review_status,
           (select count(distinct coalesce(l->>'module', ''))::int from jsonb_array_elements(c.lessons) l) as module_count,
           (select count(*)::int from lesson_progress lp where lp.course_id = c.id and lp.person_id = $1 and lp.completed_at is not null) as my_lessons_done,
           exists (select 1 from training_matrix(${LONDON_TODAY}) m where m.person_id = $1 and m.course_root_id = c.root_id) as mandatory,
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
  const lessons = await q('select lesson_index, seconds, completed_at from lesson_progress where person_id = $1 and course_id = $2 order by lesson_index', [req.person.id, c.id]);
  const notes = await q('select id, lesson_index, body, updated_at from learning_notes where person_id = $1 and course_root_id = $2 order by lesson_index, created_at', [req.person.id, c.root_id]);
  const bookmarks = (await q<{ lesson_index: number }>('select lesson_index from learning_bookmarks where person_id = $1 and course_root_id = $2', [req.person.id, c.root_id])).map((b) => b.lesson_index);
  const completed = await one(`select max(completed_on) as on from training_records where person_id = $1 and course_root_id = $2 and (source = 'course' or verified_at is not null)`, [req.person.id, c.root_id]);
  const attempts = await q('select id, status, score, max_score, passed, started_at, submitted_at from quiz_attempts where person_id = $1 and course_id = $2 order by started_at desc', [req.person.id, c.id]);
  const versions = await q('select id, version, status, published_at from courses where root_id = $1 order by version desc', [c.root_id]);
  res.json({ course: manage ? c : { ...c, questions: publicQuestions(c.questions) }, progress: progress?.lesson_index ?? 0, attempts, versions,
    lessons, notes, bookmarks, completed_on: completed?.on ?? null, min_seconds: c.lessons.map(minSeconds),
    can: { manage, edit: manage && c.status === 'draft' } });
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
    [c.id, ...keys.map((k) => (JSON_FIELDS.includes(k) ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
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
  if (c.review_status === 'pending_review') throw conflict('This content is waiting for a specialist review. Approve the content before publishing.');
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

// Content marked pending review (for example legal or safeguarding detail) is approved by someone who manages training.
training.post('/courses/:id/approve-content', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage) throw forbidden();
  const { note } = parse(z.object({ note: text(1000).min(5, 'Say who reviewed the content and what was checked') }), req.body);
  await tx(async (db) => {
    await q(`update courses set review_status = 'approved', updated_at = now() where id = $1`, [c.id], db);
    await audit(db, req.person.id, c.company_id, 'course', c.id, 'approve_content', { version: c.version, note });
  });
  res.json({ ok: true });
});
training.post('/courses/:id/new-version', async (req, res) => {
  const { c, manage } = await loadCourse(req.access, idParam(req.params.id));
  if (!manage || c.status === 'draft') throw forbidden();
  const draft = await one('select id from courses where root_id = $1 and status = $2', [c.root_id, 'draft']);
  if (draft) return res.json(draft); // one draft at a time: reopen it
  const v = (await one<{ v: number }>('select max(version) + 1 v from courses where root_id = $1', [c.root_id]))!.v;
  // A new version starts approved only if the content it copies was approved; it is re-checked before publishing either way.
  const row = await one(`insert into courses (root_id, version, company_id, title, summary, lessons, questions, draw_count, pass_mark, attempt_limit, time_limit_minutes, created_by, ${COPY})
                         select root_id, $2, company_id, title, summary, lessons, questions, draw_count, pass_mark, attempt_limit, time_limit_minutes, $3, ${COPY} from courses where id = $1 returning id`, [c.id, v, req.person.id]);
  res.status(201).json(row);
});

const COPY = 'category, difficulty, duration_minutes, audience, roles, objectives, source_refs, certificate_eligible, content_owner, review_on, review_status';

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
  const done = (await one<{ n: number }>('select count(*)::int n from lesson_progress where person_id = $1 and course_id = $2 and completed_at is not null', [req.person.id, c.id]))!.n;
  if (done < c.lessons.length) throw bad('Work through and complete every lesson before completing the course.');
  const r = await one(`insert into training_records (person_id, course_root_id, course_id, title, source, completed_on, created_by) values ($1,$2,$3,$4,'course', ${LONDON_TODAY}, $1) returning *`, [req.person.id, c.root_id, c.id, c.title]);
  res.status(201).json(r);
});

// Opening, time spent and completing one lesson. Time counts only while the lesson is open and visible (the page sends a
// beat every 30 s; beats closer than 25 s apart are ignored, and each adds at most 30 s).
training.put('/courses/:id/lessons/:index', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  if (c.status !== 'published') throw bad('Only published courses record progress.');
  const i = parse(z.coerce.number().int().min(0).max(c.lessons.length - 1), req.params.index);
  const { action } = parse(z.object({ action: z.enum(['open', 'beat', 'complete']) }), req.body);
  const out = await tx(async (db) => {
    await q(`insert into lesson_progress (person_id, course_id, lesson_index) values ($1,$2,$3) on conflict do nothing`, [req.person.id, c.id, i], db);
    if (action === 'open') {
      await q(`insert into course_progress (person_id, course_id, lesson_index, last_opened_at) values ($1,$2,$3, now())
               on conflict (person_id, course_id) do update set lesson_index = excluded.lesson_index, last_opened_at = now(), updated_at = now()`, [req.person.id, c.id, i], db);
      await q(`update lesson_progress set last_beat_at = now() where person_id = $1 and course_id = $2 and lesson_index = $3`, [req.person.id, c.id, i], db);
    }
    if (action === 'beat')
      await q(`update lesson_progress set seconds = seconds + least(30, extract(epoch from now() - last_beat_at)::int), last_beat_at = now()
                where person_id = $1 and course_id = $2 and lesson_index = $3 and last_beat_at < now() - interval '25 seconds'`, [req.person.id, c.id, i], db);
    const lp = (await one(`select * from lesson_progress where person_id = $1 and course_id = $2 and lesson_index = $3 for update`, [req.person.id, c.id, i], db))!;
    if (action === 'complete' && !lp.completed_at) {
      const need = minSeconds(c.lessons[i]);
      const spent = Math.max(lp.seconds, Math.floor((Date.now() - Date.parse(lp.opened_at)) / 1000));
      if (spent < need) throw conflict(`Take a little longer with this lesson before marking it done (about ${need - spent} more seconds).`);
      await q(`update lesson_progress set completed_at = now(), seconds = greatest(seconds, $4) where person_id = $1 and course_id = $2 and lesson_index = $3`, [req.person.id, c.id, i, Math.min(spent, 3600)], db);
    }
    return one(`select lesson_index, seconds, completed_at from lesson_progress where person_id = $1 and course_id = $2 and lesson_index = $3`, [req.person.id, c.id, i], db);
  });
  res.json(out);
});

// Personal notes and bookmarks: only ever seen by the learner.
training.post('/courses/:id/notes', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  const b = parse(z.object({ lesson_index: z.coerce.number().int().min(0).max(Math.max(0, c.lessons.length - 1)), body: text(4000).min(1) }), req.body);
  res.status(201).json(await one('insert into learning_notes (person_id, course_root_id, lesson_index, body) values ($1,$2,$3,$4) returning id, lesson_index, body, updated_at', [req.person.id, c.root_id, b.lesson_index, b.body]));
});
training.delete('/learning-notes/:id', async (req, res) => {
  const r = await one('delete from learning_notes where id = $1 and person_id = $2 returning id', [idParam(req.params.id), req.person.id]);
  if (!r) throw notFound();
  res.json({ ok: true });
});
training.put('/courses/:id/bookmarks/:index', async (req, res) => {
  const { c } = await loadCourse(req.access, idParam(req.params.id));
  const i = parse(z.coerce.number().int().min(0).max(Math.max(0, c.lessons.length - 1)), req.params.index);
  const { on } = parse(z.object({ on: z.boolean() }), req.body);
  if (on) await q('insert into learning_bookmarks (person_id, course_root_id, lesson_index) values ($1,$2,$3) on conflict do nothing', [req.person.id, c.root_id, i]);
  else await q('delete from learning_bookmarks where person_id = $1 and course_root_id = $2 and lesson_index = $3', [req.person.id, c.root_id, i]);
  res.json({ on });
});

// The learner's own dashboard. Every figure is from their records; nothing is estimated except time left in a course.
training.get('/learning/me', async (req, res) => {
  const me = req.person.id;
  const cs = [...req.access.perms.keys()];
  const matrix = await q(`select m.*, co.code as company_code,
        (select c.id from courses c where c.root_id = m.course_root_id and c.status = 'published' order by version desc limit 1) as course_id,
        (select c.title from courses c where c.root_id = m.course_root_id and c.status = 'published' order by version desc limit 1) as course_title
      from training_matrix(${LONDON_TODAY}) m join companies co on co.id = m.company_id where m.person_id = $1 and m.company_id = any($2::uuid[]) order by m.due_on`, [me, cs]);
  const k = await one(`select
        (select count(distinct course_root_id) from training_records where person_id = $1 and (source = 'course' or verified_at is not null))::int as completed,
        (select coalesce(sum(seconds), 0) from lesson_progress where person_id = $1)::int as seconds,
        (select count(*) from training_records where person_id = $1 and certificate_file_id is not null and verified_at is not null)::int as certificates,
        (select count(*) from quiz_attempts where person_id = $1 and status in ('in_progress','awaiting_marking'))::int as assessments,
        (select count(*) from training_records where person_id = $1 and source = 'external' and verified_at is null)::int as awaiting_verification,
        (select min(s.next_due) from supervisions s where s.person_id = $1 and s.status = 'completed'
           and s.held_on = (select max(held_on) from supervisions x where x.person_id = s.person_id and x.company_id = s.company_id and x.status = 'completed')) as next_supervision`, [me]);
  // In progress: a lesson opened in the latest published version and no completion since it was first opened.
  const continuing = await q(`select c.id, c.root_id, c.title, c.category, c.duration_minutes, jsonb_array_length(c.lessons) as lessons, cp.last_opened_at,
        (select count(*)::int from lesson_progress lp where lp.course_id = c.id and lp.person_id = $1 and lp.completed_at is not null) as done,
        (select jsonb_agg(coalesce(l->>'module', '')) from jsonb_array_elements(c.lessons) l) as lesson_modules,
        (select array_agg(lp.lesson_index) from lesson_progress lp where lp.course_id = c.id and lp.person_id = $1 and lp.completed_at is not null) as done_idx
      from course_progress cp join courses c on c.id = cp.course_id
     where cp.person_id = $1 and c.status = 'published' and cp.last_opened_at is not null
       and not exists (select 1 from training_records r where r.person_id = $1 and r.course_root_id = c.root_id
                         and r.created_at >= (select min(opened_at) from lesson_progress lp where lp.course_id = c.id and lp.person_id = $1))
     order by cp.last_opened_at desc limit 12`, [me]);
  const roles = (await q<{ k: string }>(`select distinct job_role_key k from appointments where person_id = $1 and status = 'active' and job_role_key is not null`, [me])).map((r) => r.k);
  const recommended = await q(`select c.id, c.root_id, c.title, c.summary, c.category, c.difficulty, c.duration_minutes, jsonb_array_length(c.lessons) as lessons,
        exists (select 1 from training_matrix(${LONDON_TODAY}) m where m.person_id = $1 and m.course_root_id = c.root_id and m.status <> 'current') as required
      from courses c
     where c.status = 'published' and (c.company_id is null or c.company_id = any($2::uuid[]))
       and not exists (select 1 from training_records r where r.person_id = $1 and r.course_root_id = c.root_id)
       and not exists (select 1 from course_progress cp where cp.person_id = $1 and cp.course_id = c.id and cp.last_opened_at is not null)
       and (c.roles && $3::text[] or exists (select 1 from training_matrix(${LONDON_TODAY}) m where m.person_id = $1 and m.course_root_id = c.root_id))
     order by required desc, c.title limit 8`, [me, cs, roles]);
  res.json({ matrix, kpis: { ...k, assigned: matrix.length, mandatory_done: matrix.filter((m) => ['current', 'expiring'].includes(m.status)).length,
    renewal: matrix.filter((m) => m.completed_on && ['expiring', 'overdue'].includes(m.status)).length, in_progress: continuing.length },
    continuing: continuing.map(({ lesson_modules, done_idx, ...c }) => {
      const mods = [...new Set<string>(lesson_modules ?? [])];
      const done = new Set<number>(done_idx ?? []);
      // A module is done when every lesson in it is done.
      return { ...c, modules: mods.length, modules_done: mods.filter((m) => (lesson_modules as string[]).every((x, i) => x !== m || done.has(i))).length };
    }), recommended, roles });
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
