/**
 * The topbar's HH:MM clock. It reads the time in the account's timezone (the
 * one every "today" is computed in), says which zone that is when hovered, and
 * opens a small picker when clicked so the zone can be changed from anywhere.
 * Settings holds the same value; both write `timezone.change` (which the journal
 * day log lists). "Use this device's timezone" (on by default) makes the zone follow
 * the device on its own (device-timezone.ts); picking a zone from the list turns it off.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useCommands, useUserSettings, type CommandContext } from '@prisms/ui';

import { allTimezones, clockInZone, describeTimezone, deviceTimezone, isValidTimezone, timezoneTitle } from '../timezones';

const MAX_SHOWN = 40;

export function TimezoneClock({ ctx }: { ctx: CommandContext }) {
  const settings = useUserSettings();
  const commands = useCommands(ctx);
  const tz = settings.timezone;
  const follow = settings.timezoneFollowDevice;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // read every render (the clock ticks each second), so a device that moves shows its new zone
  const device = deviceTimezone();
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '_');
    const all = allTimezones();
    return (q ? all.filter((z) => z.toLowerCase().includes(q)) : all).slice(0, MAX_SHOWN);
  }, [query]);

  async function choose(next: string) {
    if (!isValidTimezone(next)) {
      setError(`“${next}” is not a timezone this browser knows.`);
      return;
    }
    setError('');
    setOpen(false);
    setQuery('');
    // a zone picked by hand is kept: stop following the device first, so it can't snap back
    if (follow) await commands.updateSettings({ timezone_follow_device: false });
    if (next === tz) return;
    // through timezone.change (not settings.update), so the journal day log records it
    await commands.changeTimezone({ from: tz, to: next, cause: 'manual' });
  }

  const current = describeTimezone(tz, now);
  const [hh = '', mm = ''] = clockInZone(tz, now).split(':');
  // Start the cycle at the top of a wall-clock second (a negative delay rewinds it).
  const blinkPhase = useMemo(() => -(Date.now() % 1000), []);

  return (
    <div className="px-menu" ref={wrap}>
      <button
        type="button"
        className="px-now-clock"
        data-testid="now-clock"
        title={`${timezoneTitle(tz, now)} — click to change`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setError('');
        }}
      >
        <span>
          {hh}
          {/* one-second blink, phased to the real second so it lines up with the digits changing */}
          <span className="px-now-colon" data-testid="now-colon" style={{ animationDelay: `${blinkPhase}ms` }}>:</span>
          {mm}
        </span>
      </button>
      {open && (
        <div className="px-menu-pop px-tz-pop" role="dialog" aria-label="Timezone" data-testid="tz-popover">
          <div className="px-tz-cur">
            Showing <b>{current.place}</b>
            <br />
            {[current.name, current.offset].filter(Boolean).join(' · ')} — {tz}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={follow}
            className={`px-switch px-tz-follow${follow ? ' px-switch--on' : ''}`}
            data-testid="tz-follow"
            title={follow ? 'The timezone changes with this device. Pick a zone below to keep one instead.' : 'Follow this device’s timezone wherever it goes'}
            onClick={() => void commands.updateSettings({ timezone_follow_device: !follow })}
          >
            <span className="px-switch-knob" />
            <span className="px-switch-lbl">
              Use this device’s timezone
              {device && <small>{describeTimezone(device, now).place}</small>}
            </span>
          </button>
          <input
            ref={input}
            className="px-input"
            data-testid="tz-search"
            placeholder="Search a city or zone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const exact = query.trim();
                void choose(isValidTimezone(exact) ? exact : (matches[0] ?? exact));
              }
            }}
          />
          {error && <div className="px-tz-err" data-testid="tz-error">{error}</div>}
          <div className="px-tz-list" role="listbox" aria-label="Timezones">
            {matches.map((z) => (
              <button
                key={z}
                type="button"
                role="option"
                aria-selected={z === tz}
                className={`px-tz-opt${z === tz ? ' px-tz-opt--on' : ''}`}
                data-testid={`tz-opt-${z}`}
                onClick={() => void choose(z)}
              >
                <span>{describeTimezone(z, now).place}</span>
                <small>{describeTimezone(z, now).offset}</small>
              </button>
            ))}
            {matches.length === 0 && <div className="px-tz-cur" style={{ padding: '6px 8px' }}>No zone matches “{query}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
