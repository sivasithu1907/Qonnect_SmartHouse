// Profile pictures: upload (crop to a square, resize, re-encode, strip metadata), view and remove.
//
// Storage: <UPLOAD_DIR>/_avatars/<uuid>.webp — the persistent uploads volume, never the source tree or the public
// build. File names are generated; the uploaded name is never used. Pictures are included in Backup & Restore.
// Access: a picture is served only to signed-in users who can already see that person (the user themself, user
// administrators, people sharing a project, and administrators who work across all projects). There is no listing
// endpoint, and an unknown or hidden user simply has no picture (404).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import type pg from 'pg';
import { can } from '../permissions';
import { forbidden, HttpError, notFound, uuidParam } from '../lib/http';
import { withTx } from '../db';
import { audit } from '../audit';
import type { AppConfig } from '../config';

export const AVATAR_DIR = '_avatars';
export const AVATAR_MAX_MB = 5;
export const AVATAR_SIZE = 256;
const FORMATS = new Set(['jpeg', 'png', 'webp']);
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

/** "avatar_version" sent to the browser: changes whenever the picture changes (cache-busting), null when none. */
export const avatarVersionSql = (alias: string) => `CASE WHEN ${alias}.avatar_file IS NULL THEN NULL ELSE (extract(epoch FROM ${alias}.avatar_updated_at) * 1000)::bigint::text END`;

export function avatarPath(uploadDir: string, file: string) {
  if (!FILE_RE.test(file)) throw new Error('invalid avatar file name');
  return path.join(uploadDir, AVATAR_DIR, file);
}

/** Can the signed-in user see this person (and so their picture)? */
async function canSee(pool: pg.Pool, req: Request, targetId: string): Promise<{ avatar_file: string | null } | null> {
  const u = req.user!;
  const { rows } = await pool.query(
    `SELECT t.avatar_file, t.role,
            ($2::uuid = t.id) AS self,
            EXISTS (SELECT 1 FROM project_members a JOIN project_members b ON a.project_id = b.project_id
                     WHERE a.user_id = $2 AND b.user_id = t.id) AS shares_project,
            EXISTS (SELECT 1 FROM project_members WHERE user_id = $2) AS has_projects
       FROM users t WHERE t.id = $1`, [targetId, u.id]);
  const t = rows[0];
  if (!t) return null;
  const ok = t.self || can(u.role, 'users.manage') || t.shares_project
    // administrators work across every project, so people with project access already see their names
    || (t.role === 'admin' && t.has_projects)
    // administrators see everyone they could manage or meet on a project
    || u.role === 'admin';
  return ok ? { avatar_file: t.avatar_file } : null;
}

/** Self, or an administrator with user-management permission. */
function assertCanManage(req: Request, targetId: string) {
  const u = req.user!;
  if (u.id !== targetId && !can(u.role, 'users.manage')) throw forbidden('You can only change your own profile picture');
}

export function avatarRoutes(pool: pg.Pool, cfg: AppConfig) {
  const r = Router();
  const dir = path.join(cfg.uploadDir, AVATAR_DIR);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_MB * 1024 * 1024, files: 1, fields: 10 } }).single('file');
  const parse = (req: Request, res: Response, next: NextFunction) => upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `The picture is larger than ${AVATAR_MAX_MB} MB` : err.message));
    }
    next(err as Error | undefined);
  });

  r.get('/:id/avatar', async (req, res) => {
    const id = uuidParam(req, 'id');
    const seen = await canSee(pool, req, id);
    if (!seen?.avatar_file) throw notFound('No profile picture');
    let full: string;
    try { full = avatarPath(cfg.uploadDir, seen.avatar_file); } catch { throw notFound('No profile picture'); }
    let st: fs.Stats;
    try { st = await fs.promises.stat(full); } catch { throw notFound('No profile picture'); }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // private, short-lived: the versioned URL changes when the picture changes; the service worker never caches /api
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Content-Disposition', 'inline; filename="avatar.webp"');
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });

  r.post('/:id/avatar', parse, async (req, res) => {
    const id = uuidParam(req, 'id');
    assertCanManage(req, id);
    const file = req.file;
    if (!file || !file.size) throw new HttpError(400, 'Choose a picture to upload');
    // the content decides, not the file name or the browser's type
    let meta: sharp.Metadata;
    try { meta = await sharp(file.buffer, { limitInputPixels: 40_000_000 }).metadata(); } catch { meta = {} as sharp.Metadata; }
    if (!meta.format || !FORMATS.has(meta.format) || !meta.width || !meta.height) {
      throw new HttpError(400, 'This file is not a JPEG, PNG or WebP picture');
    }
    // dimensions after applying the camera orientation (EXIF 5–8 swap width and height)
    const rotated = (meta.orientation ?? 1) >= 5;
    const W = rotated ? meta.height : meta.width;
    const H = rotated ? meta.width : meta.height;
    const num = (k: string) => { const v = Number((req.body ?? {})[k]); return Number.isFinite(v) ? Math.round(v) : NaN; };
    let x = num('x'), y = num('y'), size = num('size');
    if (!(size >= 16 && x >= 0 && y >= 0 && x + size <= W && y + size <= H)) {
      size = Math.min(W, H); x = Math.floor((W - size) / 2); y = Math.floor((H - size) / 2); // centred square
    }
    let out: Buffer;
    try {
      out = await sharp(file.buffer, { limitInputPixels: 40_000_000, animated: false })
        .rotate() // apply the orientation, then drop it with all other metadata (no withMetadata())
        .extract({ left: x, top: y, width: size, height: size })
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
        .webp({ quality: 82 })
        .toBuffer();
    } catch {
      throw new HttpError(400, 'This picture could not be processed. Try another JPEG, PNG or WebP file.');
    }
    const name = `${crypto.randomUUID()}.webp`;
    const sha = crypto.createHash('sha256').update(out).digest('hex');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
    const tmp = path.join(dir, `.${name}.tmp`);
    await fs.promises.writeFile(tmp, out, { mode: 0o640 });
    await fs.promises.rename(tmp, path.join(dir, name));
    let previous: string | null = null;
    try {
      const row = await withTx(pool, async (c) => {
        const cur = (await c.query('SELECT id, email, avatar_file FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw notFound('User not found');
        previous = cur.avatar_file;
        // only the picture columns change: never the name, role, password, sessions or project access
        const { rows } = await c.query(
          `UPDATE users SET avatar_file = $2, avatar_sha256 = $3, avatar_size_bytes = $4, avatar_updated_at = now() WHERE id = $1
           RETURNING ${avatarVersionSql('users')} AS avatar_version`, [id, name, sha, out.length]);
        await audit(c, req, { projectId: null, action: 'update', entityType: 'user', entityId: id,
          summary: `${id === req.user!.id ? 'Changed own profile picture' : `Changed the profile picture of ${cur.email}`}`,
          before: { avatar_file: cur.avatar_file }, after: { avatar_file: name } });
        return rows[0];
      });
      if (previous) await fs.promises.unlink(avatarPath(cfg.uploadDir, previous)).catch(() => undefined);
      res.json({ avatar_version: row.avatar_version });
    } catch (e) {
      await fs.promises.unlink(path.join(dir, name)).catch(() => undefined); // the previous picture stays in place
      throw e;
    }
  });

  r.delete('/:id/avatar', async (req, res) => {
    const id = uuidParam(req, 'id');
    assertCanManage(req, id);
    const previous = await withTx(pool, async (c) => {
      const cur = (await c.query('SELECT id, email, avatar_file FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('User not found');
      if (!cur.avatar_file) return null;
      await c.query('UPDATE users SET avatar_file = NULL, avatar_sha256 = NULL, avatar_size_bytes = NULL, avatar_updated_at = now() WHERE id = $1', [id]);
      await audit(c, req, { projectId: null, action: 'update', entityType: 'user', entityId: id,
        summary: id === req.user!.id ? 'Removed own profile picture' : `Removed the profile picture of ${cur.email}`,
        before: { avatar_file: cur.avatar_file }, after: { avatar_file: null } });
      return cur.avatar_file as string;
    });
    if (previous) await fs.promises.unlink(avatarPath(cfg.uploadDir, previous)).catch(() => undefined);
    res.json({ avatar_version: null });
  });

  return r;
}
