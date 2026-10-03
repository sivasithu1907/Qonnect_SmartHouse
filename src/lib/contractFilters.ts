import type { Contract } from './types';

export interface ContractFilter { q: string; categoryId: string; status: string }

/** Search matches title, company, reference, category and notes (case-insensitive). */
export function filterContracts(list: Contract[], f: ContractFilter): Contract[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((k) => {
    if (f.categoryId && k.category_id !== f.categoryId) return false;
    if (f.status && k.status !== f.status) return false;
    if (!q) return true;
    return [k.title, k.company_name, k.reference, k.category_name, k.notes].join(' ').toLowerCase().includes(q);
  });
}
