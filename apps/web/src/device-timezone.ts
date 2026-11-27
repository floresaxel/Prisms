/**
 * "Use this device's timezone" — ON by default (`user_settings.timezone_follow_device`):
 * the account's zone follows the DEVICE through `timezone.change`, which also
 * records each change for the journal day log. Turn it off (pick a zone by hand,
 * in the topbar clock or Settings) and the account keeps that zone wherever the
 * device goes.
 *
 * While it is on, a device pushes its zone when it is a zone THIS device has not
 * pushed before: the first time it is seen (a new device, or the option just
 * turned back on) and whenever the device moves. It does not push the same zone
 * again, so two signed-in devices in different zones don't fight over the account
 * — the latest to open or move wins, once. This device's last zone is kept per
 * account in localStorage.
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
  | { kind: 'none' } // nothing usable to read, or nothing to do
  | { kind: 'remember'; device: string } // note this device's zone; the account stays as it is
  | { kind: 'follow'; device: string; from: string }; // move the account to the device's zone

/**
 * Pure decision: the device's zone now, the zone this device last saw, the
 * account's zone, and whether the account follows the device → what to do.
 */
export function decideDeviceTimezone(device: string | null, lastSeen: string | null, account: string, follow: boolean): DeviceTimezoneStep {
  if (!device || !isValidTimezone(device)) return { kind: 'none' };
  // a zone this device has already had (and pushed, if following): leave the account be
  if (device === lastSeen) return { kind: 'none' };
  if (!follow || device === account) return { kind: 'remember', device };
  return { kind: 'follow', device, from: account };
}

function readLastSeen(userId: string): string | null {
  try {
    return localStorage.getItem(keyFor(userId));
  } catch {
    return null;
  }
}

function writeLastSeen(userId: string, zone: string | null): void {
  try {
    if (zone === null) localStorage.removeItem(keyFor(userId));
    else localStorage.setItem(keyFor(userId), zone);
  } catch {
    // private mode / quota: the next check simply sees a new zone again
  }
}

/** Keep the account's timezone on the device's while "Use this device's timezone" is on. Mount once. */
export function useFollowDeviceTimezone(ctx: CommandContext): void {
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const { timezone, timezoneFollowDevice } = useUserSettings();
  // read through refs, so the listeners below see the CURRENT settings
  const account = useRef(timezone);
  account.current = timezone;
  const follow = useRef(timezoneFollowDevice);
  follow.current = timezoneFollowDevice;
  const send = useRef(commands.changeTimezone);
  send.current = commands.changeTimezone;
  // the option as last seen by this hook: turning it back ON makes the device's
  // zone "new" again, so the account snaps to it straight away
  const wasFollowing = useRef<boolean | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (wasFollowing.current === false && timezoneFollowDevice) writeLastSeen(ctx.userId, null);
    wasFollowing.current = timezoneFollowDevice;
    const check = () => {
      const step = decideDeviceTimezone(deviceTimezone(), readLastSeen(ctx.userId), account.current, follow.current);
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
  }, [hydrated, ctx.userId, timezoneFollowDevice]);
}
