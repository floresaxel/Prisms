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
import { type CommandContext, type CommandRejection } from '@prisms/ui';

import { getSession, signOut, type SessionUser } from './src/auth';
import { getDeviceId, loadDeviceId } from './src/device';
import { registerForPush, scheduleReminder } from './src/notifications';
import { connectDb, getDb } from './src/powersync';
import { theme } from './src/ui';
import { Agenda } from './src/screens/Agenda';
import { Dashboard } from './src/screens/Dashboard';
import { Graph } from './src/screens/Graph';
import { Habits } from './src/screens/Habits';
import { Kanban } from './src/screens/Kanban';
import { Login } from './src/screens/Login';
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
    void connectDb(db, setRejections);
    void registerForPush();
    return () => { void db.disconnect(); };
  }, [db]);

  return (
    <PowerSyncContext.Provider value={db}>
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
          <Tab.Screen name="Account">{() => <Account user={user} onSignOut={onSignOut} />}</Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </PowerSyncContext.Provider>
  );
}

function Account({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: 16, gap: 14 }}>
      <Text style={{ color: theme.text, fontSize: 16 }}>{user.email}</Text>
      <Text
        style={{ color: theme.accent }}
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
