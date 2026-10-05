import type { Role } from '../../shared/constants';
import type { ItemizedBudget } from '../../shared/calc';

export interface User { id: string; email: string; name: string; role: Role }
export interface Member { id: string; name: string; role: Role }

export interface Project {
  id: string; code: string; name: string; location: string; description: string; client: string; status: string;
  planned_start_date: string | null; target_completion_date: string | null;
  misc_percentage: number; misc_basis: 'approved_finishing';
  control_budget: number | null; control_budget_confirmed: boolean; control_budget_confirmed_at: string | null;
  drive_folder_url: string; sheets_url: string; payments_drive_url: string; materials_drive_url: string;
  consultant_drive_url: string; site_visits_drive_url: string; notes: string; archived_at: string | null;
}

export interface BudgetCategory { id: string; name: string; kind: 'finishing' | 'fixed' | 'other'; include_in_misc_basis: boolean; sort_order: number; source_label: string; notes: string; archived_at: string | null; usage_count?: number; active_count?: number }
export interface MaterialCategory { id: string; name: string; sort_order: number; archived_at: string | null; usage_count?: number; active_count?: number }
export interface ContractCategory { id: string; name: string; sort_order: number; archived_at: string | null; usage_count?: number; active_count?: number }
export interface CategoriesResponse { budget: BudgetCategory[]; material: MaterialCategory[]; contract?: ContractCategory[] }
export interface BudgetItem {
  id: string; category_id: string; name: string; description: string; quantity: number | null; unit: string;
  source_label: string;
  approved_amount: number | null; approved_at: string | null; notes: string; sort_order: number; archived_at: string | null;
  paid_amount: number; scheduled_amount: number;
}
export interface MiscAllowance { basis: string; percentage: number; basisAmount: number; allowance: number; itemsCounted: number; itemsMissingValue: number }
export interface CategorySummary { id: string; name: string; kind: string; approved: number | null; scheduled: number; paid: number; itemCount: number; approvedItemCount: number }
export interface BudgetResponse {
  categories: BudgetCategory[]; items: BudgetItem[];
  summary: { byCategory: CategorySummary[]; byKind: Array<{ kind: 'fixed' | 'finishing' | 'other'; subtotal: number; itemCount: number; missingCount: number }>; itemized: ItemizedBudget; misc: MiscAllowance; approvedCommitments: number; approvedItemCount: number; itemCount: number; scheduled: number; paid: number };
}

export interface PaymentTransaction { id: string; milestone_id: string; amount: number; paid_date: string; method: string; reference: string; notes: string; archived_at: string | null; attachment_count: number }
export interface MilestoneBalance { scheduled: number; paid: number; pending: number; overpaid: number; isOverdue: boolean; derivedStatus: string }
export interface PaymentMilestone {
  id: string; payee_type: string; payee_name: string; cost_category: string; budget_item_id: string | null; budget_item_name: string | null;
  contract_id: string | null; contract_title: string | null;
  po_contract_ref: string; invoice_ref: string; description: string; due_date: string | null; scheduled_amount: number;
  status: 'active' | 'on_hold' | 'cancelled'; notes: string; archived_at: string | null; attachment_count: number;
  transactions: PaymentTransaction[]; balance: MilestoneBalance;
}
export interface PaymentsResponse {
  milestones: PaymentMilestone[]; today: string;
  totals: { scheduled: number; paid: number; pending: number; overdue: number; overdueCount: number; overpaid: number; overpaidCount: number; milestoneCount: number; transactionCount: number };
}

export interface MaterialItem {
  id: string; category: string; category_id: string; category_sort: number | null; category_archived_at: string | null; description: string; quantity: number | null; unit: string; amount: number | null;
  supply_responsibility: 'owner' | 'contractor' | 'needs_confirmation'; responsibility_note: string; vendor: string;
  assigned_contractor_id: string | null; assigned_contractor_name: string | null; status: string;
  required_on_site_date: string | null; planned_delivery_date: string | null; confirmed_delivery_date: string | null;
  revised_delivery_date: string | null; actual_delivery_date: string | null; delivery_date_note: string;
  qty_ordered: number | null; qty_delivered: number | null; inspection_status: string; next_follow_up_date: string | null;
  document_url: string; notes: string; source_label: string; is_package: boolean; archived_at: string | null; attachment_count: number;
}
export interface ScopeNote { id: string; category: string; category_id: string; owner_supply: string; contractor_scope: string; source_label: string }

export interface VisitAction { id: string; visit_id: string; description: string; responsible: string; due_date: string | null; status: 'Open' | 'Closed' }
export interface ConsultantVisit {
  id: string; planned_at: string | null; consultant_name: string; consultant_user_id: string | null; consultant_user_name: string | null;
  purpose: string; areas_inspected: string; status: string; observations: string; instructions: string; next_visit_date: string | null;
  related_task_id: string | null; related_material_id: string | null; notes: string; archived_at: string | null; attachment_count: number; actions: VisitAction[];
}
export interface SiteVisit {
  id: string; visit_at: string | null; assigned_user_id: string | null; assigned_user_name: string | null; assigned_name: string;
  purpose: string; areas: string; status: string; findings: string; related_task_id: string | null; related_material_id: string | null;
  related_consultant_visit_id: string | null; notes: string; archived_at: string | null; attachment_count: number; actions: VisitAction[];
}

export interface Phase { id: string; seq: number; name: string; description: string; planned_start: string | null; planned_end: string | null; actual_start: string | null; actual_end: string | null; schedule_approved: boolean; notes: string; archived_at: string | null }
export interface Task {
  id: string; phase_id: string; template_key: string | null; name: string; description: string; is_hold_point: boolean;
  planned_start: string | null; planned_end: string | null; actual_start: string | null; actual_end: string | null;
  status: string; responsible: string; notes: string; sort_order: number; archived_at: string | null; depends_on: string[];
  assigned_user_id: string | null; assigned_user_name: string | null;
}
export interface WorkUpdate { id: string; update_date: string; title: string; description: string; author_id: string; author_name: string | null; related_task_id: string | null; related_material_id: string | null; attachment_count: number }

export interface AuditEntry { id: number; action: string; entity_type: string; entity_id: string | null; summary: string; before: any; after: any; user_email: string | null; created_at: string }

export interface ContractPaymentSummary { milestoneCount: number; scheduled: number; paid: number; pending: number; overdueCount: number }
export interface Contract {
  id: string; title: string; category_id: string; category_name: string; category_sort: number; company_name: string; reference: string;
  signed_date: string | null; status: string; notes: string; drive_url: string; archived_at: string | null;
  created_at: string; updated_at: string; created_by_name: string | null; attachment_count: number; amendment_count: number;
  /** present only for users with financial access (payments.read) */
  contract_value?: number | null;
  payments?: ContractPaymentSummary;
  /** present only for users with budget access */
  budget_item_id?: string | null; budget_item_name?: string | null;
}
export interface ContractAmendment { id: string; contract_id: string; amendment_date: string; description: string; reference: string; notes: string; archived_at: string | null; created_by_name: string | null; created_at: string; attachment_count: number }
export interface LinkedMilestone { id: string; payee_name: string; description: string; due_date: string | null; status: string; scheduled_amount: number; archived_at: string | null; balance: MilestoneBalance }
export interface ContractDetail extends Omit<Contract, 'payments'> {
  amendments: ContractAmendment[];
  payments?: { summary: ContractPaymentSummary; milestones: LinkedMilestone[] };
}
export interface ContractsResponse { contracts: Contract[]; access: { finance: boolean; budget: boolean } }

export type Section = 'portfolio' | 'dashboard' | 'budget' | 'payments' | 'contracts' | 'materials' | 'consultant' | 'site' | 'timeline' | 'audit' | 'users' | 'notifications';
export interface FocusProps { focusId?: string | null; onFocusHandled?: () => void }
export interface AppNotification { id: string; project_id: string; project_code: string; kind: string; event_type: string; title: string; body: string; url: string; read_at: string | null; created_at: string }
