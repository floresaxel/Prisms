/**
 * Mobile app shell: gate on a Better Auth session, open + connect the PowerSync
 * RN database, provide it to the shared reactive hooks, and tab between the
 * mobile surfaces (§12.1). A banner surfaces command rejections (the row itself
 * rolls back via sync). Local-notification + push registration is best-effort.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { PowerSyncContext } from '@powersync/react';
import type { PowerSyncDatabase } from '@powersync/react-native';
import { clearReadCaches, PrismsDataProvider, type CommandContext, type CommandRejection } from '@prisms/ui';

import { getSession, signOut, type SessionUser } from './src/auth';
import { getDeviceId, loadDeviceId } from './src/device';
import { registerForPush, scheduleReminder } from './src/notifications';
import { exportAndShare } from './src/portability';
import { clearDb, connectDb, getDb } from './src/powersync';
import { Btn, Field, Muted, theme } from './src/ui';
import { Agenda } from './src/screens/Agenda';
import { Dashboard } from './src/screens/Dashboard';
import { Graph } from './src/screens/Graph';
import { Habits } from './src/screens/Habits';
import { Kanban } from './src/screens/Kanban';
import { Login } from './src/screens/Login';
import { Review } from './src/screens/Review';
import { Today } from './src/screens/Today';

const Tab = createBottomTabNavigator();

// T0/D1: rebased on the light `DefaultTheme` — react-navigation styles the tab
// bar, headers and press ripples from this, so it must agree with `theme`.
const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: theme.bg, card: theme.surface, border: theme.border, primary: theme.accent, text: theme.text },
};

function AuthedApp({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const dbRef = useRef<PowerSyncDatabase | null>(null);
  if (dbRef.current === null) dbRef.current = getDb(user.id);
  const db = dbRef.current;
  const clearedRef = useRef(false);

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
      if (!clearedRef.current) void db.disconnect();
    };
  }, [db]);

  // §13.2/S9-F1: end this account's local presence on sign-out (warn on unsynced
  // commands, then wipe the replica + queue + read caches).
  const handleSignOut = useCallback(async () => {
    try {
      const pending = (await db.getAll<{ n: number }>("SELECT count(*) AS n FROM client_commands WHERE status = 'pending'"))[0]?.n ?? 0;
      const proceed =
        pending === 0 ||
        (await new Promise<boolean>((resolve) => {
          Alert.alert('Sign out', `${pending} unsynced change(s) will be lost.`, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Sign out', style: 'destructive', onPress: () => resolve(true) },
          ]);
        }));
      if (!proceed) return;
      clearedRef.current = true;
      await clearDb();
      clearReadCaches();
    } catch {
      // best-effort cleanup; still sign out below.
    }
    onSignOut();
  }, [db, onSignOut]);

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
          <Tab.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: theme.surface },
              headerTintColor: theme.text,
              // react-navigation substitutes a `MissingIcon` placeholder for any
              // tab without a `tabBarIcon` — which drew a tofu square above all
              // eight labels. No icon set is a dependency here (D8 budgeted one
              // new package, and it went to the gradients), so the bar is
              // label-only on purpose: the slot is removed rather than filled
              // with a glyph that means nothing. Real icons need react-native-svg
              // or an icon font — the mock already has the symbol set.
              tabBarIcon: () => null,
              tabBarIconStyle: { display: 'none' },
              tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
            }}
          >
            {/* D2 (completed at T7): Today IS the worklist now — clock in/out
                with the focus review, check-off with the block picker, and
                delete all live on it, for scheduled rows and unscheduled ones
                alike — so the old Worklist tab is gone rather than duplicated. */}
            {/* Today draws its own "Today / <date>" header (the mock has exactly
                one), so the navigator's would be a duplicate. */}
            <Tab.Screen name="Today" options={{ headerShown: false }}>{() => <Today ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Agenda">{() => <Agenda ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Kanban">{() => <Kanban ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Habits">{() => <Habits ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Graph">{() => <Graph />}</Tab.Screen>
            <Tab.Screen name="Dashboard">{() => <Dashboard />}</Tab.Screen>
            <Tab.Screen name="Review">{() => <Review ctx={ctx} />}</Tab.Screen>
            <Tab.Screen name="Account">{() => <Account user={user} onSignOut={() => void handleSignOut()} />}</Tab.Screen>
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
      <StatusBar style="dark" />
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
