/**
 * One shared once-a-second clock for every live timer readout (the topbar pill
 * and My Day's run cards). Each readout used to run its own `setInterval`, so
 * the two counters ticked at different moments and could disagree by a second.
 * Here there is a single timeout chain, aligned to the wall-clock second, and
 * every subscriber gets the same `now` in the same tick — so the same timer
 * always reads the same time everywhere.
 */
import { useSyncExternalStore } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';

let current: Instant = asEpochMillis(Date.now());
const subscribers = new Set<() => void>();
let handle: ReturnType<typeof setTimeout> | undefined;

function schedule(): void {
  // aim just past the second boundary so `floor(ms / 1000)` has already rolled over
  handle = setTimeout(() => {
    current = asEpochMillis(Date.now());
    for (const notify of subscribers) notify();
    schedule();
  }, 1000 - (Date.now() % 1000) + 5);
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) {
    current = asEpochMillis(Date.now());
    schedule();
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && handle !== undefined) {
      clearTimeout(handle);
      handle = undefined;
    }
  };
}

function getSnapshot(): Instant {
  // nobody is ticking it: don't hand a first render an arbitrarily old time
  if (subscribers.size === 0 && Date.now() - current >= 1000) current = asEpochMillis(Date.now());
  return current;
}

/** The current time, re-rendered once per wall-clock second, shared by all callers. */
export function useSecondClock(): Instant {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
