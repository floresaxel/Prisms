/**
 * App shell v2 (web redesign W1 / D2): a grouped sidebar + a topbar. The topbar
 * owns the breadcrumb, a persistent HH:MM clock, a slot for the global running-
 * timer pill (D7), the sync chip, and the avatar. Layout is "dumb": every badge
 * count and status node is passed in from App — it only lays them out. The icon
 * sprite (W0) is mounted here once so `<Ic/>` works anywhere below.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { Ic, IconSprite, type IconName } from './icons';

export interface NavItemSpec {
  /** Stable semantic id — drives `data-testid="nav-<key>"` (e2e nav helper). */
  key: string;
  label: string;
  href: string;
  icon: IconName;
  /** Rendered only when a positive number is passed. */
  badge?: number;
  badgeTone?: 'default' | 'alert';
}

export interface NavGroupSpec {
  /** Uppercase section heading; omitted for the top ungrouped items. */
  label?: string;
  items: NavItemSpec[];
}

export interface BreadcrumbSpec {
  section: string;
  page: string;
}

export interface LayoutProps {
  brand?: string;
  /**
   * Where the brand mark goes when the sidebar is already open (the app's home —
   * My Day). Omit it and the mark stays inert there; on a RAIL it is a control
   * either way, because opening the sidebar is then the more useful thing it can
   * do. The destination's own nav label supplies the accessible name, so the two
   * cannot drift apart.
   */
  brandHref?: string;
  groups: NavGroupSpec[];
  /** Nav items pinned to the sidebar foot (e.g. Settings). */
  foot?: NavItemSpec[];
  /** Active href — the matching nav item is highlighted. */
  active: string;
  onNavigate?: (href: string) => void;
  breadcrumb: BreadcrumbSpec;
  /** Sync chip content for the topbar (carries `data-testid="sync-state"`). */
  sync?: ReactNode;
  /** Global running-timer pill for the topbar (D7); absent when no timer runs. */
  timer?: ReactNode;
  user?: { name?: string; email: string };
  /** Extra sidebar-foot controls (sign-out, desktop-notify). */
  footer?: ReactNode;
  children: ReactNode;
}

/** Persistent HH:MM wall clock (1 s tick, tabular-nums) — D2. */
function NowClock() {
  const [label, setLabel] = useState(() => hhmm());
  useEffect(() => {
    const t = setInterval(() => setLabel(hhmm()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="px-now-clock" title="Current time">
      <Ic name="clock" />
      <span>{label}</span>
    </div>
  );
}

function hhmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function NavLink({ item, active, onNavigate, rail }: { item: NavItemSpec; active: boolean; onNavigate?: (href: string) => void; rail: boolean }) {
  return (
    <a
      href={item.href}
      data-testid={`nav-${item.key}`}
      className={`px-navlink${active ? ' px-navlink--active' : ''}`}
      // A nav item is a place to go, not a thing to pick up. It is an anchor, so
      // the browser would otherwise let a press-and-move peel a URL off it —
      // which reads as the sidebar being reorderable, and looks like a bug when
      // dropping it does nothing.
      draggable={false}
      // collapsed, the label is gone — the native tooltip carries it instead.
      title={rail ? item.label : undefined}
      aria-label={rail ? item.label : undefined}
      onClick={(e) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(item.href);
        }
      }}
    >
      <Ic name={item.icon} />
      <span className="px-navlink-lbl">{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className={`px-nav-badge${item.badgeTone === 'alert' ? ' px-nav-badge--alert' : ''}`}>{item.badge}</span>
      )}
    </a>
  );
}

const RAIL_KEY = 'prisms.sidebar.collapsed';
const PIN_KEY = 'prisms.sidebar.pinned';
/** Below this the sidebar is a rail regardless of preference — a 234px nav on a
 *  narrow window costs more than it gives. */
const RAIL_FORCE_W = 900;
/** How long the pointer must rest on the rail before it opens itself. */
export const PEEK_DELAY_MS = 1000;

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false; // storage denied (private mode / desktop shell)
  }
};
const writeFlag = (key: string, on: boolean): void => {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* preference is best-effort */
  }
};

interface SidebarState {
  /** Rendered as the icons-only rail right now. */
  rail: boolean;
  /** The window is too narrow for the full nav — no preference can win. */
  forced: boolean;
  /** Held open: the rail cannot take it back, and neither can the button. */
  pinned: boolean;
  /** Open only because the pointer (or the keyboard) is on the rail. */
  peeking: boolean;
  toggleRail: () => void;
  togglePin: () => void;
  setHovering: (on: boolean) => void;
  setFocused: (on: boolean) => void;
}

/**
 * What the sidebar is doing, from three inputs that can disagree.
 *
 *  - `collapsed` — the user's own preference, persisted.
 *  - `pinned` — held open ON TOP of that preference, also persisted. Unpinning
 *    restores whatever `collapsed` said, rather than guessing.
 *  - `forced` — the window is too narrow, which overrules both.
 *
 * On top of those sits the PEEK, which is the ONLY way back from a rail: it
 * carries no expand button, so resting the pointer there for `PEEK_DELAY_MS`
 * is what opens it, and leaving closes it again. One derived condition driving
 * one timer, which is what makes the awkward cases fall out for free — unpin
 * while the pointer is still on the sidebar and the peek simply re-arms rather
 * than stranding it shut under a cursor that never left.
 *
 * Focus peeks too, and WITHOUT the delay: a keyboard has no way to rest on
 * anything, and with no button to tab to, a delayed focus-peek would leave the
 * rail permanently shut for anyone not using a mouse.
 */
function useSidebar(): SidebarState {
  const [collapsed, setCollapsed] = useState(() => readFlag(RAIL_KEY));
  const [pinned, setPinned] = useState(() => readFlag(PIN_KEY));
  const [forced, setForced] = useState(() => window.innerWidth < RAIL_FORCE_W);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [peeking, setPeeking] = useState(false);

  useEffect(() => {
    const onResize = () => setForced(window.innerWidth < RAIL_FORCE_W);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * Is the keyboard driving? A press focuses whatever it lands on, so focus
   * alone cannot mean "a keyboard arrived here" — clicking the pin, or a nav
   * link, would otherwise hold the peek open long after the pointer had left.
   * Tab says yes, the next press says no. (`:focus-visible` decides exactly
   * this and decides it better, but it answers "no" to programmatic focus in
   * both jsdom and a driven browser, so the behaviour could not be tested.)
   */
  const [keyNav, setKeyNav] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') setKeyNav(true);
    };
    const onPress = () => setKeyNav(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onPress, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onPress, true);
    };
  }, []);

  // Only a sidebar that is actually shut has anything to open.
  const openable = collapsed && !pinned && !forced;
  const waiting = hovering && openable;
  useEffect(() => {
    if (!waiting) {
      setPeeking(false);
      return;
    }
    const t = setTimeout(() => setPeeking(true), PEEK_DELAY_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  // the pointer waits its turn; the keyboard does not
  const peek = peeking || (focused && keyNav && openable);

  return {
    rail: forced || (!pinned && collapsed && !peek),
    forced,
    pinned,
    peeking: peek,
    toggleRail: () => {
      setCollapsed(!collapsed);
      writeFlag(RAIL_KEY, !collapsed);
      // The button is ON the sidebar, so collapsing always happens with the
      // pointer resting there — and the peek would open again a beat later,
      // making the button look broken. The click counts as leaving; the next
      // real entry re-arms it. Focus goes with it: the button is about to
      // unmount, which fires no blur to clear it.
      setHovering(false);
      setFocused(false);
    },
    togglePin: () => {
      setPinned(!pinned);
      writeFlag(PIN_KEY, !pinned);
    },
    setHovering,
    setFocused,
  };
}

export function Layout({ brand = 'Prisms', brandHref, groups, foot, active, onNavigate, breadcrumb, sync, timer, user, footer, children }: LayoutProps) {
  const initial = (user?.name?.trim()?.[0] ?? user?.email?.[0] ?? '?').toUpperCase();
  const { rail, forced, pinned, peeking, toggleRail, togglePin, setHovering, setFocused } = useSidebar();
  /**
   * Can the mark still OPEN something? Only while the sidebar is shut by choice.
   * A rail the window forced cannot be opened at all, so offering to would be a
   * button that visibly does nothing — there it falls through to navigating,
   * which at least works. A peek counts as open: it looks open, so the mark does
   * what an open sidebar's mark does.
   */
  const marksExpands = rail && !forced;
  /** The nav item the brand points at, for the mark's accessible name. */
  const home = brandHref === undefined
    ? undefined
    : [...groups.flatMap((g) => g.items), ...(foot ?? [])].find((i) => i.href === brandHref);
  return (
    <div className={`px-app${rail ? ' px-app--rail' : ''}`}>
      <IconSprite />
      <aside
        className={`px-sidebar${rail ? ' px-sidebar--rail' : ''}${peeking ? ' px-sidebar--peek' : ''}`}
        data-state={rail ? 'rail' : peeking ? 'peek' : 'open'}
        data-pinned={pinned ? 'true' : 'false'}
        // the peek's whole input: resting here opens it, leaving closes it again
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        // The brand mark is the one thing here that does NOT peek. It is the
        // rail's explicit way open, and a focus peek would open the sidebar the
        // instant it was tabbed to — which swaps the mark from a button to a
        // link, i.e. unmounts the element holding focus. Focus would fall to the
        // body, the blur below would read that as leaving, and the rail would
        // shut again under a keyboard that had just arrived. Skipping it costs
        // one tab stop: the next stop is a nav link, which peeks as it always
        // did, and pressing the mark opens the sidebar outright.
        onFocus={(e) => {
          if (!(e.target as Element).closest?.('[data-brand-mark]')) setFocused(true);
        }}
        // focus-WITHIN: ignore the blur half of a move between two children,
        // which would otherwise shut the rail between every pair of nav links
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
      >
        <div className="px-brand">
          {/* The mark carries whichever job the sidebar leaves it. Shut, it is
              the way back open — the rail's chevron was removed on the grounds
              that you are already pointing at the sidebar, and the mark is the
              biggest thing on it. Open, there is nothing left to expand, so it
              becomes what a logo usually is: the way home. Same 22px badge in
              both, so nothing moves as the job changes. */}
          {marksExpands ? (
            <button
              type="button"
              className="px-brand-logo px-brand-logo--act"
              data-testid="brand-expand"
              data-brand-mark=""
              aria-label="expand sidebar"
              aria-expanded={false}
              title="Expand sidebar"
              onClick={toggleRail}
            >
              <Ic name="prism" />
            </button>
          ) : home !== undefined ? (
            <a
              href={home.href}
              className="px-brand-logo px-brand-logo--act"
              data-testid="brand-home"
              data-brand-mark=""
              aria-label={`${brand} — go to ${home.label}`}
              title={`Go to ${home.label}`}
              draggable={false} // the mark is a link too, and picks up the same way
              onClick={(e) => {
                if (onNavigate) {
                  e.preventDefault();
                  onNavigate(home.href);
                }
              }}
            >
              <Ic name="prism" />
            </a>
          ) : (
            <span className="px-brand-logo"><Ic name="prism" /></span>
          )}
          <span className="px-brand-lbl">{brand}</span>
          {/* Both controls belong to a sidebar that is SHOWING. A rail carries
              none — it is opened by resting on it, not by aiming at a 34px
              chevron, and a button to expand something you are already hovering
              is the one it can most afford to lose. */}
          {!rail && (
            <div className="px-sidebar-ctl">
              <button
                className={`px-btn px-btn--icon px-pin-toggle${pinned ? ' px-pin-toggle--on' : ''}`}
                data-testid="sidebar-pin"
                aria-label={pinned ? 'unpin sidebar' : 'pin sidebar open'}
                aria-pressed={pinned}
                title={pinned ? 'Unpin — let the sidebar collapse again' : 'Pin — keep the sidebar expanded'}
                onClick={togglePin}
              >
                <Ic name="pin" />
              </button>
              <button
                className="px-btn px-btn--icon px-rail-toggle"
                data-testid="sidebar-toggle"
                aria-label="collapse sidebar"
                aria-expanded
                // a pinned sidebar refuses to collapse; a forced rail never
                // renders this button at all, so only the pin can disable it
                disabled={pinned}
                title={pinned ? 'Pinned open — unpin it to collapse' : 'Collapse sidebar'}
                onClick={toggleRail}
              >
                <Ic name="chevl" />
              </button>
            </div>
          )}
        </div>
        <nav className="px-nav">
          {groups.map((group, gi) => (
            <div key={group.label ?? `g${gi}`}>
              {group.label && <div className="px-nav-group">{group.label}</div>}
              {group.items.map((item) => (
                <NavLink key={item.key} item={item} active={item.href === active} onNavigate={onNavigate} rail={rail} />
              ))}
            </div>
          ))}
        </nav>
        <div className="px-sidebar-foot">
          {foot?.map((item) => (
            <NavLink key={item.key} item={item} active={item.href === active} onNavigate={onNavigate} rail={rail} />
          ))}
          {user && (
            <div className="px-sidebar-user" title={user.email}>
              <span className="px-avatar">{initial}</span>
              <span className="px-sidebar-email">{user.email}</span>
            </div>
          )}
          <div className="px-sidebar-actions">{footer}</div>
        </div>
      </aside>
      <div className="px-shell">
        <header className="px-topbar">
          {/* the collapse control used to live here; it belongs to the thing it
              collapses, so it now sits in the sidebar's own brand row. */}
          <div className="px-crumb">
            <span>{breadcrumb.section}</span>
            <span className="px-crumb-sep">/</span>
            <b>{breadcrumb.page}</b>
          </div>
          <div className="px-topbar-right">
            <NowClock />
            {timer}
            {sync}
            {user && (
              <span className="px-avatar" title={user.email}>{initial}</span>
            )}
          </div>
        </header>
        <main className="px-content">{children}</main>
      </div>
    </div>
  );
}
