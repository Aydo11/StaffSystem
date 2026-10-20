import pg from 'pg';

// numeric → string (decimal-safe money); int8 (counts) → number; dates stay as 'YYYY-MM-DD' strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

const prod = process.env.NODE_ENV === 'production';
const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : '';
const local = host === 'localhost' || host === '127.0.0.1';
// Render's internal address (a bare name like dpg-xxxx-a) only resolves on Render's private network, so traffic never leaves Render.
const privateNetwork = !!host && !host.includes('.');
const ca = process.env.DATABASE_CA?.replace(/\\n/g, '\n'); // accepts the certificate pasted as one line with \n

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Any other address is verified: against DATABASE_CA if given, else the system's trusted certificates.
  // shortcut: a non-production remote database without DATABASE_CA gets encrypted but unverified TLS; set DATABASE_CA on staging too.
  ssl: local || privateNetwork || (!prod && process.env.DATABASE_SSL === 'false') ? undefined : ca ? { ca } : prod ? {} : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
});

export type Db = pg.Pool | pg.PoolClient;

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await q<T>(sql, params, db))[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
