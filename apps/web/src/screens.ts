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
import { lazy, type ComponentType } from 'react';

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

/** Each route's module once its chunk has arrived (see `screen`). */
const loaded = new Map<Route, unknown>();

/** Fetch a screen's chunk, remembering the module for `screen`'s synchronous path. */
function load(route: Route): Promise<unknown> {
  return modules[route]().then((m) => {
    loaded.set(route, m);
    return m;
  });
}

/**
 * A lazy screen that does NOT suspend once its chunk is already here. React's
 * `lazy` resolves synchronously when its loader returns a thenable that settles
 * on the spot (it calls `then` and checks the status straight after); a real
 * promise settles a microtask later, so the first render of every screen used
 * to flash the Suspense skeleton even with the chunk preloaded — and a page
 * switch (`swapPage`) would blur in on that skeleton, then snap to the page.
 */
function screen<P extends object>(route: Route, pick: (m: never) => ComponentType<P>) {
  const component = (m: unknown) => ({ default: pick(m as never) });
  return lazy(() => {
    const m = loaded.get(route);
    if (m === undefined) return load(route).then(component);
    const settled = { then: (resolve: (v: { default: ComponentType<P> }) => void) => resolve(component(m)) };
    return settled as unknown as Promise<{ default: ComponentType<P> }>;
  });
}

export const MyDay = screen('/', (m: typeof import('./screens/MyDay')) => m.MyDay);
export const Tasks = screen('/tasks', (m: typeof import('./screens/Tasks')) => m.Tasks);
export const Agenda = screen('/agenda', (m: typeof import('./screens/Agenda')) => m.Agenda);
export const Habits = screen('/habits', (m: typeof import('./screens/Habits')) => m.Habits);
export const Journal = screen('/journal', (m: typeof import('./screens/Journal')) => m.Journal);
export const Vision = screen('/vision', (m: typeof import('./screens/Vision')) => m.Vision);
export const Roadmap = screen('/roadmap', (m: typeof import('./screens/Roadmap')) => m.Roadmap);
export const Projects = screen('/projects', (m: typeof import('./screens/Projects')) => m.Projects);
export const Dashboard = screen('/dashboard', (m: typeof import('./screens/Dashboard')) => m.Dashboard);
export const Automations = screen('/automations', (m: typeof import('./screens/Automations')) => m.Automations);
export const Review = screen('/review', (m: typeof import('./screens/Review')) => m.Review);
export const Settings = screen('/settings', (m: typeof import('./screens/Settings')) => m.Settings);

/**
 * Start fetching one screen's chunk now. A failure is not reported here: the
 * screen's own render asks again, and its error boundary says what went wrong.
 */
export function preloadScreen(route: Route): void {
  load(route).catch(() => undefined);
}

/** A screen's chunk; once this resolves the screen renders without suspending. */
export function loadScreen(route: Route): Promise<unknown> {
  return load(route);
}

/** Fetch every screen's chunk — for an idle moment after the first one is up. */
export function preloadAllScreens(): void {
  for (const route of Object.keys(modules) as Route[]) load(route).catch(() => undefined);
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
