import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { one, q } from './db.ts';
import { HttpError } from './http.ts';
import { type Access, loadAccess } from './perm.ts';

export type Person = { id: string; email: string; full_name: string; preferred_name: string | null; status: string; photo_path: string | null };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { person: Person; access: Access; mfaRequired: boolean }
  }
}

export const DEV_AUTH = process.env.DEV_AUTH === 'true';
const DEV_ISSUER = 'hub-dev-auth';
// Dev-only signing key. DEV_AUTH is refused in production (see index.ts), so this never signs real sessions.
const devKey = new TextEncoder().encode(process.env.DEV_AUTH_SECRET ?? 'local-development-only-not-a-secret');
const sbSecret = process.env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET) : null;
const jwks = process.env.SUPABASE_URL ? createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) : null;

export async function signDevToken(person: { id: string; email: string }) {
  return new SignJWT({ email: person.email, aal: 'aal2', dev: true })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(DEV_ISSUER).setSubject(person.id).setIssuedAt().setExpirationTime('12h').sign(devKey);
}

async function verify(token: string): Promise<{ claims: JWTPayload & { email?: string; aal?: string }; dev: boolean }> {
  if (DEV_AUTH) {
    try {
      const { payload } = await jwtVerify(token, devKey, { issuer: DEV_ISSUER });
      return { claims: payload as any, dev: true };
    } catch { /* fall through to Supabase */ }
  }
  if (sbSecret) return { claims: (await jwtVerify(token, sbSecret, { audience: 'authenticated' })).payload as any, dev: false };
  if (jwks) return { claims: (await jwtVerify(token, jwks, { audience: 'authenticated' })).payload as any, dev: false };
  throw new Error('no verifier configured');
}

const unauth = () => new HttpError(401, 'unauthenticated', 'Please sign in again.');

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw unauth();
  let v;
  try { v = await verify(token); } catch { throw unauth(); }
  const { claims, dev } = v;
  const cols = 'id, email, full_name, preferred_name, status, photo_path';
  let person = dev
    ? await one<Person>(`select ${cols} from people where id = $1`, [claims.sub])
    : await one<Person>(`select ${cols} from people where auth_user_id = $1`, [claims.sub]);
  if (!person && !dev && claims.email) {
    // First sign-in after accepting an invitation: link by email (only to a profile not yet linked).
    person = await one<Person>(`update people set auth_user_id = $1, status = case when status = 'invited' then 'active' else status end, updated_at = now()
                                 where lower(email) = lower($2) and auth_user_id is null returning ${cols}`, [claims.sub, claims.email]);
  }
  if (!person) throw new HttpError(403, 'no_profile', 'Your sign-in worked, but there is no staff profile for this email. Please contact your administrator.');
  if (person.status === 'left') throw new HttpError(403, 'access_ended', 'Your access to the Hub has ended. Please contact your administrator if this is wrong.');
  req.person = person;
  req.access = await loadAccess(person.id);
  // No current appointment and no unexpired role anywhere (for example once a future-dated leaving date has passed).
  if (!req.access.perms.size && !req.access.agentIds.length) throw new HttpError(403, 'no_access', 'You have no current appointment or role in the Hub. If this is wrong, please contact your administrator.');
  req.mfaRequired = req.access.privileged && claims.aal !== 'aal2';
  // Privileged roles must complete MFA before doing anything except loading who they are.
  if (req.mfaRequired && !(req.method === 'GET' && req.path === '/me')) throw new HttpError(403, 'mfa_required', 'Your role needs two-step verification. Please complete it to continue.');
  next();
}

export async function devUsers() {
  return q(`select p.id, p.email, p.full_name, coalesce(string_agg(distinct g.role_key, ', '), 'staff') as roles
              from people p left join role_grants g on g.person_id = p.id and g.revoked_at is null
             where p.is_fictional and p.status <> 'left' group by p.id order by p.staff_ref`);
}
