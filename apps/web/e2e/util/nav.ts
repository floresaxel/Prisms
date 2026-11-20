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
  | 'vision' // Plan › Vision — a vision managed on its own screen
  | 'roadmap' // Plan › Roadmap — likewise (it left the Projects hub)
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

/** The route each sidebar item shows. */
const ROUTE: Partial<Record<NavKey, string>> = {
  myday: '/',
  tasks: '/tasks',
  review: '/review',
  agenda: '/agenda',
  habits: '/habits',
  journal: '/journal',
  vision: '/vision',
  roadmap: '/roadmap',
  projects: '/projects',
  dashboard: '/dashboard',
  automations: '/automations',
  settings: '/settings',
};

/**
 * Click a sidebar item and wait until its screen is the one SHOWN. A screen
 * change blurs the old page out first (pageSwap.ts), so for ~150 ms the sidebar
 * already names the new screen while the old one is still mounted; the page
 * wrapper's `data-route` moves only when the new screen is committed. Without
 * this, a spec that leaves a screen and comes straight back never left it.
 */
async function openScreen(page: Page, key: NavKey): Promise<void> {
  await page.getByTestId(`nav-${key}`).click();
  const route = ROUTE[key];
  if (route) await page.locator(`#px-page[data-route="${route}"]`).waitFor();
}

/**
 * Navigate to a screen by semantic key. For a hub tab, clicks the parent nav
 * item then the tab, so the intended tab is reached regardless of the hub's
 * prior tab state.
 */
export async function goto(page: Page, key: NavKey): Promise<void> {
  if (PROJECT_TABS.has(key)) {
    await openScreen(page, 'projects');
    await page.getByTestId(`tab-${key}`).click();
    return;
  }
  if (AUTOMATION_TABS.has(key)) {
    await openScreen(page, 'automations');
    await page.getByTestId(`tab-${key}`).click();
    return;
  }
  await openScreen(page, key);
}
