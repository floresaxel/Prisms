/**
 * Centralized e2e navigation (web redesign W1 / D8). Specs address screens by a
 * stable semantic key instead of a sidebar label, so a label or route change (the
 * whole point of the redesign) touches THIS file only — not the ~57 navigations
 * spread across the specs. Every nav item carries `data-testid="nav-<key>"` and
 * every hub tab `data-testid="tab-<key>"`.
 */
import type { Page } from '@playwright/test';

export type NavKey =
  // sidebar items
  | 'myday'
  | 'tasks'
  | 'review'
  | 'agenda'
  | 'habits'
  | 'journal' // reserved — the standalone Journal screen lands in W6
  | 'projects'
  | 'dashboard'
  | 'automations'
  | 'settings'
  // Projects hub tabs (#board|#timeline|#graph|#decisions)
  | 'board'
  | 'timeline'
  | 'graph'
  | 'decisions'
  // Automations hub tabs (#rules|#blockers|#built-in)
  | 'rules'
  | 'blockers'
  | 'built-in';

const PROJECT_TABS = new Set<NavKey>(['board', 'timeline', 'graph', 'decisions']);
const AUTOMATION_TABS = new Set<NavKey>(['rules', 'blockers', 'built-in']);

/**
 * Navigate to a screen by semantic key. For a hub tab, clicks the parent nav
 * item then the tab, so the intended tab is reached regardless of the hub's
 * prior tab state.
 */
export async function goto(page: Page, key: NavKey): Promise<void> {
  if (PROJECT_TABS.has(key)) {
    await page.getByTestId('nav-projects').click();
    await page.getByTestId(`tab-${key}`).click();
    return;
  }
  if (AUTOMATION_TABS.has(key)) {
    await page.getByTestId('nav-automations').click();
    await page.getByTestId(`tab-${key}`).click();
    return;
  }
  await page.getByTestId(`nav-${key}`).click();
}
