/**
 * Local + push notifications (§11 dual-path, §12.3): local reminders fire even
 * offline (past-due, streak-at-risk, daily target); push registration lets the
 * server's notify.dispatch reach a closed app. Best-effort — server jobs are
 * the guarantee, never these.
 */
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/** Schedule a local reminder; `inSeconds <= 0` fires immediately. Works offline. */
export async function scheduleReminder(title: string, body: string, inSeconds: number): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger:
      inSeconds <= 0
        ? null
        : { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: inSeconds },
  });
}

/** Register for Expo push so the server can deliver to a closed app. */
export async function registerForPush(): Promise<string | null> {
  if (!(await ensurePermission())) return null;
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch {
    return null; // no projectId / not a dev build — best-effort
  }
}
