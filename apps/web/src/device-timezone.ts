/**
 * The account's timezone follows the DEVICE: when the device's own zone changes
 * (you flew somewhere, or changed it in the OS), the account moves to it through
 * `timezone.change` — which also records the change for the journal day log.
 *
 * Only a CHANGE seen by this device moves anything. The first zone a device
 * reports is just remembered (per account, in localStorage), so signing in on a
 * machine set to another zone never rewrites the account's zone by itself, and a
 * zone the user picked by hand stays until the device actually moves again.
 *
 * Checked when the app opens (once local data has loaded, so "from" is the real
 * account zone), whenever the window regains focus or becomes visible, and every
 * `DEVICE_TZ_POLL_MS` while it is open — browsers pick up an OS zone change live.
 *
 * Clocked time is unaffected: sessions are stored as instants, so a timer that is
 * running when the zone changes keeps counting the same seconds; only the clock
 * times shown (and which day a moment falls on) move to the new zone.
 */
import { useEffect, useRef } from 'react';

import { useCommands, useIsHydrated, useUserSettings, type CommandContext } from '@prisms/ui';

import { deviceTimezone, isValidTimezone } from './timezones';

export const DEVICE_TZ_POLL_MS = 15_000;

const keyFor = (userId: string) => `prisms.device-tz.${userId}`;

/** What one check decided. */
export type DeviceTimezoneStep =
  | { kind: 'none' } // nothing usable to read, or nothing changed
  | { kind: 'baseline'; device: string } // first zone this device reported: remember it
  | { kind: 'moved'; device: string } // the device moved, the account is already there
  | { kind: 'follow'; device: string; from: string }; // the device moved: move the account

/**
 * Pure decision: the device's zone now, the zone last seen on this device, and
 * the account's zone → what to do.
 */
export function decideDeviceTimezone(device: string | null, lastSeen: string | null, account: string): DeviceTimezoneStep {
  if (!device || !isValidTimezone(device)) return { kind: 'none' };
  if (lastSeen === null) return { kind: 'baseline', device };
  if (device === lastSeen) return { kind: 'none' };
  if (device === account) return { kind: 'moved', device };
  return { kind: 'follow', device, from: account };
}

function readLastSeen(userId: string): string | null {
  try {
    return localStorage.getItem(keyFor(userId));
  } catch {
    return null;
  }
}

function writeLastSeen(userId: string, zone: string): void {
  try {
    localStorage.setItem(keyFor(userId), zone);
  } catch {
    // private mode / quota: the next check simply sees a change again
  }
}

/** Keep the account's timezone on the device's. Mount once, in the signed-in app. */
export function useFollowDeviceTimezone(ctx: CommandContext): void {
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const { timezone } = useUserSettings();
  // read through a ref, so the listeners below see the CURRENT account zone
  const account = useRef(timezone);
  account.current = timezone;
  const send = useRef(commands.changeTimezone);
  send.current = commands.changeTimezone;

  useEffect(() => {
    if (!hydrated) return;
    const check = () => {
      const step = decideDeviceTimezone(deviceTimezone(), readLastSeen(ctx.userId), account.current);
      if (step.kind === 'none') return;
      writeLastSeen(ctx.userId, step.device); // first, so another tab or check never sends it twice
      if (step.kind === 'follow') void send.current({ from: step.from, to: step.device, cause: 'device' });
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(check, DEVICE_TZ_POLL_MS);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(poll);
    };
  }, [hydrated, ctx.userId]);
}
