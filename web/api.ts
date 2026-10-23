import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken, onUnauthenticated } from './auth.ts';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
  get fields(): Record<string, string> { return this.details?.fields ?? {}; }
}

let clockOffset = 0; // server time minus device time, from the Date header
export const serverNow = () => Date.now() + clockOffset;

async function headers(json: boolean) {
  const h: Record<string, string> = {};
  const t = await getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function handle(res: Response) {
  const d = res.headers.get('Date');
  if (d) clockOffset = Date.parse(d) - Date.now();
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated();
    throw new ApiError(res.status, body?.error ?? 'error', body?.message ?? 'Something went wrong.', body?.details);
  }
  return body;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, { method, headers: await headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline or the server could not be reached. Nothing was saved — please try again.');
  }
  return handle(res);
}
export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>('PUT', url, body);

// Phone photos are often 4000px and several MB: resize to at most 1600px (JPEG) before upload so they upload fast,
// stay under the size limit and load quickly. Small images, PDFs and anything that cannot be decoded are sent unchanged.
export async function shrinkImage(file: Blob, name: string): Promise<[Blob, string]> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return [file, name];
  try {
    const img = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1_500_000) return [file, name];
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // JPEG has no transparency
    g.drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return out && out.size < file.size ? [out, name.replace(/\.\w+$/, '') + '.jpg'] : [file, name];
  } catch { return [file, name]; }
}

// Upload with real progress (fetch cannot report upload progress).
export async function upload<T = any>(url: string, file: Blob | null, name: string, onProgress?: (pct: number) => void, fields: Record<string, string> = {}): Promise<T> {
  if (file) [file, name] = await shrinkImage(file, name);
  const h = await headers(false);
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api${url}`);
    for (const [k, v] of Object.entries(h)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    x.onerror = () => reject(new ApiError(0, 'network', 'The upload failed because the connection dropped. Please try again.'));
    x.onload = () => {
      let b: any = null;
      try { b = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(b);
      else reject(new ApiError(x.status, b?.error ?? 'error', b?.message ?? 'Upload failed.', b?.details));
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('file', file, name);
    x.send(fd);
  });
}

// Authenticated file fetch → object URL (images and downloads need the bearer token, so plain <img src> cannot be used).
export async function blobUrl(url: string): Promise<string | null> {
  const res = await fetch(`/api${url}`, { headers: await headers(false) });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
export async function download(url: string, name: string) {
  const u = await blobUrl(url);
  if (!u) throw new ApiError(404, 'not_found', 'This file is not available to you.');
  const a = Object.assign(document.createElement('a'), { href: u, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

export function useApi<T = any>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(url);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e as ApiError);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

// Runs a mutation once at a time (prevents duplicate submissions) and keeps field errors for the form.
export function useSubmit<A extends any[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef(false);
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      return await fn(...a);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e)));
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [fn]);
  return { run, busy, error, setError };
}
