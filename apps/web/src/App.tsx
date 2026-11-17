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
  useReviewInbox,
  type BreadcrumbSpec,
  type CommandContext,
  type CommandRejection,
  type NavGroupSpec,
  type NavItemSpec,
} from '@prisms/ui';

import { checkSession, signOut, type SessionUser } from './auth';
import { GlobalTimer } from './components/GlobalTimer';
import { ReviewBanner } from './components/ReviewBanner';
import { SyncChip } from './components/SyncChip';
import { isDesktop, osNotify } from './desktop';
import { rejectionMessage } from './format';
import { ScreenBoundary } from './components/ScreenBoundary';
import { clearLocalAccount, connectDb, dbFor, forgetDb } from './powersync';
import {
  Agenda,
  Automations,
  Dashboard,
  Habits,
  Journal,
  MyDay,
  preloadAllScreens,
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

/** Shell composition — mounted inside PrismsDataProvider so it can read the
 *  inbox/review counts for the nav badges. Layout itself stays presentational. */
function Shell({
  user,
  route,
  navigate,
  ctx,
  connected,
  rejections,
  onClearRejections,
  onSignOut,
}: {
  user: SessionUser;
  route: Route;
  navigate: (href: string) => void;
  ctx: CommandContext;
  connected: boolean;
  rejections: CommandRejection[];
  onClearRejections: () => void;
  onSignOut: () => void;
}) {
  const inboxCount = useActivityInbox().length;
  const reviewCount = useReviewInbox().length;

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
    <Layout
      groups={groups}
      foot={foot}
      // the brand mark opens a collapsed sidebar; once open it goes to My Day
      brandHref="/"
      active={route}
      onNavigate={navigate}
      breadcrumb={CRUMBS[route]}
      timer={<GlobalTimer ctx={ctx} />}
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
      {/* keyed by route: a screen that failed to load does not take the next one down with it */}
      <ScreenBoundary key={route}>{screen}</ScreenBoundary>
    </Layout>
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

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setRoute((href.split('#')[0] || '/') as Route);
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
