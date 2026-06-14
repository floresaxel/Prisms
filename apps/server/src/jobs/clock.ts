/**
 * Injected clock for jobs (the server tier is allowed a wall clock, but jobs
 * take it as a parameter so tests are deterministic — §16 spirit, DoD
 * "clock-injected tests per job").
 */
export interface JobClock {
  now(): number;
}

export const systemClock: JobClock = { now: () => Date.now() };
