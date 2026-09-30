import type { Request } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const forbidden = (m = 'You do not have permission to perform this action') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw badRequest('Validation failed', issues);
  }
  return r.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw notFound();
  return v;
}
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ---------- reusable zod field helpers
const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
export const zDate = z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullable());
export const zDateTime = z.preprocess(emptyToNull, z.string().datetime({ offset: true }).nullable());
export const zMoney = z.preprocess(
  (v) => (v === '' || v === undefined ? null : typeof v === 'string' ? Number(v) : v),
  z.number().finite().min(0).max(1_000_000_000).nullable(),
);
export const zQty = z.preprocess(
  (v) => (v === '' || v === undefined ? null : typeof v === 'string' ? Number(v) : v),
  z.number().finite().min(0).max(1_000_000_000).nullable(),
);
export const zText = (max = 2000) => z.string().trim().max(max);
export const zUuidOrNull = z.preprocess(emptyToNull, z.string().uuid().nullable());
export const zUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    if (v === '') return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be a valid http(s) URL');

/**
 * Parses a PATCH body: validates with the schema, then keeps ONLY the keys the
 * client actually sent, so schema defaults can never overwrite existing values.
 */
export function parsePatch<T extends z.ZodType>(schema: T, req: Request): Partial<z.infer<T>> {
  const data = parseBody(schema, req) as Record<string, unknown>;
  const sent = new Set(Object.keys((req.body ?? {}) as object));
  return Object.fromEntries(Object.entries(data).filter(([k]) => sent.has(k))) as Partial<z.infer<T>>;
}
