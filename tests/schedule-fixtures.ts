// Record builders for schedule/Gantt unit tests (test inputs only; not application data).
import type { MaterialItem, Phase, Task } from '../src/lib/types';

export function mat(over: Partial<MaterialItem>): MaterialItem {
  return {
    id: over.id ?? 'm', category: 'Tiles', category_id: 'c1', category_sort: 1, category_archived_at: null, description: 'Line', quantity: null, unit: '', amount: null,
    supply_responsibility: 'needs_confirmation', responsibility_note: '', vendor: '', assigned_contractor_id: null, assigned_contractor_name: null, status: 'Ordered',
    required_on_site_date: null, planned_delivery_date: null, confirmed_delivery_date: null, revised_delivery_date: null, actual_delivery_date: null, delivery_date_note: '',
    qty_ordered: null, qty_delivered: null, inspection_status: '', next_follow_up_date: null, document_url: '', notes: '', source_label: '', is_package: false, archived_at: null, attachment_count: 0,
    ...over,
  };
}
export const phase = (id: string, seq: number, over: Partial<Phase> = {}): Phase => ({ id, seq, name: `Phase ${seq}`, description: '', planned_start: null, planned_end: null, actual_start: null, actual_end: null, schedule_approved: false, notes: '', archived_at: null, ...over });
export const task = (id: string, phaseId: string, over: Partial<Task> = {}): Task => ({ id, phase_id: phaseId, template_key: null, name: id, description: '', is_hold_point: false, planned_start: null, planned_end: null, actual_start: null, actual_end: null, status: 'Not Scheduled', responsible: '', notes: '', sort_order: 0, archived_at: null, depends_on: [], assigned_user_id: null, assigned_user_name: null, ...over });
