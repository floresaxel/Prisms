/**
 * Mobile app shell: gate on a Better Auth session, open + connect the PowerSync
 * RN database, provide it to the shared reactive hooks, and tab between the
 * mobile surfaces (§12.1). A banner surfaces command rejections (the row itself
 * rolls back via sync). Local-notification + push registration is best-effort.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { PowerSyncContext } from '@powersync/react';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { PrismsDataProvider, type CommandContext, type CommandRejection } from '@prisms/ui';

import { getSession, signOut, type SessionUser } from './src/auth';
import { getDeviceId, loadDeviceId } from './src/device';
import { registerForPush, scheduleReminder } from './src/notifications';
import { exportAndShare } from './src/portability';
import { connectDb, getDb } from './src/powersync';
import { Btn, Field, Muted, theme } from './src/ui';
import { Agenda } from './src/screens/Agenda';
import { Dashboard } from './src/screens/Dashboard';
import { Graph } from './src/screens/Graph';
import { Habits } from './src/screens/Habits';
import { Kanban } from './src/screens/Kanban';
import { Login } from './src/screens/Login';
import { Review } from './src/screens/Review';
import { Worklist } from './src/screens/Worklist';

const Tab = createBottomTabNavigator();

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: theme.bg, card: theme.surface, border: theme.border, primary: theme.accent, text: theme.text },
};

function AuthedApp({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const dbRef = useRef<PowerSyncDatabase | null>(null);
  if (dbRef.current === null) dbRef.current = getDb();
  const db = dbRef.current;

  const [rejections, setRejections] = useState<CommandRejection[]>([]);
  const ctx: CommandContext = useMemo(() => ({ userId: user.id, deviceId: getDeviceId() }), [user.id]);

  useEffect(() => {
    let stopUpload: (() => void) | undefined;
    connectDb(db, setRejections)
      .then((stop) => {
        stopUpload = stop;
      })
      .catch(() => undefined);
    void registerForPush();
    return () => {
      stopUpload?.();
      void db.disconnect();
    };
  }, [db]);

  return (
    <PowerSyncContext.Provider value={db}>
      {/* §7.14 (Fix A): shared read layer mounted above the tab navigator, so its
          subscriptions + FactContext survive tab switches (parity with web). */}
      <PrismsDataProvider>
        {rejections.length > 0 && (
          <View style={{ backgroundColor: theme.danger, padding: 8 }}>
            <Text style={{ color: '#fff' }} onPress={() => setRejections([])}>
              Change rejected: {rejections.map((r) => r.reject_code).join(', ')} (reverted)
            </Text>
          </View>
        )}
        <NavigationContainer theme={navTheme}>
          <Tab.Navigator screenOptions={{ headerStyle: { backgroundColor: theme.surface }, headerTintColor: theme.text }}>
            <Tab.Screen name="Worklist">{() => <Worklist ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Agenda">{() => <Agenda ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Kanban">{() => <Kanban ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Habits">{() => <Habits ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Graph">{() => <Graph />}</Tab.Screen>
            <Tab.Screen name="Dashboard">{() => <Dashboard />}</Tab.Screen>
            <Tab.Screen name="Review">{() => <Review ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Account">{() => <Account user={user} onSignOut={onSignOut} />}</Tab.Screen>
          </Tab.Navigator>
        </NavigationContainer>
      </PrismsDataProvider>
    </PowerSyncContext.Provider>
  );
}

function Account({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onExport() {
    setBusy(true);
    setStatus(null);
    try {
      await exportAndShare(passphrase);
      setStatus('Encrypted export shared.');
      setPassphrase('');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: 16, gap: 14 }}>
      <Text style={{ color: theme.text, fontSize: 16 }}>{user.email}</Text>

      {/* §13.1: installed-target export is encrypted by default — a passphrase is required. */}
      <Text style={{ color: theme.text, fontSize: 15, marginTop: 8 }}>Backup &amp; export</Text>
      <Muted>Exports are encrypted on this device — set a passphrase, then share the file.</Muted>
      <Field value={passphrase} onChangeText={setPassphrase} placeholder="export passphrase" secureTextEntry testID="export-passphrase" />
      <Btn title="Export encrypted" variant="primary" testID="export-share" disabled={busy || passphrase.length === 0} onPress={() => void onExport()} />
      {status !== null && <Muted testID="export-status">{status}</Muted>}

      <Text
        style={{ color: theme.accent, marginTop: 8 }}
        testID="test-reminder"
        onPress={() => void scheduleReminder('Prisms reminder', 'This fires even with the network off.', 5)}
      >
        Send a local reminder (5s) — fires offline
      </Text>
      <Text style={{ color: theme.accent }} onPress={onSignOut} testID="sign-out">Sign out</Text>
    </View>
  );
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        await loadDeviceId(); // persist/restore the stable device id before any command context is built
        setUser(await getSession());
      } catch {
        // unauthenticated or offline — fall through to the Login screen
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setUser(null);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {loading ? (
        <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: theme.dim }} testID="loading">Loading…</Text>
        </View>
      ) : user === null ? (
        <Login onAuthed={setUser} />
      ) : (
        <AuthedApp user={user} onSignOut={() => void handleSignOut()} />
      )}
    </SafeAreaProvider>
  );
}
