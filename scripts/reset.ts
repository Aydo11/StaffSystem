// Development/test only: wipes the public schema, re-applies migrations and fictional seed data.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') throw new Error('db:reset is disabled in production');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('drop schema public cascade; create schema public;');
await c.end();
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', '--seed'], { stdio: 'inherit', env: process.env });
