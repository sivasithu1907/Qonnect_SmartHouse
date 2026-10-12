// Private file uploads (payment slips, consultant reports, delivery notes, site photos, contract documents).
// Files are stored outside the web root under UPLOAD_DIR/<projectId>/ with random names,
// content type is detected from magic bytes (client-supplied type is ignored), and
// downloads re-check project membership and role on every request.
import { Router, type Request } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { badRequest, forbidden, HttpError, notFound, parseBody, uuidParam } from '../lib/http';
import { withTx } from '../db';
import { audit } from '../audit';
import { getOwned } from '../lib/crud';
import { can, type Capability } from '../permissions';
import { ATTACHMENT_ENTITY_TYPES, ATTACHMENT_KINDS, attachmentKindsFor, PREVIEWABLE_MIME_TYPES, type AttachmentEntityType } from '../../shared/constants';
import { canWriteConsultantVisit, canWriteSiteVisit } from './visits';
import { effectiveFileName, sanitizeFileName, suggestRepairedName } from '../../shared/filenames';
import type { DbClient } from '../db';

interface Detected { mime: string; ext: string }

export function detectFileType(buf: Buffer, originalName: string): Detected | null {
  const ext = path.extname(originalName).toLowerCase();
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => buf[offset + i] === b);
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: '.pdf' };
  if (startsWith([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: '.jpg' };
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: '.png' };
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp' && ['heic', 'heix', 'mif1', 'hevc'].includes(buf.subarray(8, 12).toString('ascii'))) {
    return { mime: 'image/heic', ext: '.heic' };
  }
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML documents are ZIP containers; only accept the expected extensions
    if (ext === '.docx') return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
    if (ext === '.xlsx') return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' };
  }
  return null;
}

/** Types the browser may show in a tab (View). Everything else is always sent as a download. */
export const INLINE_TYPES = new Set(PREVIEWABLE_MIME_TYPES);

/**
 * Content-Security-Policy for a stored file response.
 * - Downloads and image previews keep the fully sandboxed policy.
 * - A PDF preview is not sandboxed: Chromium's built-in PDF viewer needs script and extension
 *   permissions that a `sandbox` policy (without allow-scripts) removes, and Chromium can then refuse
 *   the viewer with ERR_BLOCKED_BY_CLIENT. The PDF policy below still allows no page script, no
 *   connections, no forms, no framing and no base-URL changes for the document itself.
 */
export function fileCsp(mime: string, inline: boolean): string {
  if (inline && mime === 'application/pdf') {
    return "default-src 'none'; object-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  }
  return "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
}

/** RFC 6266 Content-Disposition with an ASCII fallback name and the exact UTF-8 name. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_').trim() || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function storedTypeMatches(full: string, mime: string, originalName: string): Promise<boolean> {
  const fh = await fs.promises.open(full, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, 16, 0);
    return detectFileType(head.subarray(0, bytesRead), originalName)?.mime === mime;
  } finally {
    await fh.close();
  }
}

const READ_CAP: Record<AttachmentEntityType, Capability> = {
  payment_milestone: 'payments.read',
  payment_transaction: 'payments.read',
  material: 'materials.read',
  consultant_visit: 'consultant.read',
  site_visit: 'site.read',
  work_update: 'timeline.read',
  contract: 'contracts.read',
  contract_amendment: 'contracts.read',
  prerequisite: 'prerequisites.read',
  project_document: 'documents.read',
  budget_item: 'budget.read',
};
const TABLE: Record<AttachmentEntityType, string> = {
  payment_milestone: 'payment_milestones',
  payment_transaction: 'payment_transactions',
  material: 'material_items',
  consultant_visit: 'consultant_visits',
  site_visit: 'site_visits',
  work_update: 'work_updates',
  contract: 'contracts',
  contract_amendment: 'contract_amendments',
  prerequisite: 'project_prerequisites',
  project_document: 'project_documents',
  budget_item: 'budget_items',
};

export async function assertEntityAccess(db: pg.Pool | pg.PoolClient, req: Request, type: AttachmentEntityType, entityId: string, mode: 'read' | 'write') {
  const pid = req.project!.id;
  const u = req.user!;
  const row = await getOwned<Record<string, unknown>>(db, TABLE[type], pid, entityId); // 404 if other project
  if (mode === 'read') {
    if (!can(u.role, READ_CAP[type])) throw forbidden();
    return row;
  }
  let ok = false;
  switch (type) {
    case 'payment_milestone':
    case 'payment_transaction':
      ok = can(u.role, 'payments.write');
      break;
    case 'material':
      ok = can(u.role, 'materials.write') || (can(u.role, 'materials.contractor') && row.assigned_contractor_id === u.id);
      break;
    case 'consultant_visit':
      ok = canWriteConsultantVisit(req, row as { consultant_user_id: string | null });
      break;
    case 'site_visit':
      ok = canWriteSiteVisit(req, row as { assigned_user_id: string | null });
      break;
    case 'work_update':
      ok = can(u.role, 'timeline.write') || (can(u.role, 'workupdates.write') && row.author_id === u.id);
      break;
    case 'contract':
    case 'contract_amendment':
      ok = can(u.role, 'contracts.write');
      break;
    case 'prerequisite':
      ok = can(u.role, 'prerequisites.write');
      break;
    case 'project_document':
      ok = can(u.role, 'documents.write');
      break;
    case 'budget_item':
      ok = can(u.role, 'budget.write');
      break;
  }
  if (!ok) throw forbidden();
  return row;
}

/**
 * Multipart parser for uploads. Browsers send the file name as raw UTF-8 inside the part header;
 * reading it as UTF-8 (not the Latin-1 default) keeps Arabic and other non-Latin names intact.
 */
export function uploadParser(cfg: AppConfig) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 10 },
    defParamCharset: 'utf8',
  });
}

/** Express middleware: one `file` field, multer errors as readable HTTP errors. */
export function singleFile(cfg: AppConfig) {
  const upload = uploadParser(cfg);
  return (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${cfg.maxUploadMb} MB limit` : err.message));
      }
      if (err) return next(err);
      next();
    });
  };
}

/** Validates the uploaded file and writes it to private storage under a generated name (before any DB row). */
export async function storeUploadedFile(cfg: AppConfig, pid: string, file: Express.Multer.File | undefined) {
  if (!file || !file.size) throw badRequest('A file is required');
  const originalName = sanitizeFileName(file.originalname);
  const detected = detectFileType(file.buffer, originalName);
  if (!detected) throw new HttpError(415, 'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, HEIC, DOCX, XLSX.');
  const storedName = `${crypto.randomUUID()}${detected.ext}`;
  const dir = path.join(cfg.uploadDir, pid);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
  const fullPath = path.join(dir, storedName);
  await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o640 });
  return {
    originalName, storedName, fullPath, mime: detected.mime, size: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    discard: () => fs.promises.unlink(fullPath).catch(() => undefined),
  };
}

export async function insertAttachment(c: DbClient, s: Awaited<ReturnType<typeof storeUploadedFile>>, a: {
  projectId: string; entityType: AttachmentEntityType; entityId: string; kind: string; userId: string; description?: string;
}) {
  const { rows } = await c.query(
    `INSERT INTO attachments (project_id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, kind, original_name, display_name, description, mime_type, size_bytes, created_at`,
    [a.projectId, a.entityType, a.entityId, a.kind, s.originalName, s.storedName, s.mime, s.size, s.sha256, a.userId, a.description ?? ''],
  );
  return rows[0];
}

export function attachmentRoutes(pool: pg.Pool, cfg: AppConfig) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    const q = z.object({ entity_type: z.enum(ATTACHMENT_ENTITY_TYPES), entity_id: z.string().uuid() }).safeParse(req.query);
    if (!q.success) throw badRequest('entity_type and entity_id are required');
    await assertEntityAccess(pool, req, q.data.entity_type, q.data.entity_id, 'read');
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.original_name, a.display_name, a.description, a.mime_type, a.size_bytes, a.created_at, u.name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.project_id = $1 AND a.entity_type = $2 AND a.entity_id = $3 AND a.archived_at IS NULL
        ORDER BY a.created_at DESC`,
      [req.project!.id, q.data.entity_type, q.data.entity_id],
    );
    res.json(rows.map((a) => ({ ...a, name: effectiveFileName(a), suggested_name: a.display_name ? null : suggestRepairedName(a.original_name) })));
  });

  r.post('/', singleFile(cfg), async (req, res) => {
    const body = parseBody(
      z.object({ entity_type: z.enum(ATTACHMENT_ENTITY_TYPES), entity_id: z.string().uuid(), kind: z.enum(ATTACHMENT_KINDS), description: z.string().max(2000).optional() }),
      req,
    );
    if (!req.file || !req.file.size) throw badRequest('A file is required');
    if (!attachmentKindsFor(body.entity_type).includes(body.kind)) throw badRequest('This document type cannot be attached to this record');
    await assertEntityAccess(pool, req, body.entity_type, body.entity_id, 'write');
    const pid = req.project!.id;
    const stored = await storeUploadedFile(cfg, pid, req.file);
    try {
      if (body.kind === 'site_photo' && !stored.mime.startsWith('image/')) throw badRequest('Site photos must be image files');
      const row = await withTx(pool, async (c) => {
        const a = await insertAttachment(c, stored, { projectId: pid, entityType: body.entity_type, entityId: body.entity_id, kind: body.kind, userId: req.user!.id, description: body.description?.trim() });
        await audit(c, req, { projectId: pid, action: 'upload', entityType: body.entity_type, entityId: body.entity_id, summary: `Uploaded ${body.kind}: ${stored.originalName}`, after: a });
        return a;
      });
      res.status(201).json(row);
    } catch (e) {
      await stored.discard();
      throw e;
    }
  });

  // Rename the display name / describe a file. The stored file, its id, links and original name never change.
  r.patch('/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parseBody(z.object({
      display_name: z.string().max(200).nullable().optional(),
      description: z.string().max(2000).optional(),
      kind: z.enum(ATTACHMENT_KINDS).optional(),
    }), req);
    const out = await withTx(pool, async (c) => {
      const a = await getOwned<Record<string, string>>(c, 'attachments', pid, id, { forUpdate: true });
      if (a.archived_at || !(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(a.entity_type)) throw notFound();
      await assertEntityAccess(c, req, a.entity_type as AttachmentEntityType, a.entity_id, 'write');
      const next: Record<string, unknown> = {};
      if (body.display_name !== undefined) {
        const clean = body.display_name === null || !body.display_name.trim() ? null : sanitizeFileName(body.display_name);
        next.display_name = clean === a.original_name ? null : clean;
      }
      if (body.description !== undefined) next.description = body.description.trim();
      if (body.kind !== undefined) {
        if (!attachmentKindsFor(a.entity_type as AttachmentEntityType).includes(body.kind)) throw badRequest('This document type cannot be used for this record');
        if (a.kind === 'signed_contract' && body.kind !== a.kind && !can(req.user!.role, 'projects.manage')) throw forbidden('Only an admin can change the type of a signed contract file');
        next.kind = body.kind;
      }
      if (!Object.keys(next).length) throw badRequest('Nothing to change');
      const keys = Object.keys(next);
      const { rows } = await c.query(
        `UPDATE attachments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1
         RETURNING id, kind, original_name, display_name, description, mime_type, size_bytes, created_at`,
        [id, ...keys.map((k) => next[k])]);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'attachment', entityId: id,
        summary: `Updated file details: ${effectiveFileName(a as never)}${next.display_name !== undefined ? ` → ${effectiveFileName(rows[0])}` : ''}`,
        before: { display_name: a.display_name, description: a.description, kind: a.kind }, after: next });
      return { ...rows[0], name: effectiveFileName(rows[0]) };
    });
    res.json(out);
  });

  r.get('/:id/download', async (req, res) => {
    const id = uuidParam(req, 'id');
    const a = await getOwned<Record<string, string>>(pool, 'attachments', req.project!.id, id);
    // directory documents have their own scoped routes (/api/directory/...), never this one
    if (a.archived_at || !(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(a.entity_type)) throw notFound();
    await assertEntityAccess(pool, req, a.entity_type as AttachmentEntityType, a.entity_id, 'read');
    const full = path.join(cfg.uploadDir, req.project!.id, path.basename(a.stored_name));
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw notFound('File is missing from storage');
    }
    // Preview only for previewable types, and only when the stored bytes still match the saved type.
    const wantsInline = req.query.inline === '1' && INLINE_TYPES.has(a.mime_type);
    const inline = wantsInline && (await storedTypeMatches(full, a.mime_type, a.original_name));
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Security-Policy', fileCsp(a.mime_type, inline));
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', effectiveFileName(a as never)));
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  r.post('/:id/archive', async (req, res) => {
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const a = await getOwned<Record<string, string>>(c, 'attachments', pid, id, { forUpdate: true });
      if (!(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(a.entity_type)) throw notFound();
      await assertEntityAccess(c, req, a.entity_type as AttachmentEntityType, a.entity_id, 'write');
      // the original signed agreement is kept: only an admin can archive a signed-contract file
      if (a.kind === 'signed_contract' && !can(req.user!.role, 'projects.manage')) {
        throw forbidden('Signed contract files are kept as the original agreement. Only an admin can archive them — record changes as an amendment instead.');
      }
      await c.query('UPDATE attachments SET archived_at = now() WHERE id = $1', [id]);
      await audit(c, req, { projectId: pid, action: 'archive', entityType: 'attachment', entityId: id, summary: `Archived file ${effectiveFileName(a as never)}` });
      return { ok: true };
    });
    res.json(out);
  });

  return r;
}
