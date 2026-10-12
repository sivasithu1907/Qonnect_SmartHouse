// Contracts & Documents → Project documents: the project's central document register.
//   GET    /api/projects/:projectId/documents                 register: project documents + files from other modules
//   POST   /api/projects/:projectId/documents                 create a project document (permit, drawing, survey…)
//   GET    /api/projects/:projectId/documents/:id             one document with its linked prerequisites
//   PATCH  /api/projects/:projectId/documents/:id
//   POST   /api/projects/:projectId/documents/:id/archive     · /restore
//
// Files of a project document use the existing secure attachments system (entity_type 'project_document').
// Files that belong to other records (contract files, payment slips, consultant reports, budget item files,
// prerequisite files) are listed with their source and a link to the original record, and only for roles
// that may read that record type. Downloads always go through the attachments route, which re-checks access.
import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, parseBody, parsePatch, uuidParam, zDate, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { getOwned, insertRow, patchOwned } from '../lib/crud';
import { can, type Capability } from '../permissions';
import type { Role } from '../../shared/constants';
import { ATTACHMENT_ENTITY_TYPES, PROJECT_DOCUMENT_CATEGORIES, type AttachmentEntityType } from '../../shared/constants';
import { effectiveFileName, suggestRepairedName } from '../../shared/filenames';
import { assertEntityAccess } from './attachments';
import type { Request } from 'express';

export const documentFields = z.object({
  title: zText(300).min(1, 'Title is required'),
  category: z.enum(PROJECT_DOCUMENT_CATEGORIES).default('other'),
  reference: zText(200).default(''),
  document_date: zDate.optional(),
  drive_url: zUrl.default(''),
  notes: zText(4000).default(''),
});

/** Record types whose files appear in the register, with the capability needed to see them. */
const SOURCE_CAP: Record<AttachmentEntityType, Capability> = {
  project_document: 'documents.read',
  prerequisite: 'prerequisites.read',
  contract: 'contracts.read',
  contract_amendment: 'contracts.read',
  payment_milestone: 'payments.read',
  payment_transaction: 'payments.read',
  consultant_visit: 'consultant.read',
  site_visit: 'site.read',
  material: 'materials.read',
  work_update: 'timeline.read',
  budget_item: 'budget.read',
};
export const readableSourceTypes = (role: Role) => ATTACHMENT_ENTITY_TYPES.filter((t) => can(role, SOURCE_CAP[t]));

export async function loadDocuments(db: pg.Pool | pg.PoolClient, pid: string, role: Role, includeArchived: boolean) {
  const { rows } = await db.query(
    `SELECT d.*, u.name AS created_by_name,
            (SELECT count(*)::int FROM attachments a WHERE a.project_id = d.project_id AND a.entity_type = 'project_document' AND a.entity_id = d.id AND a.archived_at IS NULL) AS file_count,
            COALESCE((SELECT json_agg(json_build_object('id', q.id, 'title', q.title, 'status', q.status) ORDER BY q.sort_order)
                        FROM prerequisite_documents pd JOIN project_prerequisites q ON q.id = pd.prerequisite_id AND q.archived_at IS NULL
                       WHERE pd.document_id = d.id), '[]') AS prerequisites
       FROM project_documents d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.project_id = $1 AND ($2 OR d.archived_at IS NULL)
      ORDER BY d.archived_at NULLS FIRST, d.document_date DESC NULLS LAST, d.created_at DESC`,
    [pid, includeArchived],
  );
  return can(role, 'prerequisites.read') ? rows : rows.map(({ prerequisites: _p, ...r }) => r);
}

/** Every active file of the project the role may read, with where it comes from and a link to that record. */
export async function loadRegister(db: pg.Pool | pg.PoolClient, pid: string, role: Role) {
  const types = readableSourceTypes(role);
  if (!types.length) return [];
  const { rows } = await db.query(
    `SELECT a.id, a.entity_type, a.entity_id, a.kind, a.original_name, a.display_name, a.description, a.mime_type, a.size_bytes, a.created_at,
            u.name AS uploaded_by_name,
            CASE a.entity_type
              WHEN 'project_document' THEN d.title
              WHEN 'prerequisite' THEN q.title
              WHEN 'contract' THEN k.title
              WHEN 'contract_amendment' THEN ka.title || ' — amendment ' || COALESCE(NULLIF(am.reference, ''), to_char(am.amendment_date, 'YYYY-MM-DD'))
              WHEN 'payment_milestone' THEN m.payee_name || ' — ' || m.description
              WHEN 'payment_transaction' THEN mt.payee_name || ' — ' || mt.description || ' (transfer ' || COALESCE(NULLIF(t.reference, ''), to_char(t.paid_date, 'YYYY-MM-DD')) || ')'
              WHEN 'consultant_visit' THEN cv.purpose
              WHEN 'site_visit' THEN sv.purpose
              WHEN 'material' THEN mi.description
              WHEN 'work_update' THEN wu.title
              WHEN 'budget_item' THEN bi.name
            END AS source_title,
            CASE a.entity_type
              WHEN 'project_document' THEN d.id WHEN 'prerequisite' THEN q.id WHEN 'contract' THEN k.id WHEN 'contract_amendment' THEN ka.id
              WHEN 'payment_milestone' THEN m.id WHEN 'payment_transaction' THEN mt.id WHEN 'consultant_visit' THEN cv.id
              WHEN 'site_visit' THEN sv.id WHEN 'material' THEN mi.id WHEN 'budget_item' THEN bi.id
            END AS source_id,
            CASE WHEN a.entity_type = 'project_document' THEN d.category END AS category
       FROM attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
       LEFT JOIN project_documents d ON a.entity_type = 'project_document' AND d.id = a.entity_id AND d.project_id = a.project_id
       LEFT JOIN project_prerequisites q ON a.entity_type = 'prerequisite' AND q.id = a.entity_id AND q.project_id = a.project_id
       LEFT JOIN contracts k ON a.entity_type = 'contract' AND k.id = a.entity_id AND k.project_id = a.project_id
       LEFT JOIN contract_amendments am ON a.entity_type = 'contract_amendment' AND am.id = a.entity_id AND am.project_id = a.project_id
       LEFT JOIN contracts ka ON ka.id = am.contract_id
       LEFT JOIN payment_milestones m ON a.entity_type = 'payment_milestone' AND m.id = a.entity_id AND m.project_id = a.project_id
       LEFT JOIN payment_transactions t ON a.entity_type = 'payment_transaction' AND t.id = a.entity_id AND t.project_id = a.project_id
       LEFT JOIN payment_milestones mt ON mt.id = t.milestone_id
       LEFT JOIN consultant_visits cv ON a.entity_type = 'consultant_visit' AND cv.id = a.entity_id AND cv.project_id = a.project_id
       LEFT JOIN site_visits sv ON a.entity_type = 'site_visit' AND sv.id = a.entity_id AND sv.project_id = a.project_id
       LEFT JOIN material_items mi ON a.entity_type = 'material' AND mi.id = a.entity_id AND mi.project_id = a.project_id
       LEFT JOIN work_updates wu ON a.entity_type = 'work_update' AND wu.id = a.entity_id AND wu.project_id = a.project_id
       LEFT JOIN budget_items bi ON a.entity_type = 'budget_item' AND bi.id = a.entity_id AND bi.project_id = a.project_id
      WHERE a.project_id = $1 AND a.archived_at IS NULL AND a.entity_type = ANY($2::text[])
        AND (a.entity_type <> 'project_document' OR d.archived_at IS NULL)
      ORDER BY a.created_at DESC
      LIMIT 2000`,
    [pid, types],
  );
  const section: Partial<Record<AttachmentEntityType, string>> = {
    project_document: 'contracts', prerequisite: 'dashboard', contract: 'contracts', contract_amendment: 'contracts',
    payment_milestone: 'payments', payment_transaction: 'payments', consultant_visit: 'consultant', site_visit: 'site',
    material: 'materials', work_update: 'timeline', budget_item: 'budget',
  };
  return rows.map((r) => ({
    ...r,
    name: effectiveFileName(r),
    suggested_name: r.display_name ? null : suggestRepairedName(r.original_name),
    href: `#/${section[r.entity_type as AttachmentEntityType]}/${pid}${r.source_id ? `/${r.source_id}` : ''}`,
  }));
}

export function documentRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'documents.read');
    const pid = req.project!.id;
    const role = req.user!.role;
    const [documents, register] = await Promise.all([
      loadDocuments(pool, pid, role, req.query.includeArchived === '1'),
      loadRegister(pool, pid, role),
    ]);
    res.json({ documents, register, sources: readableSourceTypes(role) });
  });

  // ---- reviewable repair of file names garbled before the Arabic fix (never automatic)
  const canFix = async (req: Request, row: { entity_type: string; entity_id: string }) => {
    try { await assertEntityAccess(pool, req, row.entity_type as AttachmentEntityType, row.entity_id, 'write'); return true; } catch { return false; }
  };
  r.get('/name-repairs', async (req, res) => {
    assertCap(req, 'documents.read');
    const reg = await loadRegister(pool, req.project!.id, req.user!.role);
    const rows = reg.filter((x) => x.suggested_name);
    const out = [];
    for (const x of rows) {
      out.push({ id: x.id, entity_type: x.entity_type, source_title: x.source_title, href: x.href, current_name: x.original_name, suggested_name: x.suggested_name, can_fix: await canFix(req, x) });
    }
    res.json(out);
  });

  r.post('/repair-names', async (req, res) => {
    assertCap(req, 'documents.read');
    const { ids } = parseBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }), req);
    const pid = req.project!.id;
    const done = await withTx(pool, async (c) => {
      const fixed: string[] = [];
      for (const id of ids) {
        const { rows } = await c.query(`SELECT id, entity_type, entity_id, original_name, display_name, archived_at FROM attachments WHERE id = $1 AND project_id = $2 FOR UPDATE`, [id, pid]);
        const a = rows[0];
        if (!a || a.archived_at || a.display_name || !(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(a.entity_type)) continue;
        const suggestion = suggestRepairedName(a.original_name); // recomputed on the server, never taken from the client
        if (!suggestion) continue;
        await assertEntityAccess(c, req, a.entity_type, a.entity_id, 'write'); // same rule as renaming the file
        await c.query('UPDATE attachments SET display_name = $2 WHERE id = $1', [id, suggestion]);
        await audit(c, req, { projectId: pid, action: 'update', entityType: 'attachment', entityId: id,
          summary: `Repaired garbled file name: ${a.original_name} → ${suggestion} (original name kept)`, before: { display_name: null }, after: { display_name: suggestion } });
        fixed.push(id);
      }
      return fixed;
    });
    res.json({ fixed: done.length, ids: done });
  });

  r.get('/:id', async (req, res) => {
    assertCap(req, 'documents.read');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    await getOwned(pool, 'project_documents', pid, id);
    const all = await loadDocuments(pool, pid, req.user!.role, true);
    res.json(all.find((d) => d.id === id));
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'documents.write');
    const body = parseBody(documentFields, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      const d = await insertRow(c, 'project_documents', { ...body, document_date: body.document_date ?? null, project_id: pid, created_by: req.user!.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'project_document', entityId: d.id as string, summary: `Added project document "${d.title}"`, after: d });
      return d;
    });
    res.status(201).json(row);
  });

  r.patch('/:id', async (req, res) => {
    assertCap(req, 'documents.write');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parsePatch(documentFields.partial(), req);
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, unknown>>(c, 'project_documents', pid, id, { forUpdate: true });
      if (cur.archived_at) throw badRequest('This document is archived. Restore it before editing.');
      const { before, after } = await patchOwned(c, 'project_documents', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'project_document', entityId: id, summary: `Edited project document "${after.title}" (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/:id/${action}`, async (req, res) => {
      assertCap(req, 'documents.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'project_documents', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'project_document', entityId: id,
          summary: `${action === 'archive' ? 'Archived' : 'Restored'} project document "${after.title}" (its files are kept)` });
        return after;
      });
      res.json(out);
    });
  }

  return r;
}
