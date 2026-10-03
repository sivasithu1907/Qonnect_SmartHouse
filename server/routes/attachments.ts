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
import { ATTACHMENT_ENTITY_TYPES, ATTACHMENT_KINDS, attachmentKindsFor, type AttachmentEntityType } from '../../shared/constants';
import { canWriteConsultantVisit, canWriteSiteVisit } from './visits';

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

const READ_CAP: Record<AttachmentEntityType, Capability> = {
  payment_milestone: 'payments.read',
  payment_transaction: 'payments.read',
  material: 'materials.read',
  consultant_visit: 'consultant.read',
  site_visit: 'site.read',
  work_update: 'timeline.read',
  contract: 'contracts.read',
  contract_amendment: 'contracts.read',
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
};

async function assertEntityAccess(db: pg.Pool | pg.PoolClient, req: Request, type: AttachmentEntityType, entityId: string, mode: 'read' | 'write') {
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
  }
  if (!ok) throw forbidden();
  return row;
}

export function attachmentRoutes(pool: pg.Pool, cfg: AppConfig) {
  const r = Router({ mergeParams: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 10 },
  });

  r.get('/', async (req, res) => {
    const q = z.object({ entity_type: z.enum(ATTACHMENT_ENTITY_TYPES), entity_id: z.string().uuid() }).safeParse(req.query);
    if (!q.success) throw badRequest('entity_type and entity_id are required');
    await assertEntityAccess(pool, req, q.data.entity_type, q.data.entity_id, 'read');
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.original_name, a.mime_type, a.size_bytes, a.created_at, u.name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.project_id = $1 AND a.entity_type = $2 AND a.entity_id = $3 AND a.archived_at IS NULL
        ORDER BY a.created_at DESC`,
      [req.project!.id, q.data.entity_type, q.data.entity_id],
    );
    res.json(rows);
  });

  r.post('/', (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${cfg.maxUploadMb} MB limit` : err.message));
      }
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    const body = parseBody(
      z.object({ entity_type: z.enum(ATTACHMENT_ENTITY_TYPES), entity_id: z.string().uuid(), kind: z.enum(ATTACHMENT_KINDS) }),
      req,
    );
    const file = req.file;
    if (!file || !file.size) throw badRequest('A file is required');
    const originalName = path.basename(file.originalname).replace(/[\u0000-\u001f"\\]/g, '_').slice(0, 200) || 'file';
    const detected = detectFileType(file.buffer, originalName);
    if (!detected) throw new HttpError(415, 'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, HEIC, DOCX, XLSX.');
    if (!attachmentKindsFor(body.entity_type).includes(body.kind)) throw badRequest('This document type cannot be attached to this record');
    if (body.kind === 'site_photo' && !detected.mime.startsWith('image/')) throw badRequest('Site photos must be image files');
    await assertEntityAccess(pool, req, body.entity_type, body.entity_id, 'write');

    const pid = req.project!.id;
    const storedName = `${crypto.randomUUID()}${detected.ext}`;
    const dir = path.join(cfg.uploadDir, pid);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
    const fullPath = path.join(dir, storedName);
    await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o640 });
    try {
      const row = await withTx(pool, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO attachments (project_id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, kind, original_name, mime_type, size_bytes, created_at`,
          [pid, body.entity_type, body.entity_id, body.kind, originalName, storedName, detected.mime, file.size,
            crypto.createHash('sha256').update(file.buffer).digest('hex'), req.user!.id],
        );
        await audit(c, req, { projectId: pid, action: 'upload', entityType: body.entity_type, entityId: body.entity_id, summary: `Uploaded ${body.kind}: ${originalName}`, after: rows[0] });
        return rows[0];
      });
      res.status(201).json(row);
    } catch (e) {
      await fs.promises.unlink(fullPath).catch(() => undefined);
      throw e;
    }
  });

  r.get('/:id/download', async (req, res) => {
    const id = uuidParam(req, 'id');
    const a = await getOwned<Record<string, string>>(pool, 'attachments', req.project!.id, id);
    if (a.archived_at) throw notFound();
    await assertEntityAccess(pool, req, a.entity_type as AttachmentEntityType, a.entity_id, 'read');
    const full = path.join(cfg.uploadDir, req.project!.id, path.basename(a.stored_name));
    if (!fs.existsSync(full)) throw notFound('File is missing from storage');
    const inline = req.query.inline === '1' && /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(a.mime_type);
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
    fs.createReadStream(full).pipe(res);
  });

  r.post('/:id/archive', async (req, res) => {
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const a = await getOwned<Record<string, string>>(c, 'attachments', pid, id, { forUpdate: true });
      await assertEntityAccess(c, req, a.entity_type as AttachmentEntityType, a.entity_id, 'write');
      // the original signed agreement is kept: only an admin can archive a signed-contract file
      if (a.kind === 'signed_contract' && !can(req.user!.role, 'projects.manage')) {
        throw forbidden('Signed contract files are kept as the original agreement. Only an admin can archive them — record changes as an amendment instead.');
      }
      await c.query('UPDATE attachments SET archived_at = now() WHERE id = $1', [id]);
      await audit(c, req, { projectId: pid, action: 'archive', entityType: 'attachment', entityId: id, summary: `Archived file ${a.original_name}` });
      return { ok: true };
    });
    res.json(out);
  });

  return r;
}
