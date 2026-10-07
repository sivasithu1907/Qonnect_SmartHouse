import React, { useEffect, useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { probe } from '../lib/api';
import { useSession } from '../lib/session';
import { PAGE_CONTAINER } from '../lib/layout';

/** Admins only: reminds that background jobs are paused after a restore until recovery checks are done. */
export function RecoveryBanner({ onOpen, hidden }: { onOpen: () => void; hidden: boolean }) {
  const { can } = useSession();
  const [paused, setPaused] = useState(false);
  const allowed = can('backup.manage');
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void probe<{ jobsPaused: boolean }>('/api/admin/backup/status').then((r) => { if (live) setPaused(!!r.body?.jobsPaused); });
    return () => { live = false; };
  }, [allowed, hidden]);
  if (!allowed || !paused || hidden) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900" role="status">
      <div className={`${PAGE_CONTAINER} py-2 flex flex-wrap items-center gap-2 text-xs`}>
        <PauseCircle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
        <span className="font-semibold">Background jobs and notifications are paused after a restore.</span>
        <span>Complete the recovery checks, then resume them.</span>
        <button type="button" onClick={onOpen} className="ml-auto font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-950">Open Backup &amp; restore</button>
      </div>
    </div>
  );
}
