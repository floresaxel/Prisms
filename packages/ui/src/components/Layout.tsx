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

function NavLink({ item, active, onNavigate }: { item: NavItemSpec; active: boolean; onNavigate?: (href: string) => void }) {
  return (
    <a
      href={item.href}
      data-testid={`nav-${item.key}`}
      className={`px-navlink${active ? ' px-navlink--active' : ''}`}
      onClick={(e) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(item.href);
        }
      }}
    >
      <Ic name={item.icon} />
      <span>{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className={`px-nav-badge${item.badgeTone === 'alert' ? ' px-nav-badge--alert' : ''}`}>{item.badge}</span>
      )}
    </a>
  );
}

export function Layout({ brand = 'Prisms', groups, foot, active, onNavigate, breadcrumb, sync, timer, user, footer, children }: LayoutProps) {
  const initial = (user?.name?.trim()?.[0] ?? user?.email?.[0] ?? '?').toUpperCase();
  return (
    <div className="px-app">
      <IconSprite />
      <aside className="px-sidebar">
        <div className="px-brand">
          <span className="px-brand-logo"><Ic name="prism" /></span>
          {brand}
        </div>
        <nav className="px-nav">
          {groups.map((group, gi) => (
            <div key={group.label ?? `g${gi}`}>
              {group.label && <div className="px-nav-group">{group.label}</div>}
              {group.items.map((item) => (
                <NavLink key={item.key} item={item} active={item.href === active} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
        </nav>
        <div className="px-sidebar-foot">
          {foot?.map((item) => (
            <NavLink key={item.key} item={item} active={item.href === active} onNavigate={onNavigate} />
          ))}
          {user && (
            <div className="px-sidebar-user">
              <span className="px-avatar">{initial}</span>
              <span>{user.email}</span>
            </div>
          )}
          {footer}
        </div>
      </aside>
      <div className="px-shell">
        <header className="px-topbar">
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
