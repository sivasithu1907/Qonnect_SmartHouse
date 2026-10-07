// Optional directory links on existing records (contracts, payment milestones, material lines,
// visits, timeline tasks). The record's own text name (company / payee / vendor / consultant /
// responsible) is never changed here; the link is a separate, nullable reference.
import { z } from 'zod';
import type pg from 'pg';
import { badRequest } from './http';

const uuidOrNull = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable());
export const directoryLinkFields = {
  directory_entry_id: uuidOrNull.optional(),
  directory_contact_id: uuidOrNull.optional(),
};
export const DIRECTORY_LINK_KEYS = ['directory_entry_id', 'directory_contact_id'] as const;

/** SQL fragments to show the linked entry / contact names next to a record (alias of the record table). */
export const directoryJoin = (alias: string) =>
  `LEFT JOIN directory_entries de_${alias} ON de_${alias}.id = ${alias}.directory_entry_id
   LEFT JOIN directory_contacts dc_${alias} ON dc_${alias}.id = ${alias}.directory_contact_id`;
export const directorySelect = (alias: string) =>
  `de_${alias}.display_name AS directory_entry_name, de_${alias}.ref AS directory_entry_ref, de_${alias}.archived_at AS directory_entry_archived_at,
   dc_${alias}.name AS directory_contact_name`;

/**
 * Validates a change of directory link on a record in project `pid`. New selections must be an active
 * entry assigned (active) to this project and an active contact of that entry; an unchanged existing
 * link stays valid even if it was archived since. Clearing a link is always allowed.
 */
export async function checkDirectoryLinks(
  c: pg.PoolClient, pid: string, body: Record<string, unknown>,
  current: { directory_entry_id?: string | null; directory_contact_id?: string | null } | null = null,
) {
  const entryChanged = body.directory_entry_id !== undefined && body.directory_entry_id !== (current?.directory_entry_id ?? null);
  const contactChanged = body.directory_contact_id !== undefined && body.directory_contact_id !== (current?.directory_contact_id ?? null);
  if (!entryChanged && !contactChanged) return;
  const entryId = (body.directory_entry_id !== undefined ? body.directory_entry_id : current?.directory_entry_id ?? null) as string | null;
  let contactId = (body.directory_contact_id !== undefined ? body.directory_contact_id : current?.directory_contact_id ?? null) as string | null;
  // changing the company drops a contact that belonged to the previous one
  if (entryChanged && !contactChanged && contactId) { body.directory_contact_id = null; contactId = null; }
  if (entryChanged && entryId) {
    const { rows } = await c.query(
      `SELECT e.display_name, e.archived_at, EXISTS (SELECT 1 FROM directory_assignments a WHERE a.entry_id = e.id AND a.project_id = $2 AND a.archived_at IS NULL) AS assigned
         FROM directory_entries e WHERE e.id = $1`, [entryId, pid]);
    if (!rows[0]) throw badRequest('Directory entry not found');
    if (rows[0].archived_at) throw badRequest(`${rows[0].display_name} is archived and cannot be selected`);
    if (!rows[0].assigned) throw badRequest(`${rows[0].display_name} is not assigned to this project. Assign it in Contacts first.`);
  }
  if (contactId && (contactChanged || entryChanged)) {
    if (!entryId) throw badRequest('Choose the company / individual before the contact person');
    const { rows } = await c.query('SELECT archived_at FROM directory_contacts WHERE id = $1 AND entry_id = $2', [contactId, entryId]);
    if (!rows[0]) throw badRequest('That contact person does not belong to the selected company / individual');
    if (rows[0].archived_at) throw badRequest('That contact person is archived and cannot be selected');
  }
}
