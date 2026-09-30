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

/**
 * Opens / highlights a record requested by a notification link (#/section/project/record).
 * Runs once the list has loaded; unknown ids (archived, no access) are simply ignored.
 */
export function useFocusRecord<T>(
  focusId: string | null | undefined,
  list: T[] | null | undefined,
  getId: (item: T) => string,
  open: (item: T) => void,
  onHandled?: () => void,
) {
  useEffect(() => {
    if (!focusId || !list) return;
    const item = list.find((x) => getId(x) === focusId);
    if (item) {
      open(item);
      setTimeout(() => {
        const el = document.getElementById(`rec-${focusId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-2', 'ring-sky-400');
          setTimeout(() => el.classList.remove('ring-2', 'ring-sky-400'), 2500);
        }
      }, 150);
    }
    onHandled?.();
  }, [focusId, list]); // eslint-disable-line react-hooks/exhaustive-deps
}
