// Contacts / Companies directory: constants and pure helpers shared by the server and the app.
// Phone numbers are stored as entered (readable) plus a normalized digits-only form used only for
// matching. Nothing here merges, links or creates records.

export const BUSINESS_ROLES = ['consultant', 'supplier', 'main_contractor', 'finishing_contractor', 'subcontractor', 'other'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];
export const BUSINESS_ROLE_LABELS: Record<BusinessRole, string> = {
  consultant: 'Consultant',
  supplier: 'Supplier / Vendor',
  main_contractor: 'Main Contractor',
  finishing_contractor: 'Finishing Contractor',
  subcontractor: 'Subcontractor',
  other: 'Other',
};
export const ENTITY_TYPES = ['company', 'individual'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = { company: 'Company', individual: 'Individual' };

export const DIRECTORY_DOCUMENT_KINDS = ['company_profile', 'trade_license', 'quotation', 'supporting_document'] as const;
export const DIRECTORY_DOCUMENT_KIND_LABELS: Record<(typeof DIRECTORY_DOCUMENT_KINDS)[number], string> = {
  company_profile: 'Company profile',
  trade_license: 'Trade licence / registration',
  quotation: 'Quotation',
  supporting_document: 'Supporting document',
};

/** Calling codes offered in the phone field (Qatar first and default; "Other" accepts any +code). */
export const PHONE_COUNTRIES: Array<{ code: string; label: string }> = [
  { code: '974', label: 'Qatar +974' }, { code: '971', label: 'UAE +971' }, { code: '966', label: 'Saudi Arabia +966' },
  { code: '965', label: 'Kuwait +965' }, { code: '973', label: 'Bahrain +973' }, { code: '968', label: 'Oman +968' },
  { code: '20', label: 'Egypt +20' }, { code: '91', label: 'India +91' }, { code: '94', label: 'Sri Lanka +94' },
  { code: '92', label: 'Pakistan +92' }, { code: '880', label: 'Bangladesh +880' }, { code: '977', label: 'Nepal +977' },
  { code: '63', label: 'Philippines +63' }, { code: '44', label: 'UK +44' }, { code: '1', label: 'USA / Canada +1' },
];
export const DEFAULT_COUNTRY = '974';

/**
 * Digits-only international form for matching: "+974 5512 3456", "0097455123456" and "55123456"
 * (Qatar local, 8 digits) all become "97455123456". Returns '' when there are too few digits.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry = DEFAULT_COUNTRY): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1).replace(/\+/g, '');
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else {
    digits = digits.replace(/\+/g, '');
    if (defaultCountry === '974' && digits.length === 8) digits = `974${digits}`;
    else if (digits.startsWith('0')) digits = `${defaultCountry}${digits.replace(/^0+/, '')}`;
    else if (digits.length <= 9) digits = `${defaultCountry}${digits}`;
  }
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
}

/** Readable display: Qatar "+974 5512 3456"; others "+<code> <rest>". */
export function formatPhone(input: string | null | undefined): string {
  const n = normalizePhone(input);
  if (!n) return String(input ?? '').trim();
  if (n.startsWith('974') && n.length === 11) return `+974 ${n.slice(3, 7)} ${n.slice(7)}`;
  const c = PHONE_COUNTRIES.map((x) => x.code).sort((a, b) => b.length - a.length).find((code) => n.startsWith(code));
  return c ? `+${c} ${n.slice(c.length)}` : `+${n}`;
}

/** wa.me link (opens a chat; nothing is sent automatically). */
export const whatsappUrl = (phone: string | null | undefined) => { const n = normalizePhone(phone); return n ? `https://wa.me/${n}` : ''; };
export const telUrl = (phone: string | null | undefined) => { const n = normalizePhone(phone); return n ? `tel:+${n}` : ''; };

const LEGAL_WORDS = /\b(w\.?\s?l\.?\s?l|l\.?\s?l\.?\s?c|co|company|est|establishment|trading|contracting|services|group|qatar|doha|ltd|limited|the|and|&)\b/g;
/** Name key for similarity: lower case, no punctuation or common legal / trading words. */
export function nameKey(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[.,'"()/\\_-]+/g, ' ').replace(LEGAL_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Similar names (same key, one key containing the other, or ≥ 85 % edit similarity). */
export function similarNames(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const longest = Math.max(x.length, y.length);
  return longest >= 5 && 1 - levenshtein(x, y) / longest >= 0.85;
}

/** Mailbox names that are usually shared by a whole office, so a match is not proof of the same person. */
export const isGeneralEmail = (email: string) => /^(info|sales|admin|office|contact|enquiries|inquiries|support|accounts|hello|mail)@/i.test(email.trim());

export interface DuplicateCandidate {
  id: string; ref: string; display_name: string; entity_type: string; archived_at: string | null;
  phone_normalized: string; email: string; registration_no: string;
  contacts?: Array<{ name: string; mobile_normalized: string; email: string }>;
}
export interface DuplicateMatch { id: string; ref: string; display_name: string; archived: boolean; reasons: string[]; caution: string[] }

/** Likely duplicates for a new / edited entry. Reasons are hints for a person to review, never a merge. */
export function findDuplicates(input: { display_name?: string; phone?: string; email?: string; registration_no?: string; contact_phones?: string[] }, candidates: DuplicateCandidate[], excludeId?: string): DuplicateMatch[] {
  const phones = [normalizePhone(input.phone), ...(input.contact_phones ?? []).map((p) => normalizePhone(p))].filter(Boolean);
  const email = (input.email ?? '').trim().toLowerCase();
  const reg = (input.registration_no ?? '').trim().toLowerCase();
  const out: DuplicateMatch[] = [];
  for (const c of candidates) {
    if (c.id === excludeId) continue;
    const reasons: string[] = [];
    const caution: string[] = [];
    if (input.display_name && similarNames(input.display_name, c.display_name)) reasons.push('Similar name');
    const theirPhones = [c.phone_normalized, ...(c.contacts ?? []).map((x) => x.mobile_normalized)].filter(Boolean);
    if (phones.some((p) => theirPhones.includes(p))) {
      reasons.push('Same phone number');
      caution.push('A shared office number does not prove it is the same company or person.');
    }
    const theirEmails = [c.email, ...(c.contacts ?? []).map((x) => x.email)].map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (email && theirEmails.includes(email)) {
      reasons.push('Same email');
      if (isGeneralEmail(email)) caution.push('This looks like a general office mailbox, which several contacts can share.');
    }
    if (reg && c.registration_no.trim().toLowerCase() === reg) reasons.push('Same registration / reference number');
    if (reasons.length) out.push({ id: c.id, ref: c.ref, display_name: c.display_name, archived: !!c.archived_at, reasons, caution });
  }
  return out;
}
