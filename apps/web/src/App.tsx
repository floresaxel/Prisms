/**
 * App shell: gate on a Better Auth session, then open the PowerSync database,
 * connect it, and provide it to the reactive hooks. A global toast surfaces
 * server command rejections (the row itself rolls back via sync).
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

import { getSession, signOut, type SessionUser } from './auth';
import { GlobalTimer } from './components/GlobalTimer';
import { ReviewBanner } from './components/ReviewBanner';
import { isDesktop, osNotify } from './desktop';
import { rejectionMessage } from './format';
import { clearLocalAccount, connectDb, createDb } from './powersync';
import { Agenda } from './screens/Agenda';
import { Automations } from './screens/Automations';
import { Dashboard } from './screens/Dashboard';
import { Habits } from './screens/Habits';
import { Login } from './screens/Login';
import { MyDay } from './screens/MyDay';
import { Projects } from './screens/Projects';
import { Review } from './screens/Review';
import { Settings } from './screens/Settings';
import { Tasks } from './screens/Tasks';

type Route =
  | '/'
  | '/tasks'
  | '/agenda'
  | '/habits'
  | '/projects'
  | '/dashboard'
  | '/automations'
  | '/review'
  | '/settings';

const ROUTES = new Set<Route>(['/', '/tasks', '/agenda', '/habits', '/projects', '/dashboard', '/automations', '/review', '/settings']);

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

const CRUMBS: Record<Route, BreadcrumbSpec> = {
  '/': { section: 'My work', page: 'My Day' },
  '/tasks': { section: 'My work', page: 'Tasks' },
  '/agenda': { section: 'My work', page: 'Agenda' },
  '/habits': { section: 'My work', page: 'Habits & Skills' },
  '/projects': { section: 'Plan', page: 'Projects' },
  '/dashboard': { section: 'Plan', page: 'Dashboard' },
  '/automations': { section: 'Automate', page: 'Automations' },
  '/review': { section: 'My work', page: 'Review' },
  '/settings': { section: 'Workspace', page: 'Settings' },
};

/** Boot route: apply an old→new redirect (replaceState) if the path is legacy. */
function resolveBootRoute(): Route {
  const path = window.location.pathname;
  const redirect = REDIRECTS[path];
  if (redirect) {
    window.history.replaceState({}, '', redirect);
    return redirect.split('#')[0] as Route;
  }
  return ROUTES.has(path as Route) ? (path as Route) : '/';
}

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
      ],
    },
    {
      label: 'Plan',
      items: [
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
      active={route}
      onNavigate={navigate}
      breadcrumb={CRUMBS[route]}
      timer={<GlobalTimer ctx={ctx} />}
      user={{ name: user.name, email: user.email }}
      sync={
        <div className={`px-sync-chip${connected ? '' : ' px-sync-chip--connecting'}`} data-testid="sync-state">
          <span className="px-dot" />
          {connected ? 'synced' : 'connecting…'}
        </div>
      }
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
      {screen}
    </Layout>
  );
}

function AuthedApp({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const dbRef = useRef<PowerSyncDatabase | null>(null);
  if (dbRef.current === null) dbRef.current = createDb(user.id);
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
  }, [db]);

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setRoute((href.split('#')[0] || '/') as Route);
  }, []);

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

const USER_CACHE = 'prisms.user';

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession()
      .then((u) => {
        // online: server is the source of truth for the session.
        if (u) localStorage.setItem(USER_CACHE, JSON.stringify(u));
        else localStorage.removeItem(USER_CACHE);
        setUser(u);
      })
      .catch(() => {
        // offline: fall back to the last known session so local data still renders.
        const cached = localStorage.getItem(USER_CACHE);
        if (cached) setUser(JSON.parse(cached) as SessionUser);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleAuthed = useCallback((u: SessionUser) => {
    localStorage.setItem(USER_CACHE, JSON.stringify(u));
    setUser(u);
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOut();
    localStorage.removeItem(USER_CACHE);
    setUser(null);
  }, []);

  if (loading) return <div className="px-auth" data-testid="loading">Loading…</div>;
  if (!user) return <Login onAuthed={handleAuthed} />;
  return <AuthedApp user={user} onSignOut={handleSignOut} />;
}
