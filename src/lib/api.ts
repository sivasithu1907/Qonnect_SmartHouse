// Thin fetch wrapper: same-origin cookies, CSRF header on writes, JSON errors.
let csrfToken = '';
export const setCsrfToken = (t: string) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body ? String((body as any).error) : `Request failed (${res.status})`;
    const details = typeof body === 'object' ? (body as any).details : undefined;
    const full = Array.isArray(details) ? `${msg}: ${details.join('; ')}` : msg;
    throw new ApiError(res.status, full, details);
  }
  return body as T;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  return handle<T>(res);
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body: unknown) => api<T>('PATCH', url, body);

export async function upload<T = any>(url: string, fields: Record<string, string>, file: File): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', file);
  const res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
  return handle<T>(res);
}
