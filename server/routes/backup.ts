// Settings → Backup & Restore (administrators only). Archives are served only through these
// authenticated routes; BACKUP_DIR is never exposed statically.
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { requireCap } from '../auth';
import { badRequest, HttpError, notFound, parseBody } from '../lib/http';
import { verifyPassword } from '../lib/passwords';
import { BusyError, CHUNK_BYTES, type Actor, type BackupService } from '../backup/service';
import { isId } from '../backup/store';

const actorOf = (req: Request): Actor => ({ id: req.user!.id, email: req.user!.email, name: req.user!.name });
export const restoreConfirmation = (backupId: string) => `RESTORE ${backupId.slice(0, 8)}`;

function busy(e: unknown): never {
  if (e instanceof BusyError) throw new HttpError(409, e.message);
  throw new HttpError(400, (e as Error).message);
}

export function backupRoutes(pool: pg.Pool, svc: BackupService) {
  const r = Router();
  r.use(requireCap('backup.manage'));
  const idParam = (req: Request, k = 'id') => {
    const v = req.params[k];
    if (!isId(v)) throw notFound('Backup not found');
    return v;
  };

  r.get('/status', async (_req, res) => {
    res.json(await svc.status());
  });

  r.get('/backups', (_req, res) => {
    res.json({ backups: svc.store.list() });
  });

  r.post('/backups', async (req, res) => {
    const op = await svc.startBackup(actorOf(req)).catch(busy);
    res.status(202).json({ operation: op });
  });

  r.get('/backups/:id', (req, res) => {
    const m = svc.store.readMeta(idParam(req));
    if (!m) throw notFound('Backup not found');
    res.json({ backup: m, confirmation: restoreConfirmation(m.id), archiveOnServer: fs.existsSync(svc.store.archivePath(m.id)) });
  });

  r.get('/backups/:id/download', async (req, res) => {
    const id = idParam(req);
    const m = svc.store.readMeta(id);
    const file = svc.store.archivePath(id);
    if (!m || m.status === 'running' || !fs.existsSync(file)) throw notFound('This backup archive is not available for download.');
    const size = fs.statSync(file).size;
    await svc.audit(actorOf(req), 'backup_downloaded', `Downloaded backup archive ${m.fileName}`, { backupId: id, size }, id);
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${m.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(fs.createReadStream(file), res).catch(() => undefined); // client aborts are not errors
  });

  r.post('/backups/:id/delete', async (req, res) => {
    const id = idParam(req);
    let m;
    try { m = svc.removeBackup(id); } catch (e) { busy(e); }
    await svc.audit(actorOf(req), 'backup_deleted', `Deleted backup archive ${m.fileName} (live data and uploaded files are not affected)`, { backupId: id }, id);
    res.json({ ok: true });
  });

  r.post('/backups/:id/validate', async (req, res) => {
    const id = idParam(req);
    if (!svc.store.readMeta(id)) throw notFound('Backup not found');
    const op = await svc.startValidate(id, actorOf(req)).catch(busy);
    res.status(202).json({ operation: op });
  });

  r.post('/backups/:id/restore', async (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ password: z.string().min(1).max(200), confirmation: z.string().max(100) }), req);
    const m = svc.store.readMeta(id);
    if (!m) throw notFound('Backup not found');
    if (body.confirmation.trim() !== restoreConfirmation(id)) throw badRequest(`Type ${restoreConfirmation(id)} exactly to confirm.`);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1 AND is_active', [req.user!.id]);
    if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) {
      await svc.audit(actorOf(req), 'restore_denied', 'Restore not started: password re-check failed', { backupId: id }, id);
      throw badRequest('Your password is incorrect. The restore was not started.');
    }
    const op = await svc.startRestore(id, actorOf(req)).catch(busy);
    res.status(202).json({ operation: op });
  });

  r.post('/jobs/resume', async (req, res) => {
    if (svc.current?.state === 'running') throw new HttpError(409, 'Wait for the running operation to finish.');
    await svc.resumeJobs(actorOf(req));
    res.json({ ok: true });
  });

  // ---- chunked, resumable uploads (each request is at most CHUNK_BYTES, streamed to disk)
  r.post('/uploads', async (req, res) => {
    const body = parseBody(z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive() }), req);
    let u;
    try { u = await svc.createUpload(body.fileName, body.size, actorOf(req)); } catch (e) { busy(e); }
    res.status(201).json({ upload: u, chunkBytes: CHUNK_BYTES });
  });

  r.put('/uploads/:id', async (req, res) => {
    const id = idParam(req);
    const u = svc.store.readUpload(id);
    if (!u || u.by !== req.user!.id) throw notFound('Upload not found');
    if (!req.is('application/octet-stream')) throw badRequest('Expected application/octet-stream');
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset !== u.received) {
      return res.status(409).json({ error: 'Upload offset mismatch', received: u.received });
    }
    const limit = Math.min(CHUNK_BYTES, u.size - u.received);
    let n = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        n += chunk.length;
        if (n > limit) return cb(new HttpError(413, 'Chunk too large'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(svc.store.uploadPartPath(id), { flags: 'r+', start: offset }));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'The upload was interrupted. Resume to continue.');
    }
    res.json({ received: svc.store.readUpload(id)?.received ?? offset + n });
  });

  r.get('/uploads/:id', (req, res) => {
    const u = svc.store.readUpload(idParam(req));
    if (!u || u.by !== req.user!.id) throw notFound('Upload not found');
    res.json({ upload: u });
  });

  r.post('/uploads/:id/complete', async (req, res) => {
    const id = idParam(req);
    try {
      const out = await svc.completeUpload(id, actorOf(req));
      res.status(202).json({ backup: out.meta, operation: out.op });
    } catch (e) { busy(e); }
  });

  r.post('/uploads/:id/cancel', (req, res) => {
    const id = idParam(req);
    const u = svc.store.readUpload(id);
    if (u && u.by === req.user!.id) svc.store.removeUpload(id);
    res.json({ ok: true });
  });

  return r;
}
