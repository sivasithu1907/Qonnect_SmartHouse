import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { post } from '../../lib/api';
import type { DuplicateMatch } from '../../../shared/directory';

/**
 * Likely-duplicate warning while typing (name, phone, email, registration number). Only entries the
 * user may open are described; the user can open / reuse one or continue after reviewing.
 */
export function DuplicateCheck({ vals, excludeId, onOpen, onUse, useLabel = 'Use this entry' }: {
  vals: Record<string, any>; excludeId?: string; onOpen?: (id: string) => void; onUse?: (id: string) => void; useLabel?: string;
}) {
  const [res, setRes] = useState<{ matches: DuplicateMatch[]; hiddenMatch: string | null } | null>(null);
  const key = JSON.stringify([vals.display_name, vals.phone, vals.email, vals.registration_no]);
  useEffect(() => {
    const name = String(vals.display_name ?? '').trim();
    if (name.length < 3 && !vals.phone && !vals.email && !vals.registration_no) { setRes(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      post<{ matches: DuplicateMatch[]; hiddenMatch: string | null }>('/api/directory/check-duplicates', {
        display_name: name, phone: vals.phone ?? '', email: vals.email ?? '', registration_no: vals.registration_no ?? '', exclude_id: excludeId,
      }).then((r) => { if (!cancelled) setRes(r); }).catch(() => undefined);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [key, excludeId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!res || (!res.matches.length && !res.hiddenMatch)) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-950 space-y-1.5" role="status" data-testid="duplicate-warning">
      <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />Possible existing entr{res.matches.length === 1 ? 'y' : 'ies'} — please review</div>
      <ul className="space-y-1.5">
        {res.matches.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{m.display_name}</span><span className="font-mono text-[11px] text-amber-800">{m.ref}</span>
            {m.archived && <span className="text-[11px] text-rose-700 font-semibold">archived</span>}
            <span className="text-amber-800">· {m.reasons.join(', ')}</span>
            {onOpen && <button type="button" className="font-semibold text-sky-700 hover:text-sky-900" onClick={() => onOpen(m.id)}>Open</button>}
            {onUse && !m.archived && <button type="button" className="font-semibold text-sky-700 hover:text-sky-900" onClick={() => onUse(m.id)}>{useLabel}</button>}
            {m.caution.map((c) => <span key={c} className="basis-full text-[11px] text-amber-800">{c}</span>)}
          </li>
        ))}
      </ul>
      {res.hiddenMatch && <p className="text-[11px]">{res.hiddenMatch}</p>}
      <p className="text-[11px] text-amber-800">You can still save if this is a different company or person.</p>
    </div>
  );
}
