import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, onUpdateAvailable, updateAvailable } from '../lib/pwa';

/** Shown when a new version of the app has been downloaded; reloading is the user's choice. */
export function UpdateBanner() {
  const [show, setShow] = useState(updateAvailable());
  useEffect(() => { const off = onUpdateAvailable(() => setShow(true)); return () => { off(); }; }, []);
  if (!show) return null;
  return (
    <div className="bg-sky-50 border-b border-sky-200 text-sky-900 text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-3">
        <span>A new version of Qonnect is available.</span>
        <button onClick={() => applyUpdate()} className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:text-sky-900">
          <RefreshCw className="w-3.5 h-3.5" />Reload to update
        </button>
      </div>
    </div>
  );
}
