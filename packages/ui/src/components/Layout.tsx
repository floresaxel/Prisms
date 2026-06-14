/** App shell: a sidebar of navigation links beside the routed main content. */
import type { ReactNode } from 'react';

export interface NavLinkSpec {
  label: string;
  href: string;
  active?: boolean;
}

export interface LayoutProps {
  title: string;
  nav: NavLinkSpec[];
  onNavigate?: (href: string) => void;
  status?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, nav, onNavigate, status, children }: LayoutProps) {
  return (
    <div className="px-app">
      <aside className="px-sidebar">
        <div className="px-brand">{title}</div>
        <nav>
          {nav.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`px-navlink${link.active ? ' px-navlink--active' : ''}`}
              onClick={(e) => {
                if (onNavigate) {
                  e.preventDefault();
                  onNavigate(link.href);
                }
              }}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="px-sidebar-foot">{status}</div>
      </aside>
      <main className="px-main">{children}</main>
    </div>
  );
}
