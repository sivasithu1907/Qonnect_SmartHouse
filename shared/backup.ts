// Labels shared by the Backup & Restore page and the CLI.
export const BACKUP_COUNT_LABELS: Record<string, string> = {
  projects: 'Projects',
  users: 'Users',
  project_members: 'Project memberships',
  budget_items: 'Budget items',
  contracts: 'Contracts',
  contract_amendments: 'Contract amendments',
  payment_milestones: 'Payment milestones',
  payment_transactions: 'Payment transfers',
  material_items: 'Material lines',
  timeline_tasks: 'Timeline tasks',
  consultant_visits: 'Consultant visits',
  site_visits: 'Site visits',
  directory_entries: 'Contacts (companies / individuals)',
  directory_contacts: 'Contact people',
  attachments: 'Attachment records',
  audit_log: 'Audit entries',
};

export const BACKUP_KIND_LABELS: Record<string, string> = {
  manual: 'Manual',
  cli: 'Command line',
  pre_restore: 'Safety (before restore)',
  uploaded: 'Uploaded',
};
