/**
 * Timezone helpers shared by the topbar clock and Settings: the list of zones
 * the runtime knows, a validity check (an unknown zone makes every `Intl` call
 * throw, so it must never be saved), the device's own zone, and a human reading
 * of a zone — where it is, what it is called, and its offset right now.
 */

/** Fallback when the runtime cannot enumerate zones (older engines). */
const COMMON_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

let cached: string[] | null = null;

/** Every IANA zone the runtime supports, with UTC first. */
export function allTimezones(): string[] {
  if (cached) return cached;
  let zones: string[];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported('timeZone') : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = COMMON_ZONES;
  cached = ['UTC', ...zones.filter((z) => z !== 'UTC')];
  return cached;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone this device is set to, or null if the runtime will not say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** HH:MM (24 h) on the wall clock of `tz`. */
export function clockInZone(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }
}

export interface TimezoneInfo {
  /** "New York, America" — the city, then the area it sits in. */
  place: string;
  /** "Eastern Standard Time" (empty when the runtime has no long name). */
  name: string;
  /** "GMT-5" */
  offset: string;
}

function zonePart(tz: string, at: Date, style: 'long' | 'shortOffset'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function describeTimezone(tz: string, at: Date = new Date()): TimezoneInfo {
  const segs = tz.split('/').map((s) => s.replace(/_/g, ' '));
  const city = segs[segs.length - 1] ?? tz;
  const area = segs.slice(0, -1).reverse().join(', ');
  return {
    place: area ? `${city}, ${area}` : city,
    name: zonePart(tz, at, 'long'),
    offset: zonePart(tz, at, 'shortOffset'),
  };
}

/** One line for a tooltip: where, the zone's name and offset, and the IANA id. */
export function timezoneTitle(tz: string, at: Date = new Date()): string {
  const { place, name, offset } = describeTimezone(tz, at);
  const detail = [name, offset].filter(Boolean).join(', ');
  return `${place}${detail ? ` · ${detail}` : ''} (${tz})`;
}
