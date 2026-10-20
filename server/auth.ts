import type { NextFunction, Request, Response } from 'express';
import { newToken, sha256 } from './crypto.ts';
import { type Db, one, pool, q } from './db.ts';
import { HttpError } from './http.ts';
import { type Access, loadAccess } from './perm.ts';

export type Person = { id: string; email: string; full_name: string; preferred_name: string | null; status: string; photo_path: string | null };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { person: Person; access: Access; mfaRequired: boolean; sessionId: string }
  }
}

export const DEV_AUTH = process.env.DEV_AUTH === 'true';
const SESSION_DAYS = 30;   // absolute limit; a session unused for IDLE_HOURS also ends
const IDLE_HOURS = 30 * 24;

// Sessions are opaque random tokens; only their SHA-256 is stored.
export async function createSession(personId: string, aal: 'aal1' | 'aal2', db: Db = pool) {
  const token = newToken();
  await q(`insert into sessions (person_id, token_hash, aal, expires_at) values ($1, $2, $3, now() + make_interval(days => $4))`, [personId, sha256(token), aal, SESSION_DAYS], db);
  return token;
}

const unauth = () => new HttpError(401, 'unauthenticated', 'Please sign in again.');

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw unauth();
  const s = await one<Person & { session_id: string; aal: string; stale: boolean }>(
    `select s.id as session_id, s.aal, s.last_seen_at < now() - interval '5 minutes' as stale,
            p.id, p.email, p.full_name, p.preferred_name, p.status, p.photo_path
       from sessions s join people p on p.id = s.person_id
      where s.token_hash = $1 and s.expires_at > now() and s.last_seen_at > now() - make_interval(hours => $2)`, [sha256(token), IDLE_HOURS]);
  if (!s) throw unauth();
  if (s.stale) await q('update sessions set last_seen_at = now() where id = $1', [s.session_id]); // throttled: at most one write per 5 minutes
  const { session_id, aal, stale: _stale, ...person } = s;
  if (person.status === 'left') throw new HttpError(403, 'access_ended', 'Your access to the Hub has ended. Please contact your administrator if this is wrong.');
  req.person = person;
  req.sessionId = session_id;
  req.access = await loadAccess(person.id);
  // No current appointment and no unexpired role anywhere (for example once a future-dated leaving date has passed).
  if (!req.access.perms.size && !req.access.agentIds.length && !req.access.superAdmin) throw new HttpError(403, 'no_access', 'You have no current appointment or role in the Hub. If this is wrong, please contact your administrator.');
  req.mfaRequired = req.access.privileged && aal !== 'aal2';
  // Privileged roles must complete two-step verification before doing anything except loading who they are and setting it up.
  const mfaPaths = req.path === '/me' || req.path.startsWith('/auth/');
  if (req.mfaRequired && !mfaPaths) throw new HttpError(403, 'mfa_required', 'Your role needs two-step verification. Please complete it to continue.');
  next();
}

export async function devUsers() {
  return q(`select p.id, p.email, p.full_name, coalesce(string_agg(distinct g.role_key, ', '), 'staff') as roles
              from people p left join role_grants g on g.person_id = p.id and g.revoked_at is null
             where p.is_fictional and p.status <> 'left' group by p.id order by p.staff_ref`);
}
