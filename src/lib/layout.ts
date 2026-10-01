import type { Section } from './types';

/** Data-heavy pages that use nearly the full viewport width (tables, schedule, Gantt). */
export const WIDE_SECTIONS: ReadonlySet<Section> = new Set<Section>(['materials', 'timeline']);

/**
 * Shared page container: the header, main content and footer use the same width so they stay aligned.
 * Wide pages are fluid with responsive side padding; other pages keep the comfortable 7xl width.
 * Forms, dialogs and long text keep their own max widths inside either container.
 */
export function containerCls(section: Section): string {
  return WIDE_SECTIONS.has(section)
    ? 'w-full max-w-[2400px] mx-auto px-3 sm:px-5 lg:px-6 xl:px-8 2xl:px-10'
    : 'w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8';
}
