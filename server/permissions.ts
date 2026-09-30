// Central role → capability matrix. Every route checks these on the server;
// the UI uses the same matrix only to hide controls.
import type { Role } from '../shared/constants';

export type Capability =
  | 'projects.manage'      // create / edit / archive / restore projects, misc %, control budget
  | 'users.manage'
  | 'links.edit'           // project & section Drive / Sheets links
  | 'budget.read'
  | 'budget.write'
  | 'payments.read'
  | 'payments.write'
  | 'materials.read'
  | 'materials.write'      // full edit
  | 'materials.contractor' // limited edit of lines assigned to the contractor
  | 'consultant.read'
  | 'consultant.write'     // any consultant visit in project
  | 'consultant.own'       // consultant visits assigned to self
  | 'site.read'
  | 'site.write'
  | 'site.assigned'        // update findings/status of site visits assigned to self
  | 'timeline.read'
  | 'timeline.write'
  | 'workupdates.write'
  | 'audit.read'
  | 'categories.manage';   // add / rename / reorder / archive / delete budget and material categories

const MATRIX: Record<Role, Capability[]> = {
  admin: [
    'projects.manage', 'users.manage', 'links.edit', 'budget.read', 'budget.write', 'payments.read', 'payments.write',
    'materials.read', 'materials.write', 'consultant.read', 'consultant.write', 'site.read', 'site.write',
    'timeline.read', 'timeline.write', 'workupdates.write', 'audit.read', 'categories.manage',
  ],
  project_manager: [
    'links.edit', 'budget.read', 'payments.read', 'payments.write', 'materials.read', 'materials.write',
    'consultant.read', 'consultant.write', 'site.read', 'site.write', 'timeline.read', 'timeline.write',
    'workupdates.write', 'audit.read',
  ],
  contractor: ['materials.read', 'materials.contractor', 'consultant.read', 'site.read', 'site.assigned', 'timeline.read', 'workupdates.write'],
  consultant: ['materials.read', 'consultant.read', 'consultant.own', 'site.read', 'site.assigned', 'timeline.read'],
  viewer: ['budget.read', 'payments.read', 'materials.read', 'consultant.read', 'site.read', 'timeline.read'],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role]?.includes(cap) ?? false;
}
export function capabilitiesFor(role: Role): Capability[] {
  return [...(MATRIX[role] ?? [])];
}

/** Fields a contractor may change on a material line assigned to them. */
export const CONTRACTOR_MATERIAL_FIELDS = [
  'status', 'vendor', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date',
  'actual_delivery_date', 'qty_ordered', 'qty_delivered', 'next_follow_up_date', 'notes', 'document_url',
] as const;
