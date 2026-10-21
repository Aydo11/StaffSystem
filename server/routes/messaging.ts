import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, idParam, notFound, notify, parse, text, uuid } from '../http.ts';
import { ACTIVE_APPT, type Access, can, companiesWith, need, scope } from '../perm.ts';
import { deleteFile, saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const messaging = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

// Members only. Administrators cannot read conversations; a moderator sees a message only once someone reports it.
async function membership(a: Access, conversationId: string, db: Db = pool) {
  const c = await one(`select c.*, co.code as company_code from conversations c join companies co on co.id = c.company_id join conversation_members m on m.conversation_id = c.id
                        where c.id = $1 and m.person_id = $2 and m.left_at is null`, [conversationId, a.personId], db);
  if (!c) throw notFound();
  return c;
}
async function currentInCompany(db: Db, personIds: string[], companyId: string) {
  const ok = await q<{ person_id: string }>(`select distinct a.person_id from appointments a where a.company_id = $1 and a.person_id = any($2::uuid[]) and ${ACTIVE_APPT('a')}`, [companyId, personIds], db);
  if (ok.length !== new Set(personIds).size) throw bad('Everyone in a conversation must have a current role with its company.');
}

messaging.get('/conversations', async (req, res) => {
  res.json(await q(`
    select c.id, c.kind, c.title, c.company_id, co.code as company_code, co.name as company_name, c.property_id, p.name as property_name,
           (select json_agg(json_build_object('id', pe.id, 'name', ${name('pe')}, 'has_photo', pe.photo_path is not null) order by pe.full_name) from conversation_members cm join people pe on pe.id = cm.person_id where cm.conversation_id = c.id and cm.left_at is null) as members,
           (select json_build_object('body', coalesce(nullif(left(ms.body, 120), ''), 'Sent a photo'), 'at', ms.created_at, 'author', ${name('au')}) from messages ms join people au on au.id = ms.author_id where ms.conversation_id = c.id order by ms.created_at desc limit 1) as last,
           (select count(*) from messages ms where ms.conversation_id = c.id and ms.author_id <> $1 and ms.created_at > coalesce(m.last_read_at, '-infinity'))::int as unread
      from conversations c join conversation_members m on m.conversation_id = c.id and m.person_id = $1 and m.left_at is null
      join companies co on co.id = c.company_id left join properties p on p.id = c.property_id
     order by coalesce((select max(created_at) from messages ms where ms.conversation_id = c.id), c.created_at) desc`, [req.person.id]));
});

messaging.post('/conversations', async (req, res) => {
  const b = parse(z.object({ company_id: uuid, kind: z.enum(['direct', 'team', 'property']), title: text(120).nullable().optional(), property_id: uuid.nullable().optional(), member_ids: z.array(uuid).min(1).max(100) }), req.body);
  if (!req.access.perms.has(b.company_id)) throw forbidden();
  const members = [...new Set([req.person.id, ...b.member_ids])];
  if (b.kind === 'direct' && members.length !== 2) throw bad('A direct conversation is between you and one other person.');
  if (b.kind !== 'direct' && !b.title && b.kind === 'team') throw bad('Give the team conversation a name.', { fields: { title: 'Required' } });
  const out = await tx(async (db) => {
    await currentInCompany(db, members, b.company_id);
    if (b.kind === 'property') {
      const p = await one('select name from properties where id = $1 and company_id = $2', [b.property_id, b.company_id], db);
      if (!p) throw bad('Choose a property of this company.');
      b.title ??= p.name;
    }
    if (b.kind === 'direct') {
      // Reuse the existing direct conversation between the same two people.
      const existing = await one(`select c.id from conversations c where c.kind = 'direct' and c.company_id = $1
                                    and (select array_agg(person_id order by person_id) from conversation_members where conversation_id = c.id and left_at is null) = (select array_agg(x order by x) from unnest($2::uuid[]) x)`, [b.company_id, members], db);
      if (existing) return existing;
    }
    const c = await one('insert into conversations (company_id, kind, title, property_id, created_by) values ($1,$2,$3,$4,$5) returning id', [b.company_id, b.kind, b.title ?? null, b.property_id ?? null, req.person.id], db);
    for (const m of members) await q('insert into conversation_members (conversation_id, person_id, added_by) values ($1,$2,$3)', [c.id, m, req.person.id], db);
    return c;
  });
  res.status(201).json(out);
});

messaging.get('/conversations/:id/messages', async (req, res) => {
  const c = await membership(req.access, idParam(req.params.id));
  const before = req.query.before ? parse(z.iso.datetime({ offset: true }), req.query.before) : null;
  const rows = await q(`select ms.id, ms.body, ms.created_at, ms.author_id, ${name('au')} as author_name, au.photo_path is not null as author_has_photo,
                                ms.file_id, f.original_name as file_name, f.mime_type as file_type,
                                coalesce((select json_agg(json_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine) order by r.first)
                                            from (select emoji, count(*)::int n, bool_or(person_id = $3) mine, min(created_at) first from message_reactions where message_id = ms.id group by emoji) r), '[]') as reactions
                          from messages ms join people au on au.id = ms.author_id left join files f on f.id = ms.file_id
                         where ms.conversation_id = $1 and ($2::timestamptz is null or ms.created_at < $2) order by ms.created_at desc limit 50`, [c.id, before, req.person.id]);
  await q('update conversation_members set last_read_at = now() where conversation_id = $1 and person_id = $2', [c.id, req.person.id]);
  const members = await q(`select pe.id, ${name('pe')} as name, pe.photo_path is not null as has_photo from conversation_members cm join people pe on pe.id = cm.person_id
                            where cm.conversation_id = $1 and cm.left_at is null order by pe.full_name`, [c.id]);
  res.json({ conversation: c, members, messages: rows.reverse() });
});
messaging.post('/conversations/:id/messages', upload.single('file'), async (req, res) => {
  const c = await membership(req.access, idParam(req.params.id));
  const b = parse(z.object({ body: text(4000).default(''), client_request_id: uuid }), req.body);
  if (!b.body && !req.file) throw bad('Write a message or add a photo.', { fields: { body: 'Write a message' } });
  const m = await tx(async (db) => {
    const dup = await one('select id from messages where client_request_id = $1', [b.client_request_id], db);
    if (dup) return dup; // a retried send never posts twice
    const file = req.file ? await saveFile(db, { companyId: c.company_id, entityType: 'message', entityId: c.id, name: req.file.originalname, buf: req.file.buffer, uploadedBy: req.person.id }) : null;
    return one('insert into messages (conversation_id, author_id, body, file_id, client_request_id) values ($1,$2,$3,$4,$5) returning id, created_at', [c.id, req.person.id, b.body, file?.id ?? null, b.client_request_id], db);
  });
  await q('update conversation_members set last_read_at = now() where conversation_id = $1 and person_id = $2', [c.id, req.person.id]);
  res.status(201).json(m);
});
// One tap adds a reaction, a second tap on the same emoji removes it.
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '✅'];
messaging.post('/messages/:id/reactions', async (req, res) => {
  const m = await one<{ id: string; conversation_id: string }>('select id, conversation_id from messages where id = $1', [idParam(req.params.id)]);
  if (!m) throw notFound();
  await membership(req.access, m.conversation_id);
  const { emoji } = parse(z.object({ emoji: z.enum(REACTIONS as [string, ...string[]]) }), req.body);
  const gone = await one('delete from message_reactions where message_id = $1 and person_id = $2 and emoji = $3 returning 1', [m.id, req.person.id, emoji]);
  if (!gone) await q('insert into message_reactions (message_id, person_id, emoji) values ($1,$2,$3)', [m.id, req.person.id, emoji]);
  res.json({ reacted: !gone });
});
messaging.post('/conversations/:id/members', async (req, res) => {
  const c = await membership(req.access, idParam(req.params.id));
  if (c.kind === 'direct') throw bad('Start a team conversation to include more people.');
  const { person_id } = parse(z.object({ person_id: uuid }), req.body);
  await tx(async (db) => {
    await currentInCompany(db, [person_id], c.company_id);
    await q(`insert into conversation_members (conversation_id, person_id, added_by) values ($1,$2,$3) on conflict (conversation_id, person_id) do update set left_at = null, added_by = excluded.added_by, joined_at = now()`, [c.id, person_id, req.person.id], db);
  });
  res.json({ ok: true });
});
messaging.post('/conversations/:id/leave', async (req, res) => {
  const c = await membership(req.access, idParam(req.params.id));
  await q('update conversation_members set left_at = now() where conversation_id = $1 and person_id = $2', [c.id, req.person.id]);
  res.json({ ok: true });
});
messaging.get('/messages/search', async (req, res) => {
  const term = parse(text(80).min(2, 'Type at least 2 characters'), req.query.q);
  const like = `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  res.json(await q(`select ms.id, ms.conversation_id, left(ms.body, 200) as body, ms.created_at, ${name('au')} as author_name, c.title, c.kind
                      from messages ms join conversations c on c.id = ms.conversation_id join people au on au.id = ms.author_id
                      join conversation_members m on m.conversation_id = c.id and m.person_id = $1 and m.left_at is null
                     where ms.body ilike $2 order by ms.created_at desc limit 30`, [req.person.id, like]));
});

// ── Reports: the only route by which anyone other than members sees a message ──
messaging.post('/messages/:id/report', async (req, res) => {
  const m = await one('select ms.*, c.company_id from messages ms join conversations c on c.id = ms.conversation_id where ms.id = $1', [idParam(req.params.id)]);
  if (!m) throw notFound();
  await membership(req.access, m.conversation_id);
  const { reason } = parse(z.object({ reason: text(1000).min(3) }), req.body);
  try {
    await q('insert into message_reports (message_id, reported_by, reason) values ($1,$2,$3)', [m.id, req.person.id, reason]);
  } catch (e: any) {
    if (e.code === '23505') throw conflict('You have already reported this message.');
    throw e;
  }
  for (const r of await q<{ person_id: string }>(`select distinct g.person_id from role_grants g join role_permissions rp on rp.role_key = g.role_key where rp.permission_key = 'messaging.moderate' and (g.company_id = $1 or g.company_id is null) and g.revoked_at is null and g.person_id <> $2`, [m.company_id, m.author_id]))
    await notify(pool, r.person_id, m.company_id, 'A message has been reported', '/messages?tab=reports');
  res.status(201).json({ ok: true });
});
messaging.get('/message-reports', async (req, res) => {
  const cs = scope(req.access, 'messaging.moderate', req.query.company);
  const rows = await q(`select r.*, ms.body, ms.created_at as message_at, ${name('au')} as author_name, ${name('rb')} as reported_by_name, co.code as company_code
                          from message_reports r join messages ms on ms.id = r.message_id join conversations c on c.id = ms.conversation_id join companies co on co.id = c.company_id
                          join people au on au.id = ms.author_id join people rb on rb.id = r.reported_by
                         where c.company_id = any($1::uuid[]) and ms.author_id <> $2 order by r.status = 'open' desc, r.created_at desc`, [cs, req.person.id]);
  if (rows.length) await audit(pool, req.person.id, null, 'message_report', null, 'view', { count: rows.length });
  res.json(rows);
});
messaging.post('/message-reports/:id/decide', async (req, res) => {
  const r = await one('select r.*, c.company_id, ms.author_id from message_reports r join messages ms on ms.id = r.message_id join conversations c on c.id = ms.conversation_id where r.id = $1', [idParam(req.params.id)]);
  if (!r) throw notFound();
  need(req.access, 'messaging.moderate', r.company_id);
  if (r.author_id === req.person.id) throw forbidden();
  const b = parse(z.object({ status: z.enum(['actioned', 'no_action']), outcome: text(1000).min(3) }), req.body);
  await q('update message_reports set status = $2, outcome = $3, reviewed_by = $4, reviewed_at = now() where id = $1', [r.id, b.status, b.outcome, req.person.id]);
  await audit(pool, req.person.id, r.company_id, 'message_report', r.id, b.status, {});
  res.json({ ok: true });
});

// ── News ──
// Readers see published posts for their companies; drafts only for the author and publishers of every audience company.
const NEWS_SELECT = `select n.*, ${name('au')} as author_name, au.photo_path is not null as author_has_photo,
    (select array_agg(code order by code) from companies where id = any(n.company_ids)) as company_codes,
    coalesce((select json_agg(json_build_object('id', f.id, 'original_name', f.original_name) order by f.uploaded_at) from files f where f.entity_type = 'news' and f.entity_id = n.id and f.id is distinct from n.image_file_id), '[]') as photos
  from news_posts n join people au on au.id = n.author_id
 where n.company_ids && $1::uuid[] and (n.status = 'published' or (n.status = 'draft' and (n.author_id = $2 or n.company_ids <@ $3::uuid[])))`;
messaging.get('/news', async (req, res) => {
  const a = req.access;
  res.json(await q(`${NEWS_SELECT} order by n.status = 'draft' desc, n.pinned desc, coalesce(n.published_at, n.created_at) desc limit 100`,
    [scope(a, null, req.query.company), a.personId, companiesWith(a, 'news.publish')]));
});
messaging.get('/news/:id', async (req, res) => {
  const a = req.access;
  const n = await one(`${NEWS_SELECT} and n.id = $4`, [scope(a, null, undefined), a.personId, companiesWith(a, 'news.publish'), idParam(req.params.id)]);
  if (!n) throw notFound();
  res.json(n);
});
const newsBody = z.object({ company_ids: z.array(uuid).min(1).max(3), category: z.enum(['update', 'announcement', 'policy', 'training', 'celebration', 'operations', 'other']), title: text(200).min(3), summary: text(300).nullable(), body: text(20000).min(3), image_alt: text(300).nullable(), pinned: z.boolean() }).partial();
async function loadPost(a: Access, id: string) {
  const n = await one('select * from news_posts where id = $1', [id]);
  if (!n || !n.company_ids.every((c: string) => can(a, 'news.publish', c))) throw notFound();
  return n;
}
messaging.post('/news', async (req, res) => {
  const b = parse(newsBody.extend({ company_ids: z.array(uuid).min(1).max(3), category: newsBody.shape.category.unwrap(), title: text(200).min(3), body: text(20000).min(3) }), req.body);
  for (const c of b.company_ids) need(req.access, 'news.publish', c);
  res.status(201).json(await one('insert into news_posts (company_ids, category, title, summary, body, pinned, author_id) values ($1,$2,$3,$4,$5,$6,$7) returning *', [b.company_ids, b.category, b.title, b.summary || null, b.body, b.pinned ?? false, req.person.id]));
});
messaging.patch('/news/:id', async (req, res) => {
  const n = await loadPost(req.access, idParam(req.params.id));
  const b = parse(newsBody.strict(), req.body);
  for (const c of b.company_ids ?? []) need(req.access, 'news.publish', c);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to save.');
  res.json(await one(`update news_posts set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [n.id, ...keys.map((k) => (b as any)[k])]));
});
messaging.post('/news/:id/image', upload.single('file'), async (req, res) => {
  const n = await loadPost(req.access, idParam(req.params.id));
  if (!req.file) throw bad('Choose an image.');
  const alt = parse(text(300).min(3, 'Describe the image'), req.body?.image_alt);
  const f = await tx(async (db) => {
    const f = await saveFile(db, { companyId: n.company_ids[0], entityType: 'news', entityId: n.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true });
    await q('update news_posts set image_file_id = $2, image_alt = $3 where id = $1', [n.id, f.id, alt], db);
    if (n.image_file_id) await deleteFile(db, n.image_file_id); // the old cover would otherwise show up in the gallery
    return f;
  });
  res.status(201).json({ id: f.id });
});
// Gallery: extra photos shown under the article.
messaging.post('/news/:id/photos', upload.single('file'), async (req, res) => {
  const n = await loadPost(req.access, idParam(req.params.id));
  if (!req.file) throw bad('Choose a photo.');
  const c = await one<{ n: number }>(`select count(*)::int n from files where entity_type = 'news' and entity_id = $1 and id is distinct from $2`, [n.id, n.image_file_id]);
  if (c!.n >= 20) throw conflict('A post can have up to 20 gallery photos.');
  const f = await tx((db) => saveFile(db, { companyId: n.company_ids[0], entityType: 'news', entityId: n.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: req.person.id, imagesOnly: true }));
  res.status(201).json({ id: f.id });
});
messaging.delete('/news/:id/photos/:fid', async (req, res) => {
  const n = await loadPost(req.access, idParam(req.params.id));
  const fid = idParam(req.params.fid);
  if (fid === n.image_file_id || !(await one(`select 1 from files where id = $1 and entity_type = 'news' and entity_id = $2`, [fid, n.id]))) throw notFound();
  await tx((db) => deleteFile(db, fid));
  res.json({ ok: true });
});
messaging.post('/news/:id/:step', async (req, res) => {
  const step = parse(z.enum(['publish', 'archive']), req.params.step);
  const n = await loadPost(req.access, idParam(req.params.id));
  await q(`update news_posts set status = $2, published_at = case when $2 = 'published' then coalesce(published_at, now()) else published_at end where id = $1`, [n.id, step === 'publish' ? 'published' : 'archived']);
  await audit(pool, req.person.id, n.company_ids[0], 'news_post', n.id, step, {});
  res.json({ ok: true });
});

// ── Delivery preferences and log ──
messaging.get('/me/preferences', async (req, res) => {
  res.json((await one('select email_enabled, categories from messaging_preferences where person_id = $1', [req.person.id])) ?? { email_enabled: true, categories: ['visit_reminder', 'training_due', 'feedback_ready', 'invoice_available'] });
});
messaging.put('/me/preferences', async (req, res) => {
  const b = parse(z.object({ email_enabled: z.boolean(), categories: z.array(z.enum(['visit_reminder', 'training_due', 'feedback_ready', 'invoice_available'])).max(4) }), req.body);
  await q(`insert into messaging_preferences (person_id, email_enabled, categories) values ($1,$2,$3) on conflict (person_id) do update set email_enabled = excluded.email_enabled, categories = excluded.categories, updated_at = now()`, [req.person.id, b.email_enabled, b.categories]);
  res.json({ ok: true });
});
messaging.get('/outbound', async (req, res) => {
  const cs = scope(req.access, 'messaging.configure', req.query.company);
  if (!cs.length) throw forbidden();
  res.json(await q(`select o.id, o.channel, o.category, o.status, o.attempts, o.last_error, o.created_at, o.updated_at, ${name('p')} as person_name, co.code as company_code
                      from outbound_messages o join people p on p.id = o.person_id left join companies co on co.id = o.company_id where o.company_id = any($1::uuid[]) order by o.created_at desc limit 200`, [cs]));
});
export const unreadMessages = async (personId: string) =>
  (await one<{ n: number }>(`select count(*)::int n from messages ms join conversation_members m on m.conversation_id = ms.conversation_id and m.person_id = $1 and m.left_at is null
                             where ms.author_id <> $1 and ms.created_at > coalesce(m.last_read_at, '-infinity')`, [personId]))!.n;
