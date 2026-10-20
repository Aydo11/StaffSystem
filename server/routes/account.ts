// Sign-in, two-step verification, invitations and password resets. Everything here is the Hub's own: no outside identity provider.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { createSession, DEV_AUTH, devUsers } from '../auth.ts';
import { checkTotp, hashPassword, newToken, newTotpSecret, sha256, verifyPassword } from '../crypto.ts';
import { type Db, one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, HttpError, idParam, parse, text } from '../http.ts';
import { emailReady, sendEmail } from '../outbox.ts';
import { can, loadAccess } from '../perm.ts';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const MAX_FAILS = 10, LOCK_MINUTES = 15;
const password = z.string().min(12, 'Use at least 12 characters').max(200);
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
const wrong = () => new HttpError(401, 'auth', `The email or password is not right. After ${MAX_FAILS} wrong attempts, sign-in pauses for ${LOCK_MINUTES} minutes.`);
// Per network address; offices share one, so this is generous. Per-account lockout (above) is the real brute-force guard.
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' } });

async function failed(personId: string) {
  await q(`update people set failed_logins = case when failed_logins + 1 >= $2 then 0 else failed_logins + 1 end,
                             locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end where id = $1`, [personId, MAX_FAILS, LOCK_MINUTES]);
}

// One-time link for an invitation (7 days) or reset (1 hour). The token goes in the URL fragment so it never reaches server logs.
export async function issueAccessLink(db: Db, personId: string, purpose: 'invite' | 'reset') {
  const token = newToken();
  await q(`update auth_tokens set used_at = now() where person_id = $1 and purpose in ('invite','reset') and used_at is null`, [personId], db); // older links stop working
  await q(`insert into auth_tokens (token_hash, person_id, purpose, expires_at) values ($1,$2,$3, now() + $4::interval)`, [sha256(token), personId, purpose, purpose === 'invite' ? '7 days' : '1 hour'], db);
  return `/set-password#token=${token}`; // a path: sendEmail and callers prefix APP_URL
}
// Sent directly, never through the outbox, so links are not stored in the delivery log that admins can read.
export async function sendAccessEmail(email: string, path: string, purpose: 'invite' | 'reset'): Promise<'sent' | 'not_configured' | 'failed'> {
  if (!emailReady()) return 'not_configured';
  const invite = purpose === 'invite';
  try {
    await sendEmail(email, invite ? 'Your Valor & Wellbeing Hub account' : 'Reset your Hub password',
      invite ? 'You have been invited to the Valor & Wellbeing Hub. Use this link within 7 days to choose your password:' : 'Use this link within 1 hour to choose a new password. If you did not ask for this, ignore this email.', path);
    return 'sent';
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'warn', message: 'access email failed', error: String(e?.message ?? e).slice(0, 200) }));
    return 'failed';
  }
}

// ── Public ──
export const authPublic = Router();

authPublic.get('/auth/config', (_req, res) => {
  res.json({ devAuth: DEV_AUTH, helpContact: process.env.HELP_CONTACT || null, selfServiceReset: emailReady() });
});

authPublic.post('/auth/login', limiter, async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().max(254), password: z.string().max(200) }), req.body);
  const p = await one<{ id: string; password_hash: string | null; totp_enabled_at: string | null; locked: boolean }>(
    `select id, password_hash, totp_enabled_at, coalesce(locked_until > now(), false) as locked from people where lower(email) = lower($1) and status <> 'left'`, [b.email]);
  const ok = await verifyPassword(b.password, p?.password_hash ?? null); // always runs, so timing does not reveal which emails exist
  if (!p || p.locked || !ok) { if (p && !p.locked) await failed(p.id); throw wrong(); }
  await q('update people set failed_logins = 0, locked_until = null where id = $1', [p.id]);
  if (p.totp_enabled_at) {
    const ticket = newToken();
    await q(`insert into auth_tokens (token_hash, person_id, purpose, expires_at) values ($1,$2,'mfa', now() + interval '5 minutes')`, [sha256(ticket), p.id]);
    return res.json({ mfa: true, ticket });
  }
  res.json({ token: await createSession(p.id, 'aal1') });
});

authPublic.post('/auth/login/mfa', limiter, async (req, res) => {
  const b = parse(z.object({ ticket: z.string().max(100), code }), req.body);
  const t = await one<{ person_id: string; totp_secret: string; totp_last_step: number | null; locked: boolean }>(
    `select t.person_id, p.totp_secret, p.totp_last_step::int, coalesce(p.locked_until > now(), false) as locked from auth_tokens t join people p on p.id = t.person_id
      where t.token_hash = $1 and t.purpose = 'mfa' and t.used_at is null and t.expires_at > now() and p.status <> 'left' and p.totp_enabled_at is not null`, [sha256(b.ticket)]);
  if (!t) throw new HttpError(401, 'auth', 'Your sign-in timed out. Please enter your email and password again.');
  const step = t.locked ? null : checkTotp(t.totp_secret, b.code, t.totp_last_step);
  if (step === null) { if (!t.locked) await failed(t.person_id); throw new HttpError(401, 'auth', 'That code did not work. Codes change every 30 seconds — try the newest one.', { fields: { code: 'Check the code' } }); }
  const token = await tx(async (db) => {
    await q(`update auth_tokens set used_at = now() where token_hash = $1`, [sha256(b.ticket)], db);
    await q('update people set totp_last_step = $2, failed_logins = 0 where id = $1', [t.person_id, step], db);
    return createSession(t.person_id, 'aal2', db);
  });
  res.json({ token });
});

authPublic.post('/auth/set-password', limiter, async (req, res) => {
  const b = parse(z.object({ token: z.string().max(100), password }), req.body);
  const token = await tx(async (db) => {
    const t = await one<{ person_id: string; email: string }>(
      `update auth_tokens t set used_at = now() from people p where t.token_hash = $1 and t.purpose in ('invite','reset') and t.used_at is null and t.expires_at > now()
          and p.id = t.person_id and p.status <> 'left' returning t.person_id, p.email`, [sha256(b.token)], db);
    if (!t) throw new HttpError(400, 'link_expired', 'This link has expired or has already been used. Ask your administrator for a new one, or use "Forgot your password?".');
    if (b.password.toLowerCase().includes(t.email.split('@')[0].toLowerCase())) throw bad('Please check the highlighted fields.', { fields: { password: 'Do not use your email address in your password' } });
    await q(`update people set password_hash = $2, status = case when status = 'invited' then 'active' else status end, failed_logins = 0, locked_until = null, updated_at = now() where id = $1`,
      [t.person_id, await hashPassword(b.password)], db);
    await q('delete from sessions where person_id = $1', [t.person_id], db); // a reset signs out every other device
    await audit(db, t.person_id, null, 'person', t.person_id, 'password_set', {});
    return createSession(t.person_id, 'aal1', db); // two-step verification still applies after a reset
  });
  res.json({ token });
});

authPublic.post('/auth/forgot', limiter, async (req, res) => {
  const { email } = parse(z.object({ email: z.email() }), req.body);
  const p = await one<{ id: string; email: string }>(`select id, email from people where lower(email) = lower($1) and status <> 'left' and password_hash is not null`, [email]);
  if (p && emailReady()) await sendAccessEmail(p.email, await issueAccessLink(pool, p.id, 'reset'), 'reset');
  res.status(202).json({ ok: true }); // same answer either way, so the form does not reveal which emails have accounts
});

if (DEV_AUTH) {
  authPublic.get('/dev/users', async (_req, res) => res.json(await devUsers()));
  authPublic.post('/dev/login', async (req, res) => {
    const { email } = parse(z.object({ email: z.email() }), req.body);
    const p = await one<{ id: string }>(`select id from people where lower(email) = lower($1) and is_fictional and status <> 'left'`, [email]);
    if (!p) throw new HttpError(401, 'unauthenticated', 'That demo account does not exist.');
    res.json({ token: await createSession(p.id, 'aal2') });
  });
}

// ── Signed in ──
export const account = Router();

account.post('/auth/logout', async (req, res) => {
  await q('delete from sessions where id = $1', [req.sessionId]);
  res.json({ ok: true });
});

account.post('/auth/mfa/setup', async (req, res) => {
  const p = (await one<{ totp_enabled_at: string | null }>('select totp_enabled_at from people where id = $1', [req.person.id]))!;
  if (p.totp_enabled_at) return res.json({ enabled: true });
  const secret = newTotpSecret();
  await q('update people set totp_secret = $2 where id = $1', [req.person.id, secret]);
  const uri = `otpauth://totp/${encodeURIComponent(`Valor & Wellbeing Hub:${req.person.email}`)}?secret=${secret}&issuer=${encodeURIComponent('Valor & Wellbeing Hub')}`;
  res.json({ enabled: false, secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
});

account.post('/auth/mfa/verify', limiter, async (req, res) => {
  const b = parse(z.object({ code }), req.body);
  const p = (await one<{ totp_secret: string | null; totp_last_step: number | null }>('select totp_secret, totp_last_step::int from people where id = $1', [req.person.id]))!;
  if (!p.totp_secret) throw bad('Set up your authenticator app first.');
  const step = checkTotp(p.totp_secret, b.code, p.totp_last_step);
  if (step === null) throw new HttpError(400, 'auth', 'That code did not work. Codes change every 30 seconds — try the newest one.', { fields: { code: 'Check the code' } });
  await tx(async (db) => {
    await q('update people set totp_enabled_at = coalesce(totp_enabled_at, now()), totp_last_step = $2 where id = $1', [req.person.id, step], db);
    await q(`update sessions set aal = 'aal2' where id = $1`, [req.sessionId], db);
    await audit(db, req.person.id, null, 'person', req.person.id, 'mfa_verified', {});
  });
  res.json({ ok: true });
});

account.post('/auth/password', limiter, async (req, res) => {
  const b = parse(z.object({ current: z.string().max(200), password }), req.body);
  const p = (await one<{ password_hash: string | null }>('select password_hash from people where id = $1', [req.person.id]))!;
  if (!(await verifyPassword(b.current, p.password_hash))) throw bad('Please check the highlighted fields.', { fields: { current: 'Your current password is not right' } });
  await tx(async (db) => {
    await q('update people set password_hash = $2, updated_at = now() where id = $1', [req.person.id, await hashPassword(b.password)], db);
    await q('delete from sessions where person_id = $1 and id <> $2', [req.person.id, req.sessionId], db);
    await audit(db, req.person.id, null, 'person', req.person.id, 'password_changed', {});
  });
  res.json({ ok: true });
});

// An administrator issues a fresh invitation or reset link (and, super admins only, clears two-step verification for a lost phone).
account.post('/people/:id/access-link', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ reset_mfa: z.boolean().default(false), reason: text(500).optional() }), req.body);
  const target = await one<{ id: string; email: string; status: string; password_hash: string | null }>('select id, email, status, password_hash from people where id = $1', [id]);
  if (!target) throw forbidden();
  const cos = (await q<{ company_id: string }>('select distinct company_id from appointments where person_id = $1', [id])).map((r) => r.company_id);
  if (!req.access.superAdmin && !cos.some((c) => can(req.access, 'staff.create', c))) throw forbidden();
  if (target.status === 'left') throw conflict('This person has left. Their access cannot be restored with a link.');
  const t = await loadAccess(id);
  // Only a super admin can reset access for someone holding a privileged role, so a lesser admin cannot take over a stronger account.
  if ((t.privileged || t.superAdmin || b.reset_mfa) && !req.access.superAdmin) throw forbidden();
  if (b.reset_mfa && (!b.reason || b.reason.length < 5)) throw bad('Say why two-step verification is being reset.', { fields: { reason: 'Required' } });
  if (id === req.person.id) throw conflict('Use "Change password" on your own profile instead.');
  const purpose = target.password_hash ? 'reset' : 'invite';
  const link = await tx(async (db) => {
    if (b.reset_mfa) await q('update people set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1', [id], db);
    if (b.reset_mfa) await q('delete from sessions where person_id = $1', [id], db);
    await audit(db, req.person.id, null, 'person', id, purpose === 'invite' ? 'invite_link' : 'reset_link', { reset_mfa: b.reset_mfa, reason: b.reason ?? null });
    return issueAccessLink(db, id, purpose);
  });
  res.json({ link: APP_URL + link, purpose, email: await sendAccessEmail(target.email, link, purpose) });
});
