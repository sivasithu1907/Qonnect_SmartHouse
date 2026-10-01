/**
 * Shared page container used by the header, the update banner, every page and the footer, so
 * they all line up. Fluid, near-full width with responsive side padding; the 2400px cap only
 * stops very large monitors from spreading content too thin.
 *
 * Readable widths are kept by the components themselves, not by the page: dialogs (max-w-xl /
 * max-w-4xl), forms, notices and page subtitles cap their own width, and wide tables / the Gantt
 * scroll inside their own area.
 */
export const PAGE_CONTAINER = 'w-full max-w-[2400px] mx-auto px-3 sm:px-5 lg:px-6 xl:px-8 2xl:px-10';
