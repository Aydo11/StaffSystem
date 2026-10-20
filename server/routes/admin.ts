import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q } from '../db.ts';
import { audit, bad, forbidden, notFound, notify, parse, text, uuid, idParam } from '../http.ts';
import { companiesWith, need } from '../perm.ts';

export const admin = Router();
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

admin.get('/admin/roles', async (_req, res) => {
  res.json({
    roles: await q(`select r.*, coalesce(array_agg(rp.permission_key order by rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
                      from roles r left join role_permissions rp on rp.role_key = r.key group by r.key order by r.privileged desc, r.label`),
    permissions: await q('select * from permissions order by key'),
  });
});

// Access review: every explicit grant with who gave it, why, and when it expires.
admin.get('/admin/grants', async (req, res) => {
  const cs = companiesWith(req.access, 'access.manage');
  if (!cs.length) throw forbidden();
  res.json(await q(`select g.*, r.label as role_label, r.privileged, ${name('p')} as person_name, p.email, p.status as person_status, c.name as company_name, c.code as company_code, ${name('gb')} as granted_by_name,
                           (g.revoked_at is null and (g.expires_at is null or g.expires_at > now())) as active
                      from role_grants g join roles r on r.key = g.role_key join people p on p.id = g.person_id left join companies c on c.id = g.company_id left join people gb on gb.id = g.granted_by
                     where (g.company_id = any($1::uuid[]) or ($2 and g.company_id is null)) order by active desc, c.name nulls first, p.full_name`, [cs, req.access.superAdmin]));
});

admin.post('/admin/grants', async (req, res) => {
  const b = parse(z.object({ person_id: uuid, role_key: z.string(), company_id: uuid.nullable(), expires_at: z.iso.datetime({ offset: true }).nullable().optional(), reason: text(300).min(3) }), req.body);
  if (b.role_key === 'super_admin') {
    if (!req.access.superAdmin) throw forbidden('Only a super administrator can grant super administrator.');
    if (b.company_id) throw bad('Super administrator applies to all companies.');
  } else {
    if (!b.company_id) throw bad('Choose a company.', { fields: { company_id: 'Required' } });
    need(req.access, 'access.manage', b.company_id);
  }
  if (b.person_id === req.person.id) throw forbidden('You cannot change your own access.');
  const role = await one('select * from roles where key = $1', [b.role_key]);
  if (!role) throw bad('Unknown role.');
  if (b.role_key === 'reviewer' && !b.expires_at) throw bad('Time-limited reviewer access must have an end date.', { fields: { expires_at: 'Required' } });
  if (b.expires_at && new Date(b.expires_at) <= new Date()) throw bad('The end date must be in the future.', { fields: { expires_at: 'In the past' } });
  const person = await one(`select id from people where id = $1 and status <> 'left'`, [b.person_id]);
  if (!person) throw notFound();
  const g = await one('insert into role_grants (person_id, role_key, company_id, expires_at, granted_by, reason) values ($1,$2,$3,$4,$5,$6) returning *', [b.person_id, b.role_key, b.company_id, b.expires_at ?? null, req.person.id, b.reason]);
  await audit(pool, req.person.id, b.company_id, 'role_grant', g.id, 'grant', { person_id: b.person_id, role_key: b.role_key, expires_at: b.expires_at ?? null });
  await notify(pool, b.person_id, b.company_id, `You were given the ${role.label} role${role.privileged ? ' — two-step verification is now required' : ''}`, null);
  res.status(201).json(g);
});

admin.post('/admin/grants/:id/revoke', async (req, res) => {
  const id = idParam(req.params.id);
  const g = await one('select * from role_grants where id = $1', [id]);
  if (!g) throw notFound();
  if (g.company_id) need(req.access, 'access.manage', g.company_id); else if (!req.access.superAdmin) throw forbidden();
  if (g.person_id === req.person.id) throw forbidden('You cannot change your own access.');
  await q('update role_grants set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null', [id, req.person.id]);
  await audit(pool, req.person.id, g.company_id, 'role_grant', id, 'revoke', { person_id: g.person_id, role_key: g.role_key });
  res.json({ ok: true });
});

admin.get('/audit', async (req, res) => {
  const cs = companiesWith(req.access, 'audit.view');
  if (!cs.length) throw forbidden();
  const company = req.query.company ? parse(uuid, req.query.company) : null;
  const before = req.query.before ? parse(z.coerce.number().int(), req.query.before) : null;
  res.json(await q(`select l.id, l.at, l.entity, l.entity_id, l.action, l.detail, l.company_id, c.code as company_code, ${name('p')} as actor_name
                      from audit_log l left join companies c on c.id = l.company_id left join people p on p.id = l.actor_person_id
                     where (l.company_id = any($1::uuid[]) or ($2 and l.company_id is null)) and ($3::uuid is null or l.company_id = $3) and ($4::bigint is null or l.id < $4)
                     order by l.id desc limit 100`, [cs, req.access.superAdmin, company, before]));
});
