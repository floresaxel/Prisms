/**
 * App shell: gate on a Better Auth session, then open the PowerSync database,
 * connect it, and provide it to the reactive hooks. A global toast surfaces
 * server command rejections (the row itself rolls back via sync).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PowerSyncDatabase } from '@powersync/web';
import { PowerSyncContext } from '@powersync/react';
import { getDeviceId, Layout, type CommandContext, type CommandRejection } from '@prisms/ui';

import { getSession, signOut, type SessionUser } from './auth';
import { connectDb, createDb } from './powersync';
import { Agenda } from './screens/Agenda';
import { Dashboard } from './screens/Dashboard';
import { Inbox } from './screens/Inbox';
import { Login } from './screens/Login';
import { Worklist } from './screens/Worklist';

type Route = '/' | '/inbox' | '/agenda' | '/dashboard';

function AuthedApp({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const dbRef = useRef<PowerSyncDatabase | null>(null);
  if (dbRef.current === null) dbRef.current = createDb();
  const db = dbRef.current;

  const [rejections, setRejections] = useState<CommandRejection[]>([]);
  const [route, setRoute] = useState<Route>((window.location.pathname as Route) || '/');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    connectDb(db, (r) => setRejections(r))
      .then(() => !cancelled && setConnected(true))
      .catch((e: unknown) => console.error('powersync connect failed', e));
    return () => {
      cancelled = true;
      void db.disconnect();
    };
  }, [db]);

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setRoute(href as Route);
  }, []);

  const ctx: CommandContext = useMemo(() => ({ userId: user.id, deviceId: getDeviceId() }), [user.id]);

  return (
    <PowerSyncContext.Provider value={db}>
      <Layout
        title="Prisms"
        nav={[
          { label: 'Worklist', href: '/', active: route === '/' },
          { label: 'Inbox', href: '/inbox', active: route === '/inbox' },
          { label: 'Agenda', href: '/agenda', active: route === '/agenda' },
          { label: 'Dashboard', href: '/dashboard', active: route === '/dashboard' },
        ]}
        onNavigate={navigate}
        status={
          <>
            <div data-testid="sync-state">{connected ? 'synced' : 'connecting…'}</div>
            <div>{user.email}</div>
            <button className="px-btn" style={{ marginTop: 8 }} onClick={onSignOut}>Sign out</button>
          </>
        }
      >
        {rejections.length > 0 && (
          <div className="px-error" data-testid="rejection-toast" onClick={() => setRejections([])}>
            Change rejected: {rejections.map((r) => r.reject_code).join(', ')} (reverted)
          </div>
        )}
        {route === '/dashboard' ? (
          <Dashboard ctx={ctx} />
        ) : route === '/inbox' ? (
          <Inbox ctx={ctx} />
        ) : route === '/agenda' ? (
          <Agenda ctx={ctx} />
        ) : (
          <Worklist ctx={ctx} />
        )}
      </Layout>
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
