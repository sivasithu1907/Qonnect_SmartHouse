// Shared enumerations used by the API validators and the UI.

export const ROLES = ['admin', 'project_manager', 'contractor', 'consultant', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  project_manager: 'Project Manager',
  contractor: 'Contractor',
  consultant: 'Consultant',
  viewer: 'Viewer',
};

export const PAYEE_TYPES = ['contractor', 'consultant', 'kahramaa', 'supplier', 'other'] as const;
export const PAYEE_TYPE_LABELS: Record<(typeof PAYEE_TYPES)[number], string> = {
  contractor: 'Contractor',
  consultant: 'Consultant',
  kahramaa: 'Kahramaa',
  supplier: 'Supplier',
  other: 'Other',
};

export const MILESTONE_STATUSES = ['active', 'on_hold', 'cancelled'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash', 'card', 'other'] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
};

export const MATERIAL_STATUSES = [
  'Status not confirmed',
  'Not Ordered',
  'Quotation Requested',
  'Awaiting Approval',
  'Ordered',
  'Awaiting Supplier Confirmation',
  'In Production',
  'Dispatched',
  'Partially Delivered',
  'Delivered',
  'Inspection Pending',
  'Accepted',
  'Delayed',
  'On Hold',
  'Cancelled',
] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export const SUPPLY_RESPONSIBILITIES = ['owner', 'contractor', 'needs_confirmation'] as const;
export const SUPPLY_RESPONSIBILITY_LABELS: Record<(typeof SUPPLY_RESPONSIBILITIES)[number], string> = {
  owner: 'Owner supply',
  contractor: 'Contractor supply',
  needs_confirmation: 'Needs confirmation',
};

export const INSPECTION_STATUSES = ['', 'Not required', 'Pending', 'Passed', 'Conditionally accepted', 'Rejected'] as const;

export const TASK_STATUSES = ['Not Scheduled', 'Scheduled', 'In Progress', 'On Hold', 'Blocked', 'Completed'] as const;
export const CONSULTANT_VISIT_STATUSES = ['Planned', 'In Progress', 'Completed', 'Rescheduled', 'Cancelled'] as const;
export const SITE_VISIT_STATUSES = ['Planned', 'In Progress', 'Completed', 'Rescheduled'] as const;

export const ATTACHMENT_ENTITY_TYPES = [
  'payment_milestone',
  'payment_transaction',
  'material',
  'consultant_visit',
  'site_visit',
  'work_update',
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const ATTACHMENT_KINDS = ['payment_slip', 'consultant_report', 'delivery_note', 'site_photo', 'supporting_document'] as const;
export const ATTACHMENT_KIND_LABELS: Record<(typeof ATTACHMENT_KINDS)[number], string> = {
  payment_slip: 'Payment slip / receipt',
  consultant_report: 'Consultant report',
  delivery_note: 'Delivery note',
  site_photo: 'Site photo',
  supporting_document: 'Supporting document',
};

// The miscellaneous allowance is only ever calculated on approved / finalized amounts.
export const MISC_BASES = ['approved_finishing'] as const;
export type MiscBasis = (typeof MISC_BASES)[number];
export const MISC_BASIS_LABELS: Record<MiscBasis, string> = {
  approved_finishing: 'Approved / finalized amounts of finishing categories included in the misc basis',
};

export const NEEDS_CONFIRMATION = 'Needs confirmation';
