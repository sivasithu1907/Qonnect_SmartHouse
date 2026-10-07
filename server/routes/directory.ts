// Contacts / Companies directory — one shared directory, project-specific assignments.
//   /api/directory                                   GET list (search / filters) · POST create
//   /api/directory/specializations                   GET · POST (admin) · POST /:id/archive|restore (admin)
//   /api/directory/check-duplicates                  POST (creators) — only visible matches are described
//   /api/directory/:id                               GET details · PATCH identity (admin)
//   /api/directory/:id/archive|restore               POST (admin)
//   /api/directory/:id/contacts                      POST (creators)
//   /api/directory/contacts/:cid                     PATCH · /archive · /restore (admin)
//   /api/directory/:id/assignments                   POST (admin: any project · PM: own projects)
//   /api/directory/assignments/:aid                  PATCH · /archive · /restore (same rule)
//   /api/directory/:id/documents                     GET · POST (shared: admin · project: creators on own projects)
//   /api/directory/:id/documents/:docId/download     GET · /archive POST
//   /api/directory/:id/suggestions                   GET possible matches among unlinked records (never linked automatically)
//   /api/directory/:id/link                          POST link ONE existing record after review
//   /api/projects/:projectId/directory               GET entries assigned to the project (form selectors)
//
// Visibility (server-side for every endpoint): admin → everything; project manager → active entries
// (the shared directory, so an entry can be reused) plus archived entries assigned to their projects;
// viewer → entries with an active assignment to one of their projects; contractors / consultants →
// no access. Assignments, documents and related records are always limited to projects the user can
// open, so another project's name, records or files never appear.
// Adding a contact or an assignment never creates a login, grants access, or changes any record.
import { Router, type Request } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { assertCap } from '../auth';
import { badRequest, conflict, forbidden, HttpError, notFound, parseBody, parsePatch, uuidParam, zDate, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { can, type Capability } from '../permissions';
import { BUSINESS_ROLES, DIRECTORY_DOCUMENT_KINDS, ENTITY_TYPES, findDuplicates, normalizePhone, similarNames, type DuplicateCandidate } from '../../shared/directory';
import { contentDisposition, detectFileType, fileCsp, INLINE_TYPES, storedTypeMatches } from './attachments';

type Db = pg.Pool | pg.PoolClient;
type User = NonNullable<Request['user']>;

const zEmail = z.string().trim().max(254).refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'must be a valid email address');
const zRoles = z.array(z.enum(BUSINESS_ROLES)).min(1, 'Choose at least one role').max(BUSINESS_ROLES.length);
const uuidOrNull = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable());

const entrySchema = z.object({
  display_name: zText(200).min(1, 'Display name is required'),
  entity_type: z.enum(ENTITY_TYPES),
  roles: zRoles,
  specializations: z.array(zText(80).min(1)).max(30).default([]),
  phone: zText(40).default(''),
  email: zEmail.default(''),
  address: zText(500).default(''),
  website: zUrl.default(''),
  registration_no: zText(80).default(''),
  drive_url: zUrl.default(''),
  quotations_url: zUrl.default(''),
  notes: zText(4000).default(''),
});
const contactSchema = z.object({
  name: zText(200).min(1, 'Name is required'),
  position: zText(120).default(''),
  mobile: zText(40).default(''),
  email: zEmail.default(''),
  is_primary: z.boolean().default(false),
  notes: zText(2000).default(''),
});
const assignmentSchema = z.object({
  project_id: z.string().uuid(),
  roles: zRoles,
  scope: zText(4000).default(''),
  responsible_contact_id: uuidOrNull.optional(),
  start_date: zDate.optional(),
  end_date: zDate.optional(),
  notes: zText(2000).default(''),
});

// ------------------------------------------------------------------ access helpers
export interface ProjectRef { id: string; code: string; name: string; archived_at: string | null }

/** Projects the user can open: admins all, others their assigned, non-archived projects. */
export async function accessibleProjects(db: Db, user: User): Promise<ProjectRef[]> {
  const { rows } = await db.query(
    user.role === 'admin'
      ? 'SELECT id, code, name, archived_at FROM projects ORDER BY archived_at NULLS FIRST, name'
      : `SELECT p.id, p.code, p.name, p.archived_at FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
          WHERE p.archived_at IS NULL ORDER BY p.name`,
    user.role === 'admin' ? [] : [user.id],
  );
  return rows;
}

/** SQL condition (alias e) for entries the user may see; `$n` is the accessible project id array. */
function visibleSql(user: User, n: number): string {
  if (user.role === 'admin') return `($${n}::uuid[] IS NULL OR TRUE)`; // parameter kept so its type is known
  if (can(user.role, 'directory.create')) {
    return `(e.archived_at IS NULL OR EXISTS (SELECT 1 FROM directory_assignments va WHERE va.entry_id = e.id AND va.project_id = ANY($${n}::uuid[])))`;
  }
  return `EXISTS (SELECT 1 FROM directory_assignments va WHERE va.entry_id = e.id AND va.archived_at IS NULL AND va.project_id = ANY($${n}::uuid[]))`;
}

async function getVisibleEntry(db: Db, user: User, id: string, projectIds: string[], forUpdate = false) {
  const { rows } = await db.query(`SELECT e.* FROM directory_entries e WHERE e.id = $1 AND ${visibleSql(user, 2)}${forUpdate ? ' FOR UPDATE' : ''}`, [id, projectIds]);
  if (!rows[0]) throw notFound('Directory entry not found');
  return rows[0] as Record<string, any>;
}

/** May the user change assignments / project documents for this project? (never for archived projects) */
async function assertProjectWritable(db: Db, user: User, projectId: string) {
  if (!can(user.role, 'directory.create')) throw forbidden();
  const { rows } = await db.query(
    user.role === 'admin'
      ? 'SELECT id, code, archived_at FROM projects WHERE id = $1'
      : `SELECT p.id, p.code, p.archived_at FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $2 WHERE p.id = $1`,
    user.role === 'admin' ? [projectId] : [projectId, user.id],
  );
  if (!rows[0]) throw badRequest('Project not found or not one of your projects');
  if (rows[0].archived_at) throw conflict('This project is archived. Restore it before making changes.');
  return rows[0] as { id: string; code: string };
}

async function assertSpecializations(db: Db, names: string[], current: string[] = []) {
  if (!names.length) return;
  const { rows } = await db.query('SELECT name FROM directory_specializations WHERE archived_at IS NULL');
  const ok = new Set(rows.map((r) => r.name));
  const bad = names.filter((n) => !ok.has(n) && !current.includes(n));
  if (bad.length) throw badRequest(`Unknown specialization: ${bad.join(', ')}. Ask an admin to add it.`);
}

async function assertContactOfEntry(db: Db, entryId: string, contactId: string | null | undefined, allowArchived = false) {
  if (!contactId) return;
  const { rows } = await db.query('SELECT archived_at FROM directory_contacts WHERE id = $1 AND entry_id = $2', [contactId, entryId]);
  if (!rows[0]) throw badRequest('That contact person does not belong to this company / individual');
  if (rows[0].archived_at && !allowArchived) throw badRequest('That contact person is archived');
}

const entryOut = (e: Record<string, any>) => ({
  id: e.id, ref: e.ref, display_name: e.display_name, entity_type: e.entity_type, roles: e.roles, specializations: e.specializations,
  phone: e.phone, email: e.email, address: e.address, website: e.website, registration_no: e.registration_no,
  drive_url: e.drive_url, quotations_url: e.quotations_url, notes: e.notes, archived_at: e.archived_at,
  created_at: e.created_at, updated_at: e.updated_at, created_by_name: e.created_by_name ?? null, updated_by_name: e.updated_by_name ?? null,
});

// ------------------------------------------------------------------ related records (authorised, own projects only)
const RECORD_TYPES = {
  contract: { table: 'contracts', cap: 'contracts.read', write: 'contracts.write', text: 'company_name', label: 'title' },
  payment_milestone: { table: 'payment_milestones', cap: 'payments.read', write: 'payments.write', text: 'payee_name', label: 'description' },
  material: { table: 'material_items', cap: 'materials.read', write: 'materials.write', text: 'vendor', label: 'description' },
  consultant_visit: { table: 'consultant_visits', cap: 'consultant.read', write: 'consultant.write', text: 'consultant_name', label: 'purpose' },
  site_visit: { table: 'site_visits', cap: 'site.read', write: 'site.write', text: 'assigned_name', label: 'purpose' },
  timeline_task: { table: 'timeline_tasks', cap: 'timeline.read', write: 'timeline.write', text: 'responsible', label: 'name' },
} as const;
type RecordType = keyof typeof RECORD_TYPES;

async function relatedRecords(db: Db, user: User, entryId: string, projects: ProjectRef[]) {
  const ids = projects.map((p) => p.id);
  const code = new Map(projects.map((p) => [p.id, p.code]));
  const out: Record<string, unknown[]> = {};
  const finance = can(user.role, 'payments.read');
  const q = async (type: RecordType, sql: string) => {
    if (!can(user.role, RECORD_TYPES[type].cap as Capability)) return;
    const { rows } = await db.query(sql, [entryId, ids]);
    out[type] = rows.map((r) => ({ ...r, project_code: code.get(r.project_id) ?? '' }));
  };
  await q('contract', `SELECT k.id, k.project_id, k.title, k.company_name, k.status, k.archived_at${finance ? ', k.contract_value' : ''}
      FROM contracts k WHERE k.directory_entry_id = $1 AND k.project_id = ANY($2::uuid[]) ORDER BY k.created_at`);
  if (finance) {
    await q('payment_milestone', `SELECT m.id, m.project_id, m.payee_name, m.description, m.due_date, m.status, m.scheduled_amount, m.archived_at,
        COALESCE((SELECT SUM(t.amount) FROM payment_transactions t WHERE t.milestone_id = m.id AND t.archived_at IS NULL), 0)::float AS paid,
        (SELECT count(*)::int FROM payment_transactions t WHERE t.milestone_id = m.id AND t.archived_at IS NULL) AS transfer_count
      FROM payment_milestones m WHERE m.directory_entry_id = $1 AND m.project_id = ANY($2::uuid[]) ORDER BY m.due_date NULLS LAST, m.created_at`);
  }
  await q('material', `SELECT x.id, x.project_id, x.description, x.category, x.status, x.vendor, x.archived_at
      FROM material_items x WHERE x.directory_entry_id = $1 AND x.project_id = ANY($2::uuid[]) ORDER BY x.created_at`);
  await q('consultant_visit', `SELECT v.id, v.project_id, v.purpose, v.planned_at, v.status, v.consultant_name, v.archived_at
      FROM consultant_visits v WHERE v.directory_entry_id = $1 AND v.project_id = ANY($2::uuid[]) ORDER BY v.planned_at NULLS LAST`);
  await q('site_visit', `SELECT v.id, v.project_id, v.purpose, v.visit_at, v.status, v.assigned_name, v.archived_at
      FROM site_visits v WHERE v.directory_entry_id = $1 AND v.project_id = ANY($2::uuid[]) ORDER BY v.visit_at NULLS LAST`);
  await q('timeline_task', `SELECT t.id, t.project_id, t.name, t.status, t.planned_end, t.responsible, t.archived_at
      FROM timeline_tasks t WHERE t.directory_entry_id = $1 AND t.project_id = ANY($2::uuid[]) ORDER BY t.planned_end NULLS LAST`);
  return out;
}

async function listDocuments(db: Db, entryId: string, projectIds: string[]) {
  const { rows } = await db.query(
    `SELECT a.id, a.project_id, a.kind, a.original_name, a.mime_type, a.size_bytes, a.created_at, u.name AS uploaded_by_name, p.code AS project_code
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.entity_type = 'directory_entry' AND a.entity_id = $1 AND a.archived_at IS NULL
        AND (a.project_id IS NULL OR a.project_id = ANY($2::uuid[]))
      ORDER BY a.project_id NULLS FIRST, a.created_at DESC`,
    [entryId, projectIds],
  );
  return rows;
}

// ------------------------------------------------------------------ routes
export function directoryRoutes(pool: pg.Pool, cfg: AppConfig) {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 10 } });

  r.get('/', async (req, res) => {
    assertCap(req, 'directory.read');
    const user = req.user!;
    const projects = await accessibleProjects(pool, user);
    const ids = projects.map((p) => p.id);
    const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
    const qd = q.replace(/\D/g, '').length >= 4 ? q.replace(/\D/g, '').replace(/^0+/, '') : '';
    const role = (BUSINESS_ROLES as readonly string[]).includes(String(req.query.role)) ? String(req.query.role) : '';
    const spec = String(req.query.spec ?? '').slice(0, 80);
    const project = typeof req.query.project === 'string' && ids.includes(req.query.project) ? req.query.project : '';
    const projectRequested = typeof req.query.project === 'string' && req.query.project !== '';
    const status = ['active', 'archived', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'active';
    if (projectRequested && !project) return res.json({ entries: [], projects, ...flags(user) });
    const like = `%${q}%`;
    const { rows } = await pool.query(
      `SELECT e.*,
              (SELECT row_to_json(c) FROM (SELECT id, name, position, mobile, email FROM directory_contacts c
                  WHERE c.entry_id = e.id AND c.archived_at IS NULL ORDER BY c.is_primary DESC, c.created_at LIMIT 1) c) AS primary_contact,
              (SELECT count(*)::int FROM directory_contacts c WHERE c.entry_id = e.id AND c.archived_at IS NULL) AS contact_count
         FROM directory_entries e
        WHERE ${visibleSql(user, 1)}
          AND ($2 = 'all' OR ($2 = 'active' AND e.archived_at IS NULL) OR ($2 = 'archived' AND e.archived_at IS NOT NULL))
          AND ($3 = '' OR $3 = ANY(e.roles))
          AND ($4 = '' OR $4 = ANY(e.specializations))
          AND ($5 = '' OR EXISTS (SELECT 1 FROM directory_assignments pa WHERE pa.entry_id = e.id AND pa.project_id::text = $5 AND pa.archived_at IS NULL))
          AND ($6 = '' OR lower(e.display_name) LIKE $7 OR lower(e.ref) LIKE $7 OR lower(e.email) LIKE $7 OR lower(e.registration_no) LIKE $7
               OR ($8 <> '' AND e.phone_normalized LIKE '%' || $8 || '%')
               OR EXISTS (SELECT 1 FROM directory_contacts sc WHERE sc.entry_id = e.id AND sc.archived_at IS NULL
                           AND (lower(sc.name) LIKE $7 OR lower(sc.email) LIKE $7 OR ($8 <> '' AND sc.mobile_normalized LIKE '%' || $8 || '%'))))
        ORDER BY e.archived_at NULLS FIRST, lower(e.display_name)
        LIMIT 500`,
      [ids, status, role, spec, project, q, like, qd],
    );
    const entryIds = rows.map((e) => e.id);
    const { rows: asg } = entryIds.length ? await pool.query(
      `SELECT a.id, a.entry_id, a.project_id, a.roles, a.archived_at FROM directory_assignments a
        WHERE a.entry_id = ANY($1::uuid[]) AND a.project_id = ANY($2::uuid[]) ORDER BY a.created_at`, [entryIds, ids]) : { rows: [] };
    const pmap = new Map(projects.map((p) => [p.id, p]));
    res.json({
      entries: rows.map((e) => ({
        ...entryOut(e), primary_contact: e.primary_contact, contact_count: e.contact_count,
        assignments: asg.filter((a) => a.entry_id === e.id).map((a) => ({ id: a.id, project_id: a.project_id, project_code: pmap.get(a.project_id)?.code ?? '', project_name: pmap.get(a.project_id)?.name ?? '', roles: a.roles, archived_at: a.archived_at })),
      })),
      projects,
      ...flags(user),
    });
  });

  const flags = (user: User) => ({ canCreate: can(user.role, 'directory.create'), canManage: can(user.role, 'directory.manage') });

  // ---- specializations (configurable list)
  r.get('/specializations', async (req, res) => {
    assertCap(req, 'directory.read');
    res.json((await pool.query('SELECT id, name, sort_order, archived_at FROM directory_specializations ORDER BY sort_order, lower(name)')).rows);
  });
  r.post('/specializations', async (req, res) => {
    assertCap(req, 'directory.manage');
    const body = parseBody(z.object({ name: zText(80).min(1) }), req);
    const row = await withTx(pool, async (c) => {
      const { rows: dup } = await c.query('SELECT id FROM directory_specializations WHERE lower(btrim(name)) = lower(btrim($1))', [body.name]);
      if (dup[0]) throw conflict('That specialization already exists');
      const { rows } = await c.query(
        `INSERT INTO directory_specializations (name, sort_order) VALUES ($1, (SELECT COALESCE(MAX(sort_order),0)+1 FROM directory_specializations)) RETURNING *`, [body.name]);
      await audit(c, req, { projectId: null, action: 'create', entityType: 'directory_specialization', entityId: rows[0].id, summary: `Added specialization ${body.name}` });
      return rows[0];
    });
    res.status(201).json(row);
  });
  for (const action of ['archive', 'restore'] as const) {
    r.post(`/specializations/:id/${action}`, async (req, res) => {
      assertCap(req, 'directory.manage');
      const id = uuidParam(req, 'id');
      const { rows } = await pool.query(`UPDATE directory_specializations SET archived_at = ${action === 'archive' ? 'now()' : 'NULL'} WHERE id = $1 RETURNING *`, [id]);
      if (!rows[0]) throw notFound();
      await audit(pool, req, { projectId: null, action, entityType: 'directory_specialization', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} specialization ${rows[0].name}` });
      res.json(rows[0]);
    });
  }

  // ---- duplicate warnings (never reveal entries the user cannot see)
  r.post('/check-duplicates', async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const body = parseBody(z.object({
      display_name: zText(200).default(''), phone: zText(40).default(''), email: zText(254).default(''), registration_no: zText(80).default(''),
      contact_phones: z.array(zText(40)).max(20).default([]), exclude_id: z.string().uuid().optional(),
    }), req);
    const ids = (await accessibleProjects(pool, user)).map((p) => p.id);
    const { rows } = await pool.query(
      `SELECT e.id, e.ref, e.display_name, e.entity_type, e.archived_at, e.phone_normalized, e.email, e.registration_no, (${visibleSql(user, 1)}) AS visible,
              COALESCE((SELECT json_agg(json_build_object('name', c.name, 'mobile_normalized', c.mobile_normalized, 'email', c.email))
                          FROM directory_contacts c WHERE c.entry_id = e.id AND c.archived_at IS NULL), '[]') AS contacts
         FROM directory_entries e`, [ids]);
    const matches = findDuplicates(body, rows as DuplicateCandidate[], body.exclude_id);
    const visible = new Set(rows.filter((x) => x.visible).map((x) => x.id));
    res.json({
      matches: matches.filter((m) => visible.has(m.id)),
      hiddenMatch: matches.some((m) => !visible.has(m.id))
        ? 'A similar entry may already exist that you cannot open. Ask an administrator before creating a new one.' : null,
    });
  });

  // ---- create (optionally assign to one of the user's projects in the same step)
  r.post('/', async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const body = parseBody(entrySchema.extend({
      assign: z.object({ project_id: z.string().uuid(), roles: zRoles, scope: zText(4000).default('') }).optional(),
    }), req);
    const { assign, ...data } = body;
    const out = await withTx(pool, async (c) => {
      await assertSpecializations(c, data.specializations);
      const project = assign ? await assertProjectWritable(c, user, assign.project_id) : null;
      const { rows } = await c.query(
        `INSERT INTO directory_entries (display_name, entity_type, roles, specializations, phone, phone_normalized, email, address, website,
                                        registration_no, drive_url, quotations_url, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
        [data.display_name, data.entity_type, data.roles, data.specializations, data.phone, normalizePhone(data.phone), data.email, data.address,
          data.website, data.registration_no, data.drive_url, data.quotations_url, data.notes, user.id],
      );
      const e = rows[0];
      await audit(c, req, { projectId: null, action: 'create', entityType: 'directory_entry', entityId: e.id, summary: `Added directory entry ${e.ref} ${e.display_name}`, after: entryOut(e) });
      let assignment = null;
      if (assign && project) {
        const a = await c.query(
          `INSERT INTO directory_assignments (entry_id, project_id, roles, scope, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [e.id, project.id, assign.roles, assign.scope, user.id]);
        assignment = a.rows[0];
        await audit(c, req, { projectId: project.id, action: 'create', entityType: 'directory_assignment', entityId: assignment.id, summary: `Assigned ${e.ref} ${e.display_name} to this project`, after: assignment });
      }
      return { ...entryOut(e), assignment };
    });
    res.status(201).json(out);
  });

  // ---- details
  r.get('/:id', async (req, res) => {
    assertCap(req, 'directory.read');
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const projects = await accessibleProjects(pool, user);
    const ids = projects.map((p) => p.id);
    const e = await getVisibleEntry(pool, user, id, ids);
    const [who, contacts, asg, docs, related] = await Promise.all([
      pool.query('SELECT (SELECT name FROM users WHERE id = $1) AS c, (SELECT name FROM users WHERE id = $2) AS u', [e.created_by, e.updated_by]),
      pool.query('SELECT * FROM directory_contacts WHERE entry_id = $1 ORDER BY archived_at NULLS FIRST, is_primary DESC, created_at', [id]),
      pool.query(
        `SELECT a.*, c.name AS responsible_contact_name FROM directory_assignments a LEFT JOIN directory_contacts c ON c.id = a.responsible_contact_id
          WHERE a.entry_id = $1 AND a.project_id = ANY($2::uuid[]) ORDER BY a.archived_at NULLS FIRST, a.created_at`, [id, ids]),
      listDocuments(pool, id, ids),
      relatedRecords(pool, user, id, projects),
    ]);
    const pmap = new Map(projects.map((p) => [p.id, p]));
    const creator = can(user.role, 'directory.create');
    const writableProjects = creator ? projects.filter((p) => !p.archived_at) : [];
    res.json({
      entry: { ...entryOut(e), created_by_name: who.rows[0].c, updated_by_name: who.rows[0].u },
      contacts: contacts.rows,
      assignments: asg.rows.map((a) => ({ ...a, project_code: pmap.get(a.project_id)?.code ?? '', project_name: pmap.get(a.project_id)?.name ?? '' })),
      documents: docs,
      related,
      permissions: {
        canEdit: can(user.role, 'directory.manage'),
        canAddContact: creator && !e.archived_at,
        canAssign: creator && !e.archived_at,
        canUploadShared: can(user.role, 'directory.manage') && !e.archived_at,
        writableProjects: writableProjects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
      },
    });
  });

  // ---- identity edits (admin only in this version; never rewrites names saved on other records)
  r.patch('/:id', async (req, res) => {
    assertCap(req, 'directory.manage');
    const id = uuidParam(req, 'id');
    const body = parsePatch(entrySchema.partial(), req) as Record<string, unknown>;
    const out = await withTx(pool, async (c) => {
      const cur = await getVisibleEntry(c, req.user!, id, [], true);
      if (cur.archived_at) throw conflict('This entry is archived. Restore it before editing.');
      if (body.specializations) await assertSpecializations(c, body.specializations as string[], cur.specializations);
      if (body.phone !== undefined) body.phone_normalized = normalizePhone(body.phone as string);
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (!keys.length) return entryOut(cur);
      const { rows } = await c.query(
        `UPDATE directory_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => body[k]), req.user!.id]);
      const d = diff(entryOut(cur), entryOut(rows[0]));
      await audit(c, req, { projectId: null, action: 'update', entityType: 'directory_entry', entityId: id, summary: `Edited ${rows[0].ref} ${rows[0].display_name} (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return entryOut(rows[0]);
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/:id/${action}`, async (req, res) => {
      assertCap(req, 'directory.manage');
      const id = uuidParam(req, 'id');
      const out = await withTx(pool, async (c) => {
        await getVisibleEntry(c, req.user!, id, [], true);
        const { rows } = await c.query(`UPDATE directory_entries SET archived_at = ${action === 'archive' ? 'now()' : 'NULL'}, updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, req.user!.id]);
        await audit(c, req, { projectId: null, action, entityType: 'directory_entry', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} ${rows[0].ref} ${rows[0].display_name} (existing links are kept)` });
        return entryOut(rows[0]);
      });
      res.json(out);
    });
  }

  // ---- contact people
  r.post('/:id/contacts', async (req, res) => {
    assertCap(req, 'directory.create');
    const id = uuidParam(req, 'id');
    const body = parseBody(contactSchema, req);
    const ids = (await accessibleProjects(pool, req.user!)).map((p) => p.id);
    const row = await withTx(pool, async (c) => {
      const e = await getVisibleEntry(c, req.user!, id, ids, true);
      if (e.archived_at) throw conflict('This entry is archived');
      if (body.is_primary) await c.query('UPDATE directory_contacts SET is_primary = false, updated_at = now() WHERE entry_id = $1 AND is_primary', [id]);
      const { rows } = await c.query(
        `INSERT INTO directory_contacts (entry_id, name, position, mobile, mobile_normalized, email, is_primary, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, body.name, body.position, body.mobile, normalizePhone(body.mobile), body.email, body.is_primary, body.notes, req.user!.id]);
      await audit(c, req, { projectId: null, action: 'create', entityType: 'directory_contact', entityId: rows[0].id, summary: `Added contact ${body.name} to ${e.ref} ${e.display_name}`, after: rows[0] });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.patch('/contacts/:cid', async (req, res) => {
    assertCap(req, 'directory.manage');
    const cid = uuidParam(req, 'cid');
    const body = parsePatch(contactSchema.partial(), req) as Record<string, unknown>;
    const out = await withTx(pool, async (c) => {
      const { rows: cur } = await c.query('SELECT * FROM directory_contacts WHERE id = $1 FOR UPDATE', [cid]);
      if (!cur[0]) throw notFound('Contact not found');
      if (cur[0].archived_at) throw conflict('This contact is archived. Restore it before editing.');
      if (body.mobile !== undefined) body.mobile_normalized = normalizePhone(body.mobile as string);
      if (body.is_primary === true) await c.query('UPDATE directory_contacts SET is_primary = false, updated_at = now() WHERE entry_id = $1 AND is_primary AND id <> $2', [cur[0].entry_id, cid]);
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (!keys.length) return cur[0];
      const { rows } = await c.query(`UPDATE directory_contacts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [cid, ...keys.map((k) => body[k])]);
      const d = diff(cur[0], rows[0]);
      await audit(c, req, { projectId: null, action: 'update', entityType: 'directory_contact', entityId: cid, summary: `Edited contact ${rows[0].name} (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return rows[0];
    });
    res.json(out);
  });
  for (const action of ['archive', 'restore'] as const) {
    r.post(`/contacts/:cid/${action}`, async (req, res) => {
      assertCap(req, 'directory.manage');
      const cid = uuidParam(req, 'cid');
      const out = await withTx(pool, async (c) => {
        const { rows: cur } = await c.query('SELECT * FROM directory_contacts WHERE id = $1 FOR UPDATE', [cid]);
        if (!cur[0]) throw notFound('Contact not found');
        if (action === 'restore' && cur[0].is_primary) {
          const { rowCount } = await c.query('SELECT 1 FROM directory_contacts WHERE entry_id = $1 AND is_primary AND archived_at IS NULL AND id <> $2', [cur[0].entry_id, cid]);
          if (rowCount) await c.query('UPDATE directory_contacts SET is_primary = false WHERE id = $1', [cid]);
        }
        const { rows } = await c.query(`UPDATE directory_contacts SET archived_at = ${action === 'archive' ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING *`, [cid]);
        await audit(c, req, { projectId: null, action, entityType: 'directory_contact', entityId: cid, summary: `${action === 'archive' ? 'Archived' : 'Restored'} contact ${rows[0].name} (existing links are kept)` });
        return rows[0];
      });
      res.json(out);
    });
  }

  // ---- project assignments
  r.post('/:id/assignments', async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const body = parseBody(assignmentSchema, req);
    const ids = (await accessibleProjects(pool, user)).map((p) => p.id);
    try {
      const row = await withTx(pool, async (c) => {
        const e = await getVisibleEntry(c, user, id, ids);
        if (e.archived_at) throw conflict('This entry is archived and cannot be assigned');
        await assertProjectWritable(c, user, body.project_id);
        await assertContactOfEntry(c, id, body.responsible_contact_id);
        const { rows } = await c.query(
          `INSERT INTO directory_assignments (entry_id, project_id, roles, scope, responsible_contact_id, start_date, end_date, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id, body.project_id, body.roles, body.scope, body.responsible_contact_id ?? null, body.start_date ?? null, body.end_date ?? null, body.notes, user.id]);
        await audit(c, req, { projectId: body.project_id, action: 'create', entityType: 'directory_assignment', entityId: rows[0].id, summary: `Assigned ${e.ref} ${e.display_name} to this project`, after: rows[0] });
        return rows[0];
      });
      res.status(201).json(row);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('This entry is already assigned to that project. Edit the existing assignment instead.');
      if ((err as { code?: string }).code === '23514') throw badRequest('End date cannot be before the start date');
      throw err;
    }
  });

  const loadAssignment = async (c: Db, user: User, aid: string) => {
    const { rows } = await c.query('SELECT a.*, e.ref, e.display_name FROM directory_assignments a JOIN directory_entries e ON e.id = a.entry_id WHERE a.id = $1', [aid]);
    if (!rows[0]) throw notFound('Assignment not found');
    const ids = (await accessibleProjects(c, user)).map((p) => p.id);
    if (!ids.includes(rows[0].project_id)) throw notFound('Assignment not found');
    await assertProjectWritable(c, user, rows[0].project_id);
    return rows[0] as Record<string, any>;
  };

  r.patch('/assignments/:aid', async (req, res) => {
    assertCap(req, 'directory.create');
    const aid = uuidParam(req, 'aid');
    const body = parsePatch(assignmentSchema.omit({ project_id: true }).partial(), req) as Record<string, unknown>;
    try {
      const out = await withTx(pool, async (c) => {
        const cur = await loadAssignment(c, req.user!, aid);
        if (body.responsible_contact_id !== undefined && body.responsible_contact_id !== cur.responsible_contact_id) await assertContactOfEntry(c, cur.entry_id, body.responsible_contact_id as string | null);
        const keys = Object.keys(body).filter((k) => body[k] !== undefined);
        if (!keys.length) return cur;
        const { rows } = await c.query(`UPDATE directory_assignments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [aid, ...keys.map((k) => body[k])]);
        const d = diff(cur, rows[0]);
        await audit(c, req, { projectId: cur.project_id, action: 'update', entityType: 'directory_assignment', entityId: aid, summary: `Edited assignment of ${cur.ref} ${cur.display_name} (${d.changed.join(', ')})`, before: d.before, after: d.after });
        return rows[0];
      });
      res.json(out);
    } catch (err) {
      if ((err as { code?: string }).code === '23514') throw badRequest('End date cannot be before the start date');
      throw err;
    }
  });
  for (const action of ['archive', 'restore'] as const) {
    r.post(`/assignments/:aid/${action}`, async (req, res) => {
      assertCap(req, 'directory.create');
      const aid = uuidParam(req, 'aid');
      try {
        const out = await withTx(pool, async (c) => {
          const cur = await loadAssignment(c, req.user!, aid);
          const { rows } = await c.query(`UPDATE directory_assignments SET archived_at = ${action === 'archive' ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING *`, [aid]);
          await audit(c, req, { projectId: cur.project_id, action, entityType: 'directory_assignment', entityId: aid, summary: `${action === 'archive' ? 'Ended / archived' : 'Restored'} assignment of ${cur.ref} ${cur.display_name} (existing record links are kept)` });
          return rows[0];
        });
        res.json(out);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('There is already an active assignment for this project');
        throw err;
      }
    });
  }

  // ---- documents (shared company documents, or project-specific documents restricted to their project)
  r.get('/:id/documents', async (req, res) => {
    assertCap(req, 'directory.read');
    const ids = (await accessibleProjects(pool, req.user!)).map((p) => p.id);
    await getVisibleEntry(pool, req.user!, uuidParam(req, 'id'), ids);
    res.json(await listDocuments(pool, uuidParam(req, 'id'), ids));
  });

  r.post('/:id/documents', (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${cfg.maxUploadMb} MB limit` : err.message));
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ kind: z.enum(DIRECTORY_DOCUMENT_KINDS), visibility: z.union([z.literal('shared'), z.string().uuid()]) }), req);
    const ids = (await accessibleProjects(pool, user)).map((p) => p.id);
    const e = await getVisibleEntry(pool, user, id, ids);
    if (e.archived_at) throw conflict('This entry is archived');
    let projectId: string | null = null;
    if (body.visibility === 'shared') {
      if (!can(user.role, 'directory.manage')) throw forbidden('Only an admin can add shared company documents. Add it as a project document instead.');
    } else {
      await assertProjectWritable(pool, user, body.visibility);
      const { rowCount } = await pool.query('SELECT 1 FROM directory_assignments WHERE entry_id = $1 AND project_id = $2 AND archived_at IS NULL', [id, body.visibility]);
      if (!rowCount) throw badRequest('Assign this entry to the project before adding project documents');
      projectId = body.visibility;
    }
    const file = req.file;
    if (!file || !file.size) throw badRequest('A file is required');
    const originalName = path.basename(file.originalname).replace(/[\u0000-\u001f"\\]/g, '_').slice(0, 200) || 'file';
    const detected = detectFileType(file.buffer, originalName);
    if (!detected) throw new HttpError(415, 'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, HEIC, DOCX, XLSX.');
    const storedName = `${crypto.randomUUID()}${detected.ext}`;
    const dir = path.join(cfg.uploadDir, projectId ?? '_directory');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
    const fullPath = path.join(dir, storedName);
    await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o640 });
    try {
      const row = await withTx(pool, async (c) => {
        const { rows } = await c.query(
          `INSERT INTO attachments (project_id, entity_type, entity_id, kind, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
           VALUES ($1,'directory_entry',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, project_id, kind, original_name, mime_type, size_bytes, created_at`,
          [projectId, id, body.kind, originalName, storedName, detected.mime, file.size, crypto.createHash('sha256').update(file.buffer).digest('hex'), user.id]);
        await audit(c, req, { projectId, action: 'upload', entityType: 'directory_entry', entityId: id, summary: `Uploaded ${projectId ? 'project' : 'shared'} document for ${e.ref} ${e.display_name}: ${originalName}`, after: rows[0] });
        return rows[0];
      });
      res.status(201).json(row);
    } catch (err) {
      await fs.promises.unlink(fullPath).catch(() => undefined);
      throw err;
    }
  });

  const loadDocument = async (db: Db, req: Request) => {
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const docId = uuidParam(req, 'docId');
    const ids = (await accessibleProjects(db, user)).map((p) => p.id);
    await getVisibleEntry(db, user, id, ids);
    const { rows } = await db.query(`SELECT * FROM attachments WHERE id = $1 AND entity_type = 'directory_entry' AND entity_id = $2`, [docId, id]);
    const a = rows[0];
    if (!a || a.archived_at || (a.project_id && !ids.includes(a.project_id))) throw notFound();
    return a as Record<string, any>;
  };

  r.get('/:id/documents/:docId/download', async (req, res) => {
    assertCap(req, 'directory.read');
    const a = await loadDocument(pool, req);
    const full = path.join(cfg.uploadDir, a.project_id ?? '_directory', path.basename(a.stored_name));
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw notFound('File is missing from storage');
    }
    const inline = req.query.inline === '1' && INLINE_TYPES.has(a.mime_type) && (await storedTypeMatches(full, a.mime_type, a.original_name));
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Security-Policy', fileCsp(a.mime_type, inline));
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', a.original_name));
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  r.post('/:id/documents/:docId/archive', async (req, res) => {
    assertCap(req, 'directory.create');
    const out = await withTx(pool, async (c) => {
      const a = await loadDocument(c, req);
      if (!a.project_id) { if (!can(req.user!.role, 'directory.manage')) throw forbidden('Only an admin can archive shared company documents'); }
      else await assertProjectWritable(c, req.user!, a.project_id);
      await c.query('UPDATE attachments SET archived_at = now() WHERE id = $1', [a.id]);
      await audit(c, req, { projectId: a.project_id, action: 'archive', entityType: 'attachment', entityId: a.id, summary: `Archived directory document ${a.original_name}` });
      return { ok: true };
    });
    res.json(out);
  });

  // ---- possible matches among unlinked existing records (shown for review; never linked automatically)
  r.get('/:id/suggestions', async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const projects = (await accessibleProjects(pool, user)).filter((p) => !p.archived_at);
    const ids = projects.map((p) => p.id);
    const e = await getVisibleEntry(pool, user, id, ids);
    const { rows: asg } = await pool.query('SELECT project_id FROM directory_assignments WHERE entry_id = $1 AND archived_at IS NULL', [id]);
    const assigned = new Set(asg.map((a) => a.project_id));
    const code = new Map(projects.map((p) => [p.id, p.code]));
    const out: unknown[] = [];
    for (const [type, t] of Object.entries(RECORD_TYPES) as Array<[RecordType, (typeof RECORD_TYPES)[RecordType]]>) {
      if (!can(user.role, t.write as Capability)) continue;
      const { rows } = await pool.query(
        `SELECT id, project_id, ${t.text} AS original_name, ${t.label} AS label FROM ${t.table}
          WHERE directory_entry_id IS NULL AND archived_at IS NULL AND project_id = ANY($1::uuid[]) AND btrim(${t.text}) <> ''`, [ids]);
      for (const r0 of rows) {
        if (!similarNames(r0.original_name, e.display_name)) continue;
        out.push({ type, id: r0.id, project_id: r0.project_id, project_code: code.get(r0.project_id) ?? '', original_name: r0.original_name, label: r0.label, assigned: assigned.has(r0.project_id) });
      }
    }
    res.json({ entry: { id: e.id, ref: e.ref, display_name: e.display_name }, suggestions: out });
  });

  r.post('/:id/link', async (req, res) => {
    assertCap(req, 'directory.create');
    const user = req.user!;
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ type: z.enum(Object.keys(RECORD_TYPES) as [RecordType, ...RecordType[]]), record_id: z.string().uuid() }), req);
    const t = RECORD_TYPES[body.type];
    if (!can(user.role, t.write as Capability)) throw forbidden();
    const ids = (await accessibleProjects(pool, user)).map((p) => p.id);
    const out = await withTx(pool, async (c) => {
      const e = await getVisibleEntry(c, user, id, ids);
      if (e.archived_at) throw conflict('This entry is archived and cannot be linked to more records');
      const { rows } = await c.query(`SELECT id, project_id, directory_entry_id, ${t.text} AS original_name, ${t.label} AS label FROM ${t.table} WHERE id = $1 FOR UPDATE`, [body.record_id]);
      const rec = rows[0];
      if (!rec || !ids.includes(rec.project_id)) throw notFound('Record not found');
      await assertProjectWritable(c, user, rec.project_id);
      if (rec.directory_entry_id) throw conflict('This record is already linked. Change the link in the record itself.');
      const { rowCount } = await c.query('SELECT 1 FROM directory_assignments WHERE entry_id = $1 AND project_id = $2 AND archived_at IS NULL', [id, rec.project_id]);
      if (!rowCount) throw badRequest('Assign this entry to the project first, then link the record');
      await c.query(`UPDATE ${t.table} SET directory_entry_id = $2, updated_at = now() WHERE id = $1`, [rec.id, id]);
      await audit(c, req, {
        projectId: rec.project_id, action: 'directory_link', entityType: body.type, entityId: rec.id,
        summary: `Linked "${rec.label}" (recorded name "${rec.original_name}", unchanged) to ${e.ref} ${e.display_name}`,
        before: { directory_entry_id: null }, after: { directory_entry_id: id },
      });
      return { ok: true, type: body.type, record_id: rec.id };
    });
    res.json(out);
  });

  return r;
}

/** Entries assigned (active) to one project, with their active contacts — for record form selectors. */
export function projectDirectoryRoute(pool: pg.Pool) {
  const r = Router({ mergeParams: true });
  r.get('/', async (req, res) => {
    assertCap(req, 'directory.read');
    const pid = req.project!.id;
    const { rows } = await pool.query(
      `SELECT e.id, e.ref, e.display_name, e.entity_type, e.roles AS entry_roles, a.id AS assignment_id, a.roles, a.scope, a.responsible_contact_id,
              COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'position', c.position, 'is_primary', c.is_primary) ORDER BY c.is_primary DESC, c.name)
                          FROM directory_contacts c WHERE c.entry_id = e.id AND c.archived_at IS NULL), '[]') AS contacts
         FROM directory_assignments a JOIN directory_entries e ON e.id = a.entry_id
        WHERE a.project_id = $1 AND a.archived_at IS NULL AND e.archived_at IS NULL
        ORDER BY lower(e.display_name)`, [pid]);
    res.json(rows);
  });
  return r;
}
