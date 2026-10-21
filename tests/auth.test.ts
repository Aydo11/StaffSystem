// The Hub's own sign-in: passwords, lockout, invitation/reset links, two-step verification and sessions.
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { base32, checkTotp, hashPassword, totpAt, verifyPassword } from '../server/crypto.ts';
import { app, as, P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const api = () => request(app);
const pw = 'correct horse battery staple';
const tokenFrom = (link: string) => new URLSearchParams(link.split('#')[1]).get('token')!;

describe('crypto', () => {
  it('matches the RFC 6238 SHA-1 test vector and rejects replayed codes', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(secret, 1, 8)).toBe('94287082'); // T = 59 s
    const now = 59_000;
    expect(checkTotp(secret, totpAt(secret, 1), null, now)).toBe(1);
    expect(checkTotp(secret, totpAt(secret, 1), 1, now)).toBeNull(); // same step again
    expect(checkTotp(secret, '000000', null, now)).toBeNull();
  });
  it('hashes passwords with a salt and verifies them', async () => {
    const h = await hashPassword(pw);
    expect(h).not.toContain(pw);
    expect(await hashPassword(pw)).not.toBe(h);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword('wrong password!', h)).toBe(false);
    expect(await verifyPassword(pw, null)).toBe(false);
  });
});

async function setPasswordFor(admin: Awaited<ReturnType<typeof as>>, personId: string) {
  const r = await admin.post(`/api/people/${personId}/access-link`).send({});
  expect(r.status).toBe(200);
  expect(r.body.email).toBe('not_configured');
  return api().post('/api/auth/set-password').send({ token: tokenFrom(r.body.link), password: pw });
}

describe('sign-in', () => {
  it('accepts eight-character passwords for invite, change and reset, and rejects seven', async () => {
    const admin = await as('morgan');
    const link = await admin.post(`/api/people/${P.sam}/access-link`).send({});
    const token = tokenFrom(link.body.link);
    expect((await api().post('/api/auth/set-password').send({ token, password: 'Oaks!72' })).status).toBe(400);
    const set = await api().post('/api/auth/set-password').send({ token, password: 'Oaks!729' });
    expect(set.status).toBe(200);
    const auth = { Authorization: `Bearer ${set.body.token}` };
    expect((await api().post('/api/auth/password').set(auth).send({ current: 'Oaks!729', password: 'Pine!43' })).status).toBe(400);
    expect((await api().post('/api/auth/password').set(auth).send({ current: 'Oaks!729', password: 'Pine!438' })).status).toBe(200);
    const reset = await admin.post(`/api/people/${P.sam}/access-link`).send({});
    expect(reset.body.purpose).toBe('reset');
    expect((await api().post('/api/auth/set-password').send({ token: tokenFrom(reset.body.link), password: 'Elm!9632' })).status).toBe(200);
    expect((await api().post('/api/auth/login').send({ email: 'sam.rivers@example.test', password: 'Elm!9632' })).status).toBe(200);
  });
  it('an invitation link sets a password once, then email + password signs in', async () => {
    const set = await setPasswordFor(await as('morgan'), P.sam);
    expect(set.status).toBe(200);
    expect((await api().get('/api/me').set('Authorization', `Bearer ${set.body.token}`)).status).toBe(200);
    const login = await api().post('/api/auth/login').send({ email: 'SAM.RIVERS@example.test', password: pw });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    // The stored token is a hash, not the token itself.
    expect((await pool.query('select count(*)::int n from sessions where token_hash = $1', [login.body.token])).rows[0].n).toBe(0);
    // Signing out ends that session only.
    const auth = { Authorization: `Bearer ${login.body.token}` };
    await api().post('/api/auth/logout').set(auth);
    expect((await api().get('/api/me').set(auth)).status).toBe(401);
  });

  it('a link works once and every failure looks the same', async () => {
    const admin = await as('morgan');
    const r = await admin.post(`/api/people/${P.sam}/access-link`).send({});
    const token = tokenFrom(r.body.link);
    expect((await api().post('/api/auth/set-password').send({ token, password: pw })).status).toBe(200);
    expect((await api().post('/api/auth/set-password').send({ token, password: pw })).body.error).toBe('link_expired');
    const unknown = await api().post('/api/auth/login').send({ email: 'nobody@example.test', password: pw });
    const wrong = await api().post('/api/auth/login').send({ email: 'sam.rivers@example.test', password: 'not the password' });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('locks the account for 15 minutes after 10 wrong passwords, even with the right one', async () => {
    await setPasswordFor(await as('morgan'), P.sam);
    for (let i = 0; i < 10; i++) await api().post('/api/auth/login').send({ email: 'sam.rivers@example.test', password: `wrong ${i} password` });
    expect((await api().post('/api/auth/login').send({ email: 'sam.rivers@example.test', password: pw })).status).toBe(401);
    await pool.query('update people set locked_until = now() - interval \'1 second\' where id = $1', [P.sam]);
    expect((await api().post('/api/auth/login').send({ email: 'sam.rivers@example.test', password: pw })).status).toBe(200);
  });

  it('privileged roles must set up two-step verification before using the Hub, then need a code at every sign-in', async () => {
    await setPasswordFor(await as('alex'), P.morgan); // hr_admin is privileged
    const first = (await api().post('/api/auth/login').send({ email: 'morgan.hale@example.test', password: pw })).body;
    const auth = { Authorization: `Bearer ${first.token}` };
    expect((await api().get('/api/me').set(auth)).body.mfaRequired).toBe(true);
    expect((await api().get('/api/people').set(auth)).body.error).toBe('mfa_required');
    const setup = (await api().post('/api/auth/mfa/setup').set(auth)).body;
    expect(setup.qr).toMatch(/^data:image\/png/);
    const step = Math.floor(Date.now() / 30000);
    expect((await api().post('/api/auth/mfa/verify').set(auth).send({ code: totpAt(setup.secret, step) })).status).toBe(200);
    expect((await api().get('/api/people').set(auth)).status).toBe(200);

    const next = (await api().post('/api/auth/login').send({ email: 'morgan.hale@example.test', password: pw })).body;
    expect(next.mfa).toBe(true);
    expect(next.token).toBeUndefined();
    expect((await api().post('/api/auth/login/mfa').send({ ticket: next.ticket, code: totpAt(setup.secret, step) })).status).toBe(401); // already used
    const ok = await api().post('/api/auth/login/mfa').send({ ticket: next.ticket, code: totpAt(setup.secret, step + 1) });
    expect(ok.status).toBe(200);
    expect((await api().get('/api/me').set('Authorization', `Bearer ${ok.body.token}`)).body.mfaRequired).toBe(false);
  });
});

describe('access links and secrets', () => {
  it('only a super admin can issue links for privileged people or reset two-step verification', async () => {
    const morgan = await as('morgan');
    expect((await morgan.post(`/api/people/${P.alex}/access-link`).send({})).status).toBe(403);
    expect((await morgan.post(`/api/people/${P.sam}/access-link`).send({ reset_mfa: true, reason: 'new phone' })).status).toBe(403);
    expect((await (await as('sam')).post(`/api/people/${P.casey}/access-link`).send({})).status).toBe(403);
    expect((await (await as('alex')).post(`/api/people/${P.morgan}/access-link`).send({ reset_mfa: true, reason: 'new phone' })).status).toBe(200);
  });
  it('never sends password hashes or authenticator secrets to the browser', async () => {
    await setPasswordFor(await as('morgan'), P.sam);
    const r = await (await as('alex')).get(`/api/people/${P.sam}`);
    expect(r.body.person.has_password).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|totp_secret|scrypt\$/);
  });
});

