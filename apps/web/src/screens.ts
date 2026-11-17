/**
 * The screens, each in a chunk of its own (load plan, phase 4).
 *
 * With every screen imported up front, the startup chunk carried the journal
 * editor (TipTap + ProseMirror + markdown-it), the graph library (xyflow + d3)
 * and the markdown renderer (micromark/mdast) — over a third of its code — to
 * draw My Day, which uses none of them. Each screen now loads on demand:
 *   - the screen the page opens on starts loading while the startup chunk is
 *     still being evaluated (`preloadScreen`, called from App.tsx at load), so
 *     its fetch overlaps everything else boot does;
 *   - the rest are fetched once the browser is idle (`preloadAllScreens`), so
 *     moving between screens stays instant and the service worker never has to
 *     wait on the network for one.
 * Every chunk is still in the service worker's precache, so offline navigation
 * works exactly as before.
 */
import { lazy } from 'react';

export type Route =
  | '/'
  | '/tasks'
  | '/agenda'
  | '/habits'
  | '/journal'
  | '/vision'
  | '/roadmap'
  | '/projects'
  | '/dashboard'
  | '/automations'
  | '/review'
  | '/settings';

/** One loader per route; `import()` is cached, so preloading and rendering share the module. */
const modules = {
  '/': () => import('./screens/MyDay'),
  '/tasks': () => import('./screens/Tasks'),
  '/agenda': () => import('./screens/Agenda'),
  '/habits': () => import('./screens/Habits'),
  '/journal': () => import('./screens/Journal'),
  '/vision': () => import('./screens/Vision'),
  '/roadmap': () => import('./screens/Roadmap'),
  '/projects': () => import('./screens/Projects'),
  '/dashboard': () => import('./screens/Dashboard'),
  '/automations': () => import('./screens/Automations'),
  '/review': () => import('./screens/Review'),
  '/settings': () => import('./screens/Settings'),
} satisfies Record<Route, () => Promise<unknown>>;

export const MyDay = lazy(() => modules['/']().then((m) => ({ default: m.MyDay })));
export const Tasks = lazy(() => modules['/tasks']().then((m) => ({ default: m.Tasks })));
export const Agenda = lazy(() => modules['/agenda']().then((m) => ({ default: m.Agenda })));
export const Habits = lazy(() => modules['/habits']().then((m) => ({ default: m.Habits })));
export const Journal = lazy(() => modules['/journal']().then((m) => ({ default: m.Journal })));
export const Vision = lazy(() => modules['/vision']().then((m) => ({ default: m.Vision })));
export const Roadmap = lazy(() => modules['/roadmap']().then((m) => ({ default: m.Roadmap })));
export const Projects = lazy(() => modules['/projects']().then((m) => ({ default: m.Projects })));
export const Dashboard = lazy(() => modules['/dashboard']().then((m) => ({ default: m.Dashboard })));
export const Automations = lazy(() => modules['/automations']().then((m) => ({ default: m.Automations })));
export const Review = lazy(() => modules['/review']().then((m) => ({ default: m.Review })));
export const Settings = lazy(() => modules['/settings']().then((m) => ({ default: m.Settings })));

/**
 * Start fetching one screen's chunk now. A failure is not reported here: the
 * screen's own render asks again, and its error boundary says what went wrong.
 */
export function preloadScreen(route: Route): void {
  modules[route]().catch(() => undefined);
}

/** Fetch every screen's chunk — for an idle moment after the first one is up. */
export function preloadAllScreens(): void {
  for (const load of Object.values(modules)) load().catch(() => undefined);
}

/**
 * Run `fn` once the browser is idle (or after `fallbackMs` where there is no
 * `requestIdleCallback`, as in Safari). Returns a cancel function.
 */
export function whenIdle(fn: () => void, fallbackMs = 1500): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 5000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, fallbackMs);
  return () => window.clearTimeout(id);
}
