// Applies db/migrations/*.sql in order, once each. Usage: tsx scripts/migrate.ts [--seed]
import { readdirSync, readFileSync } from 'node:fs';
import { pool } from '../server/db.ts';

const dir = new URL('../db/migrations/', import.meta.url);
await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
await pool.query('alter table schema_migrations enable row level security');
const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(readFileSync(new URL(f, dir), 'utf8'));
    await c.query('insert into schema_migrations (name) values ($1)', [f]);
    await c.query('commit');
    console.log('applied', f);
  } catch (e) {
    await c.query('rollback');
    console.error('failed', f, e);
    process.exit(1);
  } finally {
    c.release();
  }
}
if (process.argv.includes('--seed')) {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Refusing to seed fictional data in production');
  await pool.query(readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8'));
  console.log('seeded fictional demo data');
}
await pool.end();
