/**
 * Shared SVG icon set (web redesign W0). A single hidden <symbol> sprite is
 * mounted once by the app shell via <IconSprite/>; <Ic name="check" /> then
 * references a symbol by id through <use>. Icons are 24×24, stroke-based, and
 * inherit `currentColor` — colour and (via the `px-ic` class or `size`) sizing
 * come from the caller. Ported verbatim from docs/mockups/web-layout-redesign.html.
 */
import type { CSSProperties } from 'react';

export type IconName =
  | 'prism' | 'sun' | 'cal' | 'repeat' | 'book' | 'inbox' | 'bell' | 'layers'
  | 'chart' | 'zap' | 'sliders' | 'search' | 'plus' | 'clock' | 'lock' | 'check'
  | 'x' | 'chevd' | 'chevl' | 'chevr' | 'play' | 'stop' | 'down' | 'up' | 'info'
  | 'alert' | 'flame' | 'trash' | 'cols' | 'gantt' | 'net' | 'scale' | 'list' | 'pen'
  | 'dots' | 'route' | 'note' | 'tasklist' | 'unlock';

/** Mount once, high in the tree (the app shell). Renders no visible output. */
export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} aria-hidden="true">
      <symbol id="i-prism" viewBox="0 0 24 24"><path d="M12 3 3 20h18Z" /><path d="M12 3v17" /></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></symbol>
      <symbol id="i-cal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></symbol>
      <symbol id="i-repeat" viewBox="0 0 24 24"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></symbol>
      <symbol id="i-book" viewBox="0 0 24 24"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" /></symbol>
      <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z" /></symbol>
      <symbol id="i-bell" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 2-10 5 10 5 10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></symbol>
      <symbol id="i-chart" viewBox="0 0 24 24"><path d="M3 3v18h18" /><path d="M7 16v-5M12 16V8M17 16v-3" /></symbol>
      <symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" /></symbol>
      <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M3 6h9M18 6h3M3 12h3M12 12h9M3 18h9M18 18h3" /><circle cx="15.5" cy="6" r="2.2" /><circle cx="9.5" cy="12" r="2.2" /><circle cx="15.5" cy="18" r="2.2" /></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></symbol>
      {/* The same padlock with the shackle swung open — deliberately the SAME
          body and arc radius as i-lock, so cross-fading one into the other reads
          as a single lock moving rather than two different icons. */}
      <symbol id="i-unlock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-1.3" /></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="m4 12 5 5L20 7" /></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></symbol>
      <symbol id="i-chevd" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol>
      <symbol id="i-chevl" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></symbol>
      <symbol id="i-chevr" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></symbol>
      <symbol id="i-play" viewBox="0 0 24 24"><path d="M7 5v14l12-7Z" /></symbol>
      <symbol id="i-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></symbol>
      <symbol id="i-down" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></symbol>
      <symbol id="i-up" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v.01M12 12v4" /></symbol>
      <symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17v.01" /></symbol>
      <symbol id="i-flame" viewBox="0 0 24 24"><path d="M12 3c1.5 3.5 5 4.5 6 8 .8 2.8-.5 8-6 8s-6.8-5.2-6-8c1-3.5 4.5-4.5 6-8z" /></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></symbol>
      <symbol id="i-cols" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v12" /></symbol>
      <symbol id="i-gantt" viewBox="0 0 24 24"><path d="M4 6h9M10 12h10M4 18h6" strokeWidth={3} /></symbol>
      <symbol id="i-net" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></symbol>
      <symbol id="i-scale" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".5" /></symbol>
      <symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4" cy="6" r="1.2" /><circle cx="4" cy="12" r="1.2" /><circle cx="4" cy="18" r="1.2" /></symbol>
      <symbol id="i-pen" viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></symbol>
      <symbol id="i-dots" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></symbol>
      <symbol id="i-route" viewBox="0 0 24 24"><circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" /><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5" /></symbol>
      {/* a page with two lines of writing — legible down to ~11px, where a
          book/journal glyph turns to mush. */}
      <symbol id="i-note" viewBox="0 0 24 24"><path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></symbol>
      {/* checked box — the journal toolbar's "Task list". A drawn icon, not the
          ☑ character (U+2611): Inter has no glyph for it, so the font stack fell
          through to Segoe UI Emoji and rendered a COLOUR emoji that ignores
          `color` — the one non-monochrome mark in the editor chrome. */}
      <symbol id="i-tasklist" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m9 12 2 2 4-4" /></symbol>
    </svg>
  );
}

export interface IcProps {
  name: IconName;
  /** Overrides the default `px-ic` sizing class when set. */
  className?: string;
  /** Square px size; wins over the class via inline style. */
  size?: number;
  style?: CSSProperties;
  /** When provided, the icon is exposed to assistive tech with this label. */
  title?: string;
}

export function Ic({ name, className, size, style, title }: IcProps) {
  const sized: CSSProperties | undefined = size != null ? { width: size, height: size } : undefined;
  return (
    <svg
      className={className ?? 'px-ic'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      style={sized || style ? { ...sized, ...style } : undefined}
    >
      {title ? <title>{title}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
