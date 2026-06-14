/**
 * weather.poll (§11, cron 30 min): fetch a 7-day forecast per user location
 * and upsert `external_facts(kind='weather_forecast')`. Blocker rules read
 * these rows offline (§9.2); a long-offline client just sees stale/absent
 * facts and degrades to "weather unverified".
 *
 * The HTTP fetch is injected so tests never hit the network; the default
 * adapter calls Open-Meteo (the server tier may do IO, unlike core).
 */
import { randomUUID } from 'node:crypto';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { external_facts, user_settings } from '@prisms/db';

import type { JobClock } from './clock';

export interface DailyForecast {
  /** 'YYYY-MM-DD' (local to the location). */
  date: string;
  high_c: number;
  low_c: number;
  /** precipitation probability as a fraction 0–1 (§9.2 weather.precip_prob). */
  precip_prob: number;
  wind_kph: number;
}

/** Injected forecast source. */
export type ForecastFetcher = (lat: number, lon: number) => Promise<DailyForecast[]>;

const WEATHER_KIND = 'weather_forecast';

/** Open-Meteo adapter (default). 7-day daily forecast, no API key. */
export const openMeteoFetcher: ForecastFetcher = async (lat, lon) => {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&forecast_days=7&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const body = (await res.json()) as {
    daily: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: (number | null)[];
      wind_speed_10m_max: number[];
    };
  };
  const d = body.daily;
  return d.time.map((date, i) => ({
    date,
    high_c: d.temperature_2m_max[i]!,
    low_c: d.temperature_2m_min[i]!,
    precip_prob: (d.precipitation_probability_max[i] ?? 0) / 100,
    wind_kph: d.wind_speed_10m_max[i]!,
  }));
};

/** '<label> ...' → 'label-...': the slug half of the §6.0 weather key. */
export function locationSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'location'
  );
}

export interface WeatherPollResult {
  users: number;
  facts: number;
}

export async function runWeatherPoll(
  db: PostgresJsDatabase,
  clock: JobClock,
  fetchForecast: ForecastFetcher = openMeteoFetcher,
): Promise<WeatherPollResult> {
  const now = new Date(clock.now()).toISOString();
  const rows = await db
    .select({ user_id: user_settings.user_id, weather_location: user_settings.weather_location })
    .from(user_settings);

  let users = 0;
  let facts = 0;
  for (const row of rows) {
    const loc = row.weather_location;
    if (!loc) continue;
    users += 1;
    const slug = locationSlug(loc.label ?? 'location');
    const forecast = await fetchForecast(loc.lat, loc.lon);
    for (const day of forecast) {
      await db
        .insert(external_facts)
        .values({
          id: randomUUID(),
          user_id: row.user_id,
          kind: WEATHER_KIND,
          key: `${slug}/${day.date}`,
          payload: { high_c: day.high_c, low_c: day.low_c, precip_prob: day.precip_prob, wind_kph: day.wind_kph },
          computed_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [external_facts.user_id, external_facts.kind, external_facts.key],
          set: {
            payload: { high_c: day.high_c, low_c: day.low_c, precip_prob: day.precip_prob, wind_kph: day.wind_kph },
            computed_at: now,
            updated_at: now,
            deleted_at: null,
          },
        });
      facts += 1;
    }
  }
  return { users, facts };
}
