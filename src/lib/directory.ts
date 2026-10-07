// Client types and helpers for the Contacts / Companies directory.
import { BUSINESS_ROLE_LABELS, type BusinessRole } from '../../shared/directory';
import type { Option } from '../components/ui';

export interface DirectoryContact {
  id: string; entry_id: string; name: string; position: string; mobile: string; email: string; is_primary: boolean; notes: string;
  archived_at: string | null; created_at: string;
}
export interface DirectoryAssignment {
  id: string; entry_id: string; project_id: string; project_code: string; project_name: string; roles: BusinessRole[]; scope: string;
  responsible_contact_id: string | null; responsible_contact_name?: string | null; start_date: string | null; end_date: string | null; notes: string; archived_at: string | null;
}
export interface DirectoryEntry {
  id: string; ref: string; display_name: string; entity_type: 'company' | 'individual'; roles: BusinessRole[]; specializations: string[];
  phone: string; email: string; address: string; website: string; registration_no: string; drive_url: string; quotations_url: string; notes: string;
  archived_at: string | null; created_at: string; updated_at: string; created_by_name: string | null; updated_by_name: string | null;
}
export interface DirectoryListItem extends DirectoryEntry {
  primary_contact: { id: string; name: string; position: string; mobile: string; email: string } | null;
  contact_count: number;
  assignments: Array<{ id: string; project_id: string; project_code: string; project_name: string; roles: BusinessRole[]; archived_at: string | null }>;
}
export interface DirectoryListResponse { entries: DirectoryListItem[]; projects: Array<{ id: string; code: string; name: string; archived_at: string | null }>; canCreate: boolean; canManage: boolean }
export interface DirectoryDocument { id: string; project_id: string | null; project_code: string | null; kind: string; original_name: string; mime_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null }
export interface DirectoryDetail {
  entry: DirectoryEntry; contacts: DirectoryContact[]; assignments: DirectoryAssignment[]; documents: DirectoryDocument[];
  related: Partial<Record<'contract' | 'payment_milestone' | 'material' | 'consultant_visit' | 'site_visit' | 'timeline_task', Array<Record<string, any>>>>;
  permissions: { canEdit: boolean; canAddContact: boolean; canAssign: boolean; canUploadShared: boolean; writableProjects: Array<{ id: string; code: string; name: string }> };
}
export interface ProjectDirectoryEntry {
  id: string; ref: string; display_name: string; entity_type: string; entry_roles: BusinessRole[]; roles: BusinessRole[]; scope: string;
  responsible_contact_id: string | null; contacts: Array<{ id: string; name: string; position: string; is_primary: boolean }>;
}
export interface Specialization { id: string; name: string; sort_order: number; archived_at: string | null }

export const rolesText = (roles: readonly string[]) => roles.map((r) => BUSINESS_ROLE_LABELS[r as BusinessRole] ?? r).join(', ');

/** Options for a record form: entries assigned to the project (grouped Company / Individual). */
export function entryOptions(list: ProjectDirectoryEntry[]): Option[] {
  return list.map((e) => ({ value: e.id, label: e.display_name, hint: rolesText(e.roles), group: e.entity_type === 'individual' ? 'Individuals' : 'Companies', keywords: `${e.ref} ${rolesText(e.entry_roles)}` }));
}
export function contactOptions(list: ProjectDirectoryEntry[], entryId: string | null | undefined): Option[] {
  const e = list.find((x) => x.id === entryId);
  return (e?.contacts ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.position || undefined, keywords: c.position }));
}
