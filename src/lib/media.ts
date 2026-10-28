import { useEffect, useState } from 'react';

/**
 * Width at which the desktop layout (left sidebar + compact top bar) is used. Chosen by usable content width,
 * not device type: at 1024px the expanded sidebar (256px) still leaves 768px for the page — the same width the
 * tablet layout already handles. Below this the existing top header and mobile menu are used unchanged.
 */
export const DESKTOP_LAYOUT_QUERY = '(min-width: 1024px)';

/** Live result of a CSS media query (false when rendered without a browser). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const SIDEBAR_KEY = 'qonnect.sidebar.collapsed';
/** The person's collapsed / expanded choice, kept in this browser only (storage may be unavailable). */
export function readSidebarCollapsed(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
}
export function writeSidebarCollapsed(v: boolean) {
  try { window.localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'); } catch { /* private mode etc. */ }
}
