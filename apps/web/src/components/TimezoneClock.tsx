/**
 * The topbar's HH:MM clock. It reads the time in the account's timezone (the
 * one every "today" is computed in), says which zone that is when hovered, and
 * opens a small picker when clicked so the zone can be changed from anywhere.
 * Settings holds the same value; both write `settings.update`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useCommands, useUserSettings, type CommandContext } from '@prisms/ui';

import { allTimezones, clockInZone, describeTimezone, deviceTimezone, isValidTimezone, timezoneTitle } from '../timezones';

const MAX_SHOWN = 40;

export function TimezoneClock({ ctx }: { ctx: CommandContext }) {
  const settings = useUserSettings();
  const commands = useCommands(ctx);
  const tz = settings.timezone;

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

  const device = useMemo(() => deviceTimezone(), []);
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
    if (next === tz) return;
    if (settings.hasRow) await commands.updateSettings({ timezone: next });
    else await commands.insertSettings({ day_reset_hour: settings.dayResetHour, timezone: next });
  }

  const current = describeTimezone(tz, now);

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
        <span>{clockInZone(tz, now)}</span>
      </button>
      {open && (
        <div className="px-menu-pop px-tz-pop" role="dialog" aria-label="Timezone" data-testid="tz-popover">
          <div className="px-tz-cur">
            Showing <b>{current.place}</b>
            <br />
            {[current.name, current.offset].filter(Boolean).join(' · ')} — {tz}
          </div>
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
            {device && device !== tz && (
              <button type="button" className="px-tz-opt" data-testid="tz-device" onClick={() => void choose(device)}>
                <span>Use this device’s timezone</span>
                <small>{describeTimezone(device, now).place}</small>
              </button>
            )}
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
