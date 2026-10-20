import { readdirSync, readFileSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../server/app.ts';
import { pool } from '../server/db.ts';

if (!/hub_test|_test\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Tests must run against a *_test database');

export const app = createApp();
export const C = { VH: '00000000-0000-4000-8000-0000000000c1', WHM: '00000000-0000-4000-8000-0000000000c2', WHS: '00000000-0000-4000-8000-0000000000c3' };
export const P = { alex: '00000000-0000-4000-8000-000000000a01', sam: '00000000-0000-4000-8000-000000000a02', priya: '00000000-0000-4000-8000-000000000a03', jordan: '00000000-0000-4000-8000-000000000a04', morgan: '00000000-0000-4000-8000-000000000a05', casey: '00000000-0000-4000-8000-000000000a06', taylor: '00000000-0000-4000-8000-000000000a07', robin: '00000000-0000-4000-8000-000000000a08', agent: '00000000-0000-4000-8000-000000000a09' };
export const A = { samVH: '00000000-0000-4000-8000-000000000b01', samWHM: '00000000-0000-4000-8000-000000000b02', samWHS: '00000000-0000-4000-8000-000000000b03', casey: '00000000-0000-4000-8000-000000000b07' };
export const prop = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
export const V = { d01: '00000000-0000-4000-8000-000000000d01', d02: '00000000-0000-4000-8000-000000000d02', d03: '00000000-0000-4000-8000-000000000d03' };

export async function resetDb() {
  await pool.query('drop schema public cascade; create schema public;');
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'));
  await pool.query(readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8'));
}

const tokens = new Map<string, string>();
export async function as(name: keyof typeof P) {
  if (!tokens.has(name)) {
    const email = { alex: 'alex.admin', sam: 'sam.rivers', priya: 'priya.shah', jordan: 'jordan.lee', morgan: 'morgan.hale', casey: 'casey.brook', taylor: 'taylor.quinn', robin: 'robin.ash', agent: 'agent.user' }[name] + '@example.test';
    const r = await request(app).post('/api/dev/login').send({ email });
    if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    tokens.set(name, r.body.token);
  }
  const t = tokens.get(name)!;
  const wrap = (m: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string) => request(app)[m](url).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), del: wrap('delete') };
}
export const rid = () => crypto.randomUUID();
export { pool };
