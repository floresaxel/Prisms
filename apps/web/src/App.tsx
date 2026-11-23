/**
 * App shell: render the remembered account from its local PowerSync database at
 * once, confirm the Better Auth session in the background, and only then connect
 * (sync + upload) — see `session-boot.ts`. A global toast surfaces server
 * command rejections (the row itself rolls back via sync).
 *
 * Web redesign W1: consolidated routes with old→new redirects (D3) rendered
 * inside the Layout v2 shell (grouped nav + topbar); the running-timer pill and
 * its focus-review modal are global (GlobalTimer, D7). Nav badges come from the
 * shared read layer, so the shell composition lives in <Shell> (mounted BELOW
 * PrismsDataProvider) while db lifecycle + routing stay in <AuthedApp>.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PowerSyncDatabase } from '@powersync/web';
import { PowerSyncContext } from '@powersync/react';
import {
  clearReadCaches,
  getDeviceId,
  Layout,
  loadImportedHlcFloor,
  PrismsDataProvider,
  useActivityInbox,
  useIsHydrated,
  useReviewInbox,
  type BreadcrumbSpec,
  type CommandContext,
  type CommandRejection,
  type NavGroupSpec,
  type NavItemSpec,
} from '@prisms/ui';

import { checkSession, signOut, type SessionUser } from './auth';
import { GlobalTimer } from './components/GlobalTimer';
import { TaskDetailProvider } from './components/TaskDetail';
import { TimersProvider } from './components/Timers';
import { ReviewBanner } from './components/ReviewBanner';
import { SyncChip } from './components/SyncChip';
import { TimezoneClock } from './components/TimezoneClock';
import { isDesktop, osNotify } from './desktop';
import { clearDrafts } from './drafts';
import { rejectionMessage } from './format';
import { ScreenBoundary } from './components/ScreenBoundary';
import { holdPage, revealPage, swapPage } from './components/pageSwap';
import { clearLocalAccount, connectDb, dbFor, forgetDb } from './powersync';
import {
  Agenda,
  Automations,
  Dashboard,
  Habits,
  Journal,
  MyDay,
  preloadAllScreens,
  loadScreen,
  preloadScreen,
  Projects,
  Review,
  Roadmap,
  Settings,
  Tasks,
  Vision,
  whenIdle,
  type Route,
} from './screens';
// Not split: it is the first thing a signed-out browser sees, and small.
import { Login } from './screens/Login';
import { forgetCachedUser, readCachedUser, rememberUser, settleBootSession } from './session-boot';
import { usePendingSessionReviews } from './session-reviews';

const ROUTES = new Set<Route>(['/', '/tasks', '/agenda', '/habits', '/journal', '/vision', '/roadmap', '/projects', '/dashboard', '/automations', '/review', '/settings']);

// Old flat routes → new consolidated route (+ hub tab hash), applied once on boot
// (D3) so bookmarks and mid-migration deep links never 404. The hub reads the
// hash to select its tab.
const REDIRECTS: Record<string, string> = {
  '/inbox': '/tasks',
  '/worklist': '/',
  '/kanban': '/projects#board',
  '/gantt': '/projects#timeline',
  '/flowchart': '/projects#graph',
  '/decisions': '/projects#decisions',
  '/rules': '/automations#rules',
  '/blockers': '/automations#blockers',
};

/**
 * The Roadmap tab left the Projects hub for its own Plan route, so the hash a
 * `/kanban`-era bookmark (or the redirect above) lands on has to follow it —
 * a pathname-keyed REDIRECT cannot see the hash.
 */
const HASH_REDIRECTS: Record<string, Record<string, string>> = {
  '/projects': { '#roadmap': '/roadmap' },
};

const CRUMBS: Record<Route, BreadcrumbSpec> = {
  '/': { section: 'My work', page: 'My Day' },
  '/tasks': { section: 'My work', page: 'Tasks' },
  '/agenda': { section: 'My work', page: 'Agenda' },
  '/habits': { section: 'My work', page: 'Habits & Skills' },
  '/journal': { section: 'My work', page: 'Journal' },
  '/vision': { section: 'Plan', page: 'Vision' },
  '/roadmap': { section: 'Plan', page: 'Roadmap' },
  '/projects': { section: 'Plan', page: 'Projects' },
  '/dashboard': { section: 'Plan', page: 'Dashboard' },
  '/automations': { section: 'Automate', page: 'Automations' },
  '/review': { section: 'My work', page: 'Review' },
  '/settings': { section: 'Workspace', page: 'Settings' },
};

/**
 * Where a URL lands, and the address-bar rewrites that gets it there — pure, so
 * the landing screen can be preloaded before anything is rewritten. First hop:
 * an old→new redirect for a legacy path; second hop: a route whose HASH moved
 * to a route of its own (`/projects#roadmap`). An unknown path lands on My Day
 * and keeps its URL.
 */
function landingFor(path: string, hash: string): { route: Route; rewrites: string[] } {
  const rewrites: string[] = [];
  const redirect = REDIRECTS[path];
  let href: string;
  if (redirect) {
    rewrites.push(redirect);
    href = redirect;
  } else if (ROUTES.has(path as Route)) {
    href = path + hash;
  } else {
    return { route: '/', rewrites };
  }
  const [hrefPath = '/', hrefHash] = href.split('#');
  const moved = hrefHash ? HASH_REDIRECTS[hrefPath]?.[`#${hrefHash}`] : undefined;
  if (moved) {
    rewrites.push(moved);
    return { route: moved as Route, rewrites };
  }
  return { route: hrefPath as Route, rewrites };
}

/** Boot route: apply the old→new redirects (replaceState) if the path is legacy. */
function resolveBootRoute(): Route {
  const { route, rewrites } = landingFor(window.location.pathname, window.location.hash);
  for (const href of rewrites) window.history.replaceState({}, '', href);
  return route;
}

// Start fetching the screen this page opens on now, while the rest of the
// startup chunk is still being evaluated (see `screens.ts`).
preloadScreen(landingFor(window.location.pathname, window.location.hash).route);

/** The element around the current screen that a page switch blurs (see navigate). */
const PAGE_SWAP_ID = 'px-page';

/** The longest the first screen waits, hidden, for its data before it blurs in anyway. */
const BOOT_MAX_WAIT_MS = 700;

/**
 * First load — a reload, or the first screen after signing in: the page area
 * starts hidden and blurred, and blurs in once the first screen's chunk is here
 * and the local data has hydrated, so what blurs in is the page itself rather
 * than a skeleton. A first sign-in can wait seconds on its first sync, so after
 * BOOT_MAX_WAIT_MS it blurs in regardless. The sidebar is never held.
 */
function useBootReveal(route: Route): (el: HTMLDivElement | null) => void {
  const hydrated = useIsHydrated();
  const pageRef = useRef<HTMLDivElement | null>(null);
  // a ref callback runs at commit, before the first paint
  const holdRef = useCallback((el: HTMLDivElement | null) => {
    pageRef.current = el;
    if (el) holdPage(el);
  }, []);
  const [firstRoute] = useState(route);
  const [chunkReady, setChunkReady] = useState(false);
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    let live = true;
    void loadScreen(firstRoute)
      .catch(() => undefined)
      .then(() => {
        if (live) setChunkReady(true);
      });
    const t = window.setTimeout(() => {
      if (live) setCapped(true);
    }, BOOT_MAX_WAIT_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [firstRoute]);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || !(capped || (chunkReady && hydrated))) return;
    // two frames: a screen that suspended on its first render commits before the reveal
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => revealPage(el));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [capped, chunkReady, hydrated]);
  return holdRef;
}

/** Shell composition — mounted inside PrismsDataProvider so it can read the
 *  inbox/review counts for the nav badges. Layout itself stays presentational. */
function Shell({
  user,
  route,
  navRoute,
  navigate,
  ctx,
  connected,
  rejections,
  onClearRejections,
  onSignOut,
}: {
  user: SessionUser;
  route: Route;
  /** Where the user is going: the sidebar and breadcrumb move at once, while
   *  `route` (the screen) follows when the page swap has blurred the old one out. */
  navRoute: Route;
  navigate: (href: string) => void;
  ctx: CommandContext;
  connected: boolean;
  rejections: CommandRejection[];
  onClearRejections: () => void;
  onSignOut: () => void;
}) {
  const inboxCount = useActivityInbox().length;
  // the inbox plus the sessions put off with "Review later"
  const reviewCount = useReviewInbox().length + usePendingSessionReviews().length;
  const pageRef = useBootReveal(route);

  const groups: NavGroupSpec[] = [
    {
      items: [
        { key: 'tasks', label: 'Tasks', href: '/tasks', icon: 'list', badge: inboxCount },
        { key: 'review', label: 'Review', href: '/review', icon: 'bell', badge: reviewCount, badgeTone: 'alert' },
      ],
    },
    {
      label: 'My work',
      items: [
        { key: 'myday', label: 'My Day', href: '/', icon: 'sun' },
        { key: 'agenda', label: 'Agenda', href: '/agenda', icon: 'cal' },
        { key: 'habits', label: 'Habits & Skills', href: '/habits', icon: 'repeat' },
        { key: 'journal', label: 'Journal', href: '/journal', icon: 'book' },
      ],
    },
    {
      label: 'Plan',
      // top-down, the way the tree is: a vision owns roadmaps, a roadmap owns
      // projects. Each level is managed on its own screen (I1).
      items: [
        { key: 'vision', label: 'Vision', href: '/vision', icon: 'eye' },
        { key: 'roadmap', label: 'Roadmap', href: '/roadmap', icon: 'route' },
        { key: 'projects', label: 'Projects', href: '/projects', icon: 'layers' },
        { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'chart' },
      ],
    },
    {
      label: 'Automate',
      items: [{ key: 'automations', label: 'Automations', href: '/automations', icon: 'zap' }],
    },
  ];
  const foot: NavItemSpec[] = [{ key: 'settings', label: 'Settings', href: '/settings', icon: 'sliders' }];

  const screen: ReactNode =
    (
      {
        '/': <MyDay ctx={ctx} onNavigate={navigate} />,
        '/tasks': <Tasks ctx={ctx} />,
        '/agenda': <Agenda ctx={ctx} />,
        '/habits': <Habits ctx={ctx} />,
        '/journal': <Journal ctx={ctx} />,
        '/vision': <Vision ctx={ctx} onNavigate={navigate} />,
        '/roadmap': <Roadmap ctx={ctx} onNavigate={navigate} />,
        '/projects': <Projects ctx={ctx} />,
        '/dashboard': <Dashboard ctx={ctx} />,
        '/automations': <Automations ctx={ctx} />,
        '/review': <Review ctx={ctx} />,
        '/settings': <Settings ctx={ctx} />,
      } satisfies Record<Route, ReactNode>
    )[route] ?? <MyDay ctx={ctx} onNavigate={navigate} />;

  return (
    <TimersProvider ctx={ctx}>
    <TaskDetailProvider ctx={ctx}>
    <Layout
      groups={groups}
      foot={foot}
      // the brand mark opens a collapsed sidebar; once open it goes to My Day
      brandHref="/"
      active={navRoute}
      onNavigate={navigate}
      breadcrumb={CRUMBS[navRoute]}
      clock={<TimezoneClock ctx={ctx} />}
      timer={<GlobalTimer />}
      user={{ name: user.name, email: user.email }}
      sync={<SyncChip connected={connected} />}
      footer={
        <>
          {isDesktop() && (
            <button
              className="px-btn"
              data-testid="desktop-notify"
              onClick={() => void osNotify('Prisms', 'Desktop notifications are working.')}
            >
              Test notification
            </button>
          )}
          <button className="px-btn" data-testid="sign-out" onClick={onSignOut}>
            Sign out
          </button>
        </>
      }
    >
      <ReviewBanner onOpen={() => navigate('/review')} />
      {rejections.length > 0 && (
        <div className="px-error" data-testid="rejection-toast" onClick={onClearRejections}>
          {rejections.map((r) => rejectionMessage(r.reject_code)).join(' ')}
        </div>
      )}
      {/* The page area: stays mounted across screens so a sidebar switch can blur
          the old page out and the new one in (navigate → swapPage). */}
      {/* data-route: the screen actually shown (it lags navRoute during a swap) */}
      <div id={PAGE_SWAP_ID} data-route={route} ref={pageRef}>
        {/* keyed by route: a screen that failed to load does not take the next one down with it */}
        <ScreenBoundary key={route}>{screen}</ScreenBoundary>
      </div>
    </Layout>
    </TaskDetailProvider>
    </TimersProvider>
  );
}

function AuthedApp({
  user,
  sessionChecked,
  onSignOut,
}: {
  user: SessionUser;
  /** The server has said who is signed in (or cannot be asked). Sync waits for it; the screens do not. */
  sessionChecked: boolean;
  onSignOut: () => void;
}) {
  const dbRef = useRef<PowerSyncDatabase | null>(null);
  // the instance `early-open.ts` started opening at load, when this is the remembered account
  if (dbRef.current === null) dbRef.current = dbFor(user.id);
  const db = dbRef.current;
  const clearedRef = useRef(false);

  // §13.2/S9-F1: end this account's LOCAL presence on sign-out — warn if there
  // are unsynced commands (they'd be lost), then wipe the replica + queue and the
  // in-memory read caches so nothing of this account survives for the next login.
  const handleSignOut = useCallback(async () => {
    try {
      const cleared = await clearLocalAccount(db, (pending) =>
        window.confirm(`${pending} unsynced change(s) will be lost. Sign out anyway?`),
      );
      if (!cleared) return; // user cancelled at the unsynced-changes warning
      clearedRef.current = true; // signal the unmount cleanup not to double-disconnect
    } catch (e) {
      console.error('sign-out cleanup failed', e);
    }
    onSignOut();
  }, [db, onSignOut]);

  // §13.1/R20: re-observe the persisted import HLC floor before any command is
  // minted, so a post-import reload still orders new edits after imported state.
  const flooredRef = useRef(false);
  if (!flooredRef.current) {
    flooredRef.current = true;
    loadImportedHlcFloor();
  }

  const [rejections, setRejections] = useState<CommandRejection[]>([]);
  const [route, setRoute] = useState<Route>(resolveBootRoute);
  const [connected, setConnected] = useState(false);

  // e2e-only: expose the PowerSync handle so a Playwright spec can page-eval the
  // LOCAL replica — e.g. the journal lazy-load proof asserts the seeded past-month
  // rows are NOT local until their month is viewed. Guarded to a LOCAL host (dev
  // server AND the CI `vite preview` build both serve on localhost); a real
  // deployment (Tailscale/prod hostname) never exposes it.
  if (import.meta.env.DEV || ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    (window as unknown as { __db?: PowerSyncDatabase }).__db = db;
  }

  useEffect(() => {
    // Not before the server has said who is signed in. This device's queue
    // belongs to `user`; connecting would upload it under whatever session the
    // browser holds, and if that is someone else's, post `user`'s changes into
    // their account. Local reads need no session, so the screens are already up.
    if (!sessionChecked) return;
    let cancelled = false;
    let stopUpload: (() => void) | undefined;
    connectDb(db, (r) => setRejections(r))
      .then((stop) => {
        stopUpload = stop;
        if (cancelled) stop();
        else setConnected(true);
      })
      .catch((e: unknown) => console.error('powersync connect failed', e));
    return () => {
      cancelled = true;
      stopUpload?.();
      // sign-out already ran disconnectAndClear; don't double-disconnect.
      if (!clearedRef.current) void db.disconnect();
    };
  }, [db, sessionChecked]);

  // Moving to another screen blurs the whole page out, gets the next screen
  // ready, and blurs it in (pageSwap.ts). The sidebar follows the click at once
  // (navRoute); the screen itself (route) changes mid-swap. Staying on the same
  // screen (a new hash) does nothing.
  const [navRoute, setNavRoute] = useState<Route>(route);
  const navRef = useRef(route);
  const swapSeq = useRef(0);
  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    const next = (href.split('#')[0] || '/') as Route;
    if (next === navRef.current) return;
    navRef.current = next;
    setNavRoute(next);
    const seq = ++swapSeq.current;
    void swapPage(document.getElementById(PAGE_SWAP_ID), loadScreen(next), () => seq === swapSeq.current, () => setRoute(next));
  }, []);

  // Once the first screen is up and the browser has a quiet moment, fetch the
  // others, so moving between screens never waits on a chunk.
  useEffect(() => whenIdle(preloadAllScreens), []);

  const ctx: CommandContext = useMemo(() => ({ userId: user.id, deviceId: getDeviceId() }), [user.id]);

  return (
    <PowerSyncContext.Provider value={db}>
      {/* §7.14 (Fix A): the shared read layer is mounted ABOVE the router, so its
          9 base subscriptions + FactContext/TreeIndex are created once per session
          and survive navigation (navigate() only swaps the screen below). */}
      <PrismsDataProvider>
        <Shell
          user={user}
          route={route}
          navRoute={navRoute}
          navigate={navigate}
          ctx={ctx}
          connected={connected}
          rejections={rejections}
          onClearRejections={() => setRejections([])}
          onSignOut={() => void handleSignOut()}
        />
      </PrismsDataProvider>
    </PowerSyncContext.Provider>
  );
}

export function App() {
  // The account this browser was last signed in as. Its screens render NOW, from
  // its local database (which `early-open.ts` is already opening), and the server
  // is asked in the background whether that is still who is signed in.
  const [remembered] = useState(readCachedUser);
  const [user, setUser] = useState<SessionUser | null>(remembered);
  // The server has answered (or could not be asked). Until then nothing syncs.
  const [sessionChecked, setSessionChecked] = useState(false);
  const userRef = useRef(user);
  userRef.current = user;
  // Bumped by every sign-in and sign-out, so a boot check that answers AFTER one
  // does not overrule what the user just did.
  const authEpoch = useRef(0);

  useEffect(() => {
    let live = true;
    const epoch = authEpoch.current;
    void checkSession().then((answer) => {
      if (!live || authEpoch.current !== epoch) return;
      const outcome = settleBootSession(remembered, answer);
      // The remembered account's screens may already have filled the in-memory
      // read cache; another account must never see a frame of them (S8-F2).
      const dropRemembered = () => {
        if (!remembered) return;
        forgetDb(remembered.id);
        clearReadCaches();
        clearDrafts();
      };
      switch (outcome.action) {
        case 'keep':
          rememberUser(outcome.user);
          setUser(outcome.user);
          break;
        case 'switch':
          dropRemembered();
          rememberUser(outcome.user);
          setUser(outcome.user);
          break;
        case 'sign-in':
          dropRemembered();
          forgetCachedUser();
          setUser(null);
          break;
        case 'offline':
          // keep the remembered account on screen and sync when the network
          // allows — what an offline load has always done
          break;
      }
      setSessionChecked(true);
    });
    return () => {
      live = false;
    };
  }, [remembered]);

  const handleAuthed = useCallback((u: SessionUser) => {
    authEpoch.current += 1;
    rememberUser(u);
    setUser(u);
    setSessionChecked(true); // signing in IS the server's answer
  }, []);

  const handleSignOut = useCallback(async () => {
    authEpoch.current += 1;
    await signOut();
    forgetCachedUser();
    clearDrafts(); // what was typed belongs to the account that just left
    // its database was just cleared: the next sign-in gets a fresh instance
    if (userRef.current) forgetDb(userRef.current.id);
    setUser(null);
    setSessionChecked(true); // nobody is signed in: known, so the form shows (not "Loading…")
  }, []);

  // Only a browser with nobody remembered waits for the server before it shows anything.
  if (!user && !sessionChecked) return <div className="px-auth" data-testid="loading">Loading…</div>;
  if (!user) return <Login onAuthed={handleAuthed} />;
  // keyed by account: a switch is a fresh app, not this one re-pointed
  return <AuthedApp key={user.id} user={user} sessionChecked={sessionChecked} onSignOut={handleSignOut} />;
}
