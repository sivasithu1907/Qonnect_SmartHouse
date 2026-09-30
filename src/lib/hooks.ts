import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

/** Loads JSON from `url`, exposes reload(). Re-fetches when url changes. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(url);
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => { setData(null); void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}
