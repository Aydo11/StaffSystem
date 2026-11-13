// Rooms and voids (migration 050). A property's manager sees and updates its rooms; voids.view_all / voids.manage_all give a
// company-wide overview / update; super administrators have both everywhere. Every check runs here, on the server.
import { Router } from 'express';
import { z } from 'zod';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, HttpError, idParam, notFound, parse, text, uuid } from '../http.ts';
import { type Access, can, companiesWith, myCompanies } from '../perm.ts';
import { deleteFile, saveFile } from '../storage.ts';
import { upload } from './people.ts';

export const voids = Router();
const SIZES = ['single', 'double'] as const;
const BATHS = ['ensuite', 'shared'] as const;
const FLOORS = ['lower_ground', 'ground', 'first', 'second', 'third_plus'] as const;
const STATUSES = ['not_set', 'available', 'filled', 'unavailable'] as const;
type Status = (typeof STATUSES)[number];
const name = (al: string) => `coalesce(${al}.preferred_name, ${al}.full_name)`;

const isManager = (a: Access, p: { manager_person_id: string | null; company_id: string }) => p.manager_person_id === a.personId && a.perms.has(p.company_id);
export const canViewRooms = (a: Access, p: { manager_person_id: string | null; company_id: string }) => can(a, 'voids.view_all', p.company_id) || isManager(a, p);
export const canEditRooms = (a: Access, p: { manager_person_id: string | null; company_id: string }) => can(a, 'voids.manage_all', p.company_id) || isManager(a, p);
/** SQL: properties alias `p` this person may see rooms for. Parameters: $me, $viewAll (uuid[]), $mine (uuid[]). */
const VISIBLE = (me: number, all: number, mine: number) => `(p.company_id = any($${all}::uuid[]) or (p.manager_person_id = $${me} and p.company_id = any($${mine}::uuid[])))`;
/** Does this person see any rooms at all (for the menu)? */
export async function hasVoidsAccess(a: Access) {
  return companiesWith(a, 'voids.view_all').length > 0
    || !!(await one(`select 1 from properties p where p.manager_person_id = $1 and p.company_id = any($2::uuid[]) and p.status <> 'offboarded' limit 1`, [a.personId, myCompanies(a)]));
}

async function loadProperty(a: Access, id: string) {
  const p = await one(`select p.id, p.name, p.ref, p.company_id, p.manager_person_id, p.status, c.name as company_name, c.code as company_code
                         from properties p join companies c on c.id = p.company_id where p.id = $1`, [id]);
  if (!p || !canViewRooms(a, p)) throw notFound(); // never reveal that someone else's property exists
  return p;
}
async function loadRoom(a: Access, id: string, db: Db = pool) {
  const r = await one(`select r.*, p.manager_person_id, p.name as property_name, p.ref as property_ref from property_rooms r join properties p on p.id = r.property_id
                        where r.id = $1 and r.archived_at is null`, [id], db);
  if (!r || !canViewRooms(a, r)) throw notFound();
  return r;
}
const needEdit = (a: Access, p: any) => { if (!canEditRooms(a, p)) throw forbidden('You can view these rooms but not change them.'); };
const complete = (r: any) => !!(r.size && r.bathroom && r.floor);

const ROOM_COLS = `r.id, r.property_id, r.company_id, r.label, r.position, r.status, r.size, r.bathroom, r.floor, r.description, r.access_notes,
  r.unavailable_reason, r.status_changed_at, r.version, r.updated_at,
  (select v.started_at from room_voids v where v.room_id = r.id and v.ended_at is null) as void_started_at,
  (select count(*) from room_photos ph where ph.room_id = r.id)::int as photo_count,
  (select ph.file_id from room_photos ph where ph.room_id = r.id order by ph.added_at limit 1) as photo_id`;
const roomRow = (id: string, db: Db = pool) => one(`select ${ROOM_COLS} from property_rooms r where r.id = $1`, [id], db);

/** The one place a room's status changes: optimistic lock, void period, history row. */
async function setStatus(db: Db, room: any, to: Status, actor: string, opts: { version: number; reason?: string | null; undoOf?: number; reopenVoid?: string | null }) {
  const from = room.status as Status;
  if (to === 'available' && !complete(room)) throw bad('Choose the room size, bathroom and floor before marking it available.', { fields: { size: room.size ? undefined : 'Required', bathroom: room.bathroom ? undefined : 'Required', floor: room.floor ? undefined : 'Required' }, code: 'needs_details' });
  const upd = await one(`update property_rooms set status = $3, unavailable_reason = $4, status_changed_at = now(), version = version + 1, updated_at = now()
                          where id = $1 and version = $2 returning version`, [room.id, opts.version, to, to === 'unavailable' ? opts.reason || null : null], db);
  if (!upd) throw await staleError(db, room.id);
  let voidId: string | null = null;
  if (from !== 'available' && to === 'available') {
    // Undoing "filled" carries on the same void; otherwise a new void starts.
    const reopened = opts.reopenVoid ? await one(`update room_voids set ended_at = null, ended_by = null, outcome = null where id = $1 and room_id = $2 and ended_at is not null
                                                   and not exists (select 1 from room_voids o where o.room_id = $2 and o.ended_at is null) returning id`, [opts.reopenVoid, room.id], db) : null;
    voidId = reopened?.id ?? (await one('insert into room_voids (room_id, started_by) values ($1,$2) returning id', [room.id, actor], db))!.id;
  } else if (from === 'available' && to !== 'available') {
    voidId = (await one(`update room_voids set ended_at = now(), ended_by = $2, outcome = $3 where room_id = $1 and ended_at is null returning id`, [room.id, actor, to], db))?.id ?? null;
  }
  const ev = await one<{ id: number }>(`insert into room_events (room_id, actor_id, kind, from_value, to_value, undo_of) values ($1,$2,'status',$3,$4,$5) returning id`,
    [room.id, actor, JSON.stringify({ status: from }), JSON.stringify({ status: to, ...(voidId ? { void_id: voidId } : {}), ...(to === 'unavailable' && opts.reason ? { reason: opts.reason } : {}) }), opts.undoOf ?? null], db);
  return ev!.id;
}
/** A newer change was saved first: say who and what, and send the fresh room so the card can refresh. */
async function staleError(db: Db, roomId: string) {
  const r = await roomRow(roomId, db);
  const last = await one(`select e.at, ${name('p')} as who from room_events e left join people p on p.id = e.actor_id where e.room_id = $1 order by e.id desc limit 1`, [roomId], db);
  return new HttpError(409, 'stale', `${r?.label ?? 'This room'} was changed${last?.who ? ` by ${last.who}` : ''} just before you. It now shows ${LABEL[r?.status as Status] ?? 'its latest status'}. Check it and try again if you still need to.`, { room: r });
}
const LABEL: Record<Status, string> = { not_set: 'Status not set', available: 'Available', filled: 'Filled', unavailable: 'Temporarily unavailable' };

// ── Overview across the properties this person may see ──
voids.get('/voids', async (req, res) => {
  const a = req.access;
  const f = parse(z.object({ company: uuid.optional(), property: uuid.optional(), size: z.enum(SIZES).optional(), bathroom: z.enum(BATHS).optional(),
    floor: z.enum(FLOORS).optional(), available: z.enum(['1', 'true']).optional() }), req.query);
  const params = [a.personId, companiesWith(a, 'voids.view_all'), myCompanies(a), f.company ?? null, f.property ?? null];
  const where = `${VISIBLE(1, 2, 3)} and p.status <> 'offboarded' and ($4::uuid is null or p.company_id = $4) and ($5::uuid is null or p.id = $5)`;
  const properties = await q(`select p.id, p.name, p.ref, p.company_id, c.name as company_name, c.code as company_code,
      count(r.id)::int as total, count(r.id) filter (where r.status = 'available')::int as available, count(r.id) filter (where r.status = 'filled')::int as filled,
      count(r.id) filter (where r.status = 'unavailable')::int as unavailable, count(r.id) filter (where r.status = 'not_set')::int as not_set
    from properties p join companies c on c.id = p.company_id left join property_rooms r on r.property_id = p.id and r.archived_at is null
   where ${where} group by p.id, c.id order by c.name, p.name`, params);
  const rooms = await q(`select ${ROOM_COLS}, p.name as property_name, p.ref as property_ref, c.code as company_code
    from property_rooms r join properties p on p.id = r.property_id join companies c on c.id = p.company_id
   where r.archived_at is null and ${where} and ($6::text is null or r.size = $6) and ($7::text is null or r.bathroom = $7) and ($8::text is null or r.floor = $8)
     and (not $9 or r.status = 'available') order by (r.status = 'available') desc, p.name, r.position limit 500`,
    [...params, f.size ?? null, f.bathroom ?? null, f.floor ?? null, !!f.available]);
  const sum = (k: string) => properties.reduce((n: number, p: any) => n + p[k], 0);
  const companies = await q(`select distinct c.id, c.name, c.code from properties p join companies c on c.id = p.company_id where ${VISIBLE(1, 2, 3)} and p.status <> 'offboarded' order by c.name`, params.slice(0, 3));
  res.json({ totals: { rooms: sum('total'), available: sum('available'), filled: sum('filled'), unavailable: sum('unavailable'), not_set: sum('not_set') },
             properties, rooms, companies, can: { overview: companiesWith(a, 'voids.view_all').length > 0 } });
});

// ── One property's rooms ──
voids.get('/properties/:id/rooms', async (req, res) => {
  const p = await loadProperty(req.access, idParam(req.params.id));
  const rooms = await q(`select ${ROOM_COLS} from property_rooms r where r.property_id = $1 and r.archived_at is null order by r.position, r.label`, [p.id]);
  res.json({ property: p, rooms, can: { edit: canEditRooms(req.access, p) } });
});

// First setup: "How many rooms does this property have?" → Room 1 … Room n, all "Status not set".
voids.post('/properties/:id/rooms', async (req, res) => {
  const a = req.access;
  const p = await loadProperty(a, idParam(req.params.id));
  needEdit(a, p);
  const { count } = parse(z.object({ count: z.number().int().min(1).max(200) }), req.body);
  await tx(async (db) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`rooms:${p.id}`], db);
    if (await one('select 1 from property_rooms where property_id = $1 and archived_at is null', [p.id], db)) throw conflict('This property already has rooms. Use "Change number of rooms" instead.');
    await addRooms(db, p, count, a.personId);
    await audit(db, a.personId, p.company_id, 'property', p.id, 'rooms_setup', { count });
  });
  res.status(201).json({ ok: true });
});
async function addRooms(db: Db, p: any, n: number, actor: string) {
  const taken = new Set((await q<{ l: string }>('select lower(trim(label)) l from property_rooms where property_id = $1 and archived_at is null', [p.id], db)).map((r) => r.l));
  let pos = (await one<{ m: number }>('select coalesce(max(position), 0)::int m from property_rooms where property_id = $1', [p.id], db))!.m;
  for (let k = 1, made = 0; made < n; k++) {
    if (taken.has(`room ${k}`)) continue;
    const r = await one('insert into property_rooms (company_id, property_id, label, position, created_by) values ($1,$2,$3,$4,$5) returning id', [p.company_id, p.id, `Room ${k}`, ++pos, actor], db);
    await q(`insert into room_events (room_id, actor_id, kind, to_value) values ($1,$2,'created',$3)`, [r.id, actor, JSON.stringify({ label: `Room ${k}` })], db);
    made++;
  }
}

// Change the total. More rooms: added. Fewer: the manager chooses which to archive; their history stays.
voids.post('/properties/:id/rooms/total', async (req, res) => {
  const a = req.access;
  const p = await loadProperty(a, idParam(req.params.id));
  needEdit(a, p);
  const b = parse(z.object({ count: z.number().int().min(1).max(200), archive_ids: z.array(uuid).max(200).optional() }), req.body);
  await tx(async (db) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`rooms:${p.id}`], db);
    const active = await q('select * from property_rooms where property_id = $1 and archived_at is null', [p.id], db);
    if (b.count > active.length) await addRooms(db, p, b.count - active.length, a.personId);
    if (b.count < active.length) {
      const ids = [...new Set(b.archive_ids ?? [])];
      if (ids.length !== active.length - b.count || !ids.every((id) => active.some((r: any) => r.id === id)))
        throw bad(`Choose exactly ${active.length - b.count} room${active.length - b.count === 1 ? '' : 's'} to archive.`, { fields: { archive_ids: 'Choose which rooms to archive' } });
      for (const id of ids) {
        const r = active.find((x: any) => x.id === id);
        await q(`update property_rooms set archived_at = now(), archived_by = $2, version = version + 1, updated_at = now() where id = $1`, [id, a.personId], db);
        await q(`update room_voids set ended_at = now(), ended_by = $2, outcome = 'archived' where room_id = $1 and ended_at is null`, [id, a.personId], db);
        await q(`insert into room_events (room_id, actor_id, kind, from_value) values ($1,$2,'archived',$3)`, [id, a.personId, JSON.stringify({ label: r.label, status: r.status })], db);
      }
    }
    await audit(db, a.personId, p.company_id, 'property', p.id, 'rooms_total', { from: active.length, to: b.count });
  });
  res.json({ ok: true });
});

// Several rooms at once, for setting first statuses. Rooms without size, bathroom and floor are reported, not made available.
voids.post('/properties/:id/rooms/status', async (req, res) => {
  const a = req.access;
  const p = await loadProperty(a, idParam(req.params.id));
  needEdit(a, p);
  const b = parse(z.object({ status: z.enum(['available', 'filled']), rooms: z.array(z.object({ id: uuid, version: z.number().int() })).min(1).max(200) }), req.body);
  const out = { updated: [] as string[], needs_details: [] as string[], conflicts: [] as string[] };
  await tx(async (db) => {
    for (const x of b.rooms) {
      const r = await one('select * from property_rooms where id = $1 and property_id = $2 and archived_at is null', [x.id, p.id], db);
      if (!r) continue;
      if (r.version !== x.version) { out.conflicts.push(r.id); continue; }
      if (r.status === b.status) continue;
      if (b.status === 'available' && !complete(r)) { out.needs_details.push(r.id); continue; }
      await setStatus(db, r, b.status, a.personId, { version: x.version });
      out.updated.push(r.id);
    }
  });
  res.json(out);
});

// ── One room ──
voids.get('/rooms/:id', async (req, res) => {
  const a = req.access;
  const r = await loadRoom(a, idParam(req.params.id));
  const [room, photos, history] = await Promise.all([
    roomRow(r.id),
    q('select f.id, f.original_name, ph.added_at from room_photos ph join files f on f.id = ph.file_id where ph.room_id = $1 order by ph.added_at', [r.id]),
    q(`select e.id, e.kind, e.at, e.from_value, e.to_value, e.undo_of, ${name('p')} as actor_name from room_events e left join people p on p.id = e.actor_id
        where e.room_id = $1 order by e.id desc limit 50`, [r.id]),
  ]);
  res.json({ room, property: { id: r.property_id, name: r.property_name, ref: r.property_ref }, photos, history, can: { edit: canEditRooms(a, r) } });
});

const detailsBody = z.object({
  version: z.number().int(),
  label: text(40).min(1).optional(),
  size: z.enum(SIZES).nullable().optional(), bathroom: z.enum(BATHS).nullable().optional(), floor: z.enum(FLOORS).nullable().optional(),
  description: text(600).nullable().optional(), access_notes: text(600).nullable().optional(),
  status: z.enum(STATUSES).optional(), reason: text(200).nullable().optional(),
});
// Details and/or status in one save (so "choose size, bathroom, floor → available" is one action).
voids.patch('/rooms/:id', async (req, res) => {
  const a = req.access;
  const b = parse(detailsBody, req.body);
  const out = await tx(async (db) => {
    const r = await loadRoom(a, idParam(req.params.id), db);
    needEdit(a, r);
    if (r.version !== b.version) throw await staleError(db, r.id);
    let version = b.version;
    const fields = (['label', 'size', 'bathroom', 'floor', 'description', 'access_notes'] as const).filter((k) => b[k] !== undefined && (b[k] || null) !== (r[k] || null));
    if (fields.length) {
      const next: any = Object.fromEntries(fields.map((k) => [k, k === 'label' ? b.label!.trim() : b[k] || null]));
      if (r.status === 'available' && (['size', 'bathroom', 'floor'] as const).some((k) => k in next && !next[k])) throw bad('An available room needs its size, bathroom and floor.');
      if (next.label && (await one('select 1 from property_rooms where property_id = $1 and archived_at is null and id <> $2 and lower(trim(label)) = lower($3)', [r.property_id, r.id, next.label], db)))
        throw bad('Another room in this property already has that name.', { fields: { label: 'Already used' } });
      const upd = await one(`update property_rooms set ${fields.map((k, i) => `${k} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now()
                              where id = $1 and version = $2 returning version`, [r.id, version, ...fields.map((k) => next[k])], db);
      if (!upd) throw await staleError(db, r.id);
      version = upd.version;
      const before = Object.fromEntries(fields.map((k) => [k, r[k] ?? null]));
      await q(`insert into room_events (room_id, actor_id, kind, from_value, to_value) values ($1,$2,$3,$4,$5)`,
        [r.id, a.personId, fields.length === 1 && fields[0] === 'label' ? 'label' : 'details', JSON.stringify(before), JSON.stringify(next)], db);
      Object.assign(r, next);
    }
    let eventId: number | null = null;
    if (b.status && b.status !== r.status) eventId = await setStatus(db, r, b.status, a.personId, { version, reason: b.reason });
    return { room: await roomRow(r.id, db), event_id: eventId };
  });
  res.json(out);
});

// Undo the last status change: allowed for the person who made it, for 15 minutes, while it is still the latest change.
voids.post('/rooms/:id/undo', async (req, res) => {
  const a = req.access;
  const b = parse(z.object({ event_id: z.number().int(), version: z.number().int() }), req.body);
  const out = await tx(async (db) => {
    const r = await loadRoom(a, idParam(req.params.id), db);
    needEdit(a, r);
    const ev = await one(`select * from room_events where id = $1 and room_id = $2 and kind = 'status'`, [b.event_id, r.id], db);
    if (!ev || ev.actor_id !== a.personId || Date.now() - new Date(ev.at).getTime() > 15 * 60_000) throw conflict('That change can no longer be undone here. Change the status instead.');
    const later = await one(`select 1 from room_events where room_id = $1 and id > $2 and kind in ('status','archived')`, [r.id, ev.id], db);
    if (later || r.status !== ev.to_value.status) throw await staleError(db, r.id);
    const eventId = await setStatus(db, r, ev.from_value.status, a.personId, { version: b.version, undoOf: ev.id, reopenVoid: ev.to_value.void_id ?? null });
    return { room: await roomRow(r.id, db), event_id: eventId };
  });
  res.json(out);
});

// ── Photos: private, served through /files/:id with the same check ──
voids.post('/rooms/:id/photos', upload.single('file'), async (req, res) => {
  const a = req.access;
  const r = await loadRoom(a, idParam(req.params.id));
  needEdit(a, r);
  if (!req.file) throw bad('Choose a photo.');
  const replace = req.body?.replace ? idParam(req.body.replace) : null;
  const f = await tx(async (db) => {
    const n = (await one<{ n: number }>('select count(*)::int n from room_photos where room_id = $1', [r.id], db))!.n;
    if (n - (replace ? 1 : 0) >= 6) throw bad('Up to 6 photos for each room. Remove one first.');
    const saved = await saveFile(db, { companyId: r.company_id, entityType: 'room', entityId: r.id, name: req.file!.originalname, buf: req.file!.buffer, uploadedBy: a.personId, imagesOnly: true });
    await q('insert into room_photos (file_id, room_id) values ($1,$2)', [saved.id, r.id], db);
    await q(`insert into room_events (room_id, actor_id, kind, to_value) values ($1,$2,'photo_added',$3)`, [r.id, a.personId, JSON.stringify({ file_id: saved.id })], db);
    if (replace) await removePhoto(db, r, replace, a.personId);
    return saved;
  });
  res.status(201).json({ id: f.id, original_name: f.original_name });
});
async function removePhoto(db: Db, r: any, fileId: string, actor: string) {
  if (!(await one('select 1 from room_photos where file_id = $1 and room_id = $2', [fileId, r.id], db))) throw notFound();
  await deleteFile(db, fileId);
  await q(`insert into room_events (room_id, actor_id, kind, from_value) values ($1,$2,'photo_removed',$3)`, [r.id, actor, JSON.stringify({ file_id: fileId })], db);
}
voids.delete('/rooms/:id/photos/:fid', async (req, res) => {
  const a = req.access;
  const r = await loadRoom(a, idParam(req.params.id));
  needEdit(a, r);
  await tx((db) => removePhoto(db, r, idParam(req.params.fid), a.personId));
  res.json({ ok: true });
});
/** For GET /files/:id. */
export async function roomPhotoVisible(a: Access, fileId: string) {
  const r = await one(`select p.company_id, p.manager_person_id from room_photos ph join property_rooms r on r.id = ph.room_id join properties p on p.id = r.property_id
                        where ph.file_id = $1 and r.archived_at is null`, [fileId]);
  return !!r && canViewRooms(a, r);
}
