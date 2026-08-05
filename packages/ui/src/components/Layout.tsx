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
/** Below this the sidebar is a rail regardless of preference — a 234px nav on a
 *  narrow window costs more than it gives. */
const RAIL_FORCE_W = 900;

/**
 * Sidebar collapse state: the user's preference, overridden to `true` while the
 * window is too narrow to afford the full nav. Persisted so it survives reloads.
 */
function useSidebarRail(): [boolean, boolean, () => void] {
  const [pref, setPref] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1';
    } catch {
      return false; // storage denied (private mode / desktop shell)
    }
  });
  const [forced, setForced] = useState(() => window.innerWidth < RAIL_FORCE_W);
  useEffect(() => {
    const onResize = () => setForced(window.innerWidth < RAIL_FORCE_W);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggle = () => {
    setPref((p) => {
      const next = !p;
      try {
        localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      } catch {
        /* preference is best-effort */
      }
      return next;
    });
  };
  return [pref || forced, forced, toggle];
}

export function Layout({ brand = 'Prisms', groups, foot, active, onNavigate, breadcrumb, sync, timer, user, footer, children }: LayoutProps) {
  const initial = (user?.name?.trim()?.[0] ?? user?.email?.[0] ?? '?').toUpperCase();
  const [rail, railForced, toggleRail] = useSidebarRail();
  return (
    <div className={`px-app${rail ? ' px-app--rail' : ''}`}>
      <IconSprite />
      <aside className={`px-sidebar${rail ? ' px-sidebar--rail' : ''}`}>
        <div className="px-brand">
          <span className="px-brand-logo"><Ic name="prism" /></span>
          <span className="px-brand-lbl">{brand}</span>
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
          <button
            className="px-btn px-btn--icon px-rail-toggle"
            data-testid="sidebar-toggle"
            aria-label={rail ? 'expand sidebar' : 'collapse sidebar'}
            aria-expanded={!rail}
            // while the window forces the rail, the preference cannot win.
            disabled={railForced}
            title={railForced ? 'The window is too narrow for the full sidebar' : rail ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleRail}
          >
            <Ic name={rail ? 'chevr' : 'chevl'} />
          </button>
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
