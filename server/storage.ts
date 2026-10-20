import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { type Db, one, q } from './db.ts';
import { bad } from './http.ts';

const BUCKET = 'hub-private';
const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
export const storageMode = sb ? 'supabase' : 'database';
export const supabaseAdmin = sb;

// Allowed types are checked by content (magic bytes), not by the name or the browser's claim.
const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
];
export function sniff(buf: Buffer, imagesOnly = false): string {
  const hit = SIGNATURES.find(([type, test]) => test(buf) && (!imagesOnly || type.startsWith('image/')));
  if (!hit) throw bad(imagesOnly ? 'Please upload a JPEG, PNG or WebP image.' : 'Please upload a JPEG, PNG, WebP image or a PDF.');
  return hit[0];
}

export async function saveFile(db: Db, f: { companyId: string | null; entityType: string; entityId: string; name: string; buf: Buffer; uploadedBy: string; imagesOnly?: boolean }) {
  const mime = sniff(f.buf, f.imagesOnly);
  const path = `${f.companyId ?? 'shared'}/${f.entityType}/${f.entityId}/${randomUUID()}`;
  const safeName = f.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
  const row = await one('insert into files (company_id, entity_type, entity_id, storage_path, original_name, mime_type, size_bytes, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, original_name, mime_type, size_bytes, uploaded_at',
    [f.companyId, f.entityType, f.entityId, path, safeName, mime, f.buf.length, f.uploadedBy], db);
  if (sb) {
    const { error } = await sb.storage.from(BUCKET).upload(path, f.buf, { contentType: mime, upsert: false });
    if (error) throw new Error(`storage upload failed: ${error.message}`); // caller's transaction rolls back the files row
  } else {
    await q('insert into file_blobs (storage_path, data) values ($1, $2)', [path, f.buf], db);
  }
  return { ...row, storage_path: path };
}

export async function readFile(path: string): Promise<Buffer> {
  if (sb) {
    const { data, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw new Error(`storage download failed: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  return (await one<{ data: Buffer }>('select data from file_blobs where storage_path = $1', [path]))!.data;
}

// Deletes the row inside the caller's transaction and returns its storage path. Call removeStored(path) only after the
// transaction commits: a bucket delete cannot be rolled back. (In database mode the blob row is deleted with the files row.)
export async function deleteFile(db: Db, fileId: string): Promise<string | null> {
  return (await one<{ storage_path: string }>('delete from files where id = $1 returning storage_path', [fileId], db))?.storage_path ?? null;
}
export async function removeStored(path: string | null) {
  if (!path || !sb) return;
  const { error } = await sb.storage.from(BUCKET).remove([path]);
  // The record change already succeeded, so a leftover object is logged rather than reported as a failure.
  if (error) console.error(JSON.stringify({ level: 'warn', message: 'orphaned storage object', path, error: error.message }));
}
