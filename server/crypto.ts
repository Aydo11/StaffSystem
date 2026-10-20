// Password hashing (scrypt), random tokens and authenticator-app codes (TOTP, RFC 6238) using only node:crypto.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const scryptAsync = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((ok, fail) => scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? fail(e) : ok(k))));

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${(await scryptAsync(pw, salt, N, R, P)).toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string | null) {
  // A dummy hash keeps the timing the same whether or not the account exists.
  const [, n, r, p, salt, hash] = (stored ?? DUMMY).split('$');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), +n, +r, +p);
  return !!stored && timingSafeEqual(got, Buffer.from(hash, 'base64'));
}
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}
function unbase32(s: string) {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32(randomBytes(20));

export function totpAt(secret: string, step: number, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
// Accepts the current code or one 30 seconds either side (phone clocks drift). Returns the matched step, or null.
export function checkTotp(secret: string, code: string, lastStep: number | null, now = Date.now()) {
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue; // already used: no replay
    const want = totpAt(secret, s);
    if (code.length === want.length && timingSafeEqual(Buffer.from(code), Buffer.from(want))) return s;
  }
  return null;
}
