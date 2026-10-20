import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from './db.ts';
import { q } from './db.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const forbidden = (msg = 'You do not have permission to do this.') => new HttpError(403, 'forbidden', msg);
// Records outside someone's access return 404, so their existence is not revealed.
export const notFound = () => new HttpError(404, 'not_found', 'Not found, or you do not have access to it.');
export const bad = (msg: string, details?: unknown) => new HttpError(400, 'invalid', msg, details);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw new HttpError(400, 'invalid', 'Please check the highlighted fields.', { fields });
  }
  return r.data;
}

export const uuid = z.uuid();
// A malformed id in a URL is simply "not found", not a form error.
export const idParam = (v: unknown) => { const r = uuid.safeParse(v); if (!r.success) throw notFound(); return r.data; };
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-20');
// A wall-clock time in Europe/London, e.g. 2026-10-20T09:30. Converted to UTC in SQL so DST is handled by Postgres.
export const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use a date and time');
export const text = (max: number) => z.string().trim().max(max);
export const LONDON_TODAY = `(now() at time zone 'Europe/London')::date`;

export async function audit(db: Db, actor: string | null, companyId: string | null, entity: string, entityId: string | null, action: string, detail: object = {}) {
  await q('insert into audit_log (actor_person_id, company_id, entity, entity_id, action, detail) values ($1,$2,$3,$4,$5,$6)', [actor, companyId, entity, entityId, action, detail], db);
}

export async function notify(db: Db, personId: string, companyId: string | null, title: string, link: string | null, body?: string) {
  await q('insert into notifications (person_id, company_id, title, body, link) values ($1,$2,$3,$4,$5)', [personId, companyId, title, body ?? null, link], db);
}

const PG_ERRORS: Record<string, [number, string, string]> = {
  '23505': [409, 'duplicate', 'This already exists.'],
  '23P01': [409, 'overlap', 'This overlaps an existing record.'],
  '23514': [400, 'invalid', 'Some values are not allowed.'],
  '23503': [400, 'invalid', 'A linked record does not exist.'],
  '22P02': [400, 'invalid', 'A value is in the wrong format.'],
  '22007': [400, 'invalid', 'A date or time is not valid.'],
  '22008': [400, 'invalid', 'A date or time is out of range.'],
};

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  const pg = err?.code && PG_ERRORS[err.code];
  if (pg) return res.status(pg[0]).json({ error: pg[1], message: pg[2], constraint: err.constraint });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid', message: 'Request body is not valid JSON.' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: 'File is larger than 10 MB.' });
  // Log the error without request bodies (they may hold personal data).
  console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), method: req.method, path: req.path, message: err?.message, code: err?.code, stack: err?.stack?.split('\n').slice(0, 4) }));
  res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side. Your information was not saved — please try again.' });
}
