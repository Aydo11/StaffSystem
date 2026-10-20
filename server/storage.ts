import { randomUUID } from 'node:crypto';
import { type Db, one, q } from './db.ts';
import { bad } from './http.ts';

// Files are stored in Postgres (file_blobs), so they are covered by the database's backups and access rules.
// shortcut: fine for photos and PDFs up to 10 MB at this organisation's size; move to object storage if uploads reach tens of GB.

// Allowed types are checked by content (magic bytes), not by the name or the browser's claim.
const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
];
// Word (.docx) is a zip whose entries live under word/. Only allowed where a caller opts in (staff documents such as CVs).
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isDocx = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && b.includes('word/');
export function sniff(buf: Buffer, imagesOnly = false, allowWord = false): string {
  if (allowWord && isDocx(buf)) return DOCX;
  const hit = SIGNATURES.find(([type, test]) => test(buf) && (!imagesOnly || type.startsWith('image/')));
  if (!hit) throw bad(imagesOnly ? 'Please upload a JPEG, PNG or WebP image.' : allowWord ? 'Please upload a PDF, Word (.docx) document or a JPEG, PNG or WebP image.' : 'Please upload a JPEG, PNG, WebP image or a PDF.');
  return hit[0];
}

export async function saveFile(db: Db, f: { companyId: string | null; entityType: string; entityId: string; name: string; buf: Buffer; uploadedBy: string; imagesOnly?: boolean; allowWord?: boolean }) {
  const mime = sniff(f.buf, f.imagesOnly, f.allowWord);
  const path = `${f.companyId ?? 'shared'}/${f.entityType}/${f.entityId}/${randomUUID()}`;
  const safeName = f.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
  const row = await one('insert into files (company_id, entity_type, entity_id, storage_path, original_name, mime_type, size_bytes, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, original_name, mime_type, size_bytes, uploaded_at',
    [f.companyId, f.entityType, f.entityId, path, safeName, mime, f.buf.length, f.uploadedBy], db);
  await q('insert into file_blobs (storage_path, data) values ($1, $2)', [path, f.buf], db);
  return { ...row, storage_path: path };
}

export async function readFile(path: string): Promise<Buffer> {
  return (await one<{ data: Buffer }>('select data from file_blobs where storage_path = $1', [path]))!.data;
}

// Deletes the file inside the caller's transaction (its blob goes with it), so a rollback keeps both.
export async function deleteFile(db: Db, fileId: string): Promise<void> {
  await q('delete from files where id = $1', [fileId], db);
}
