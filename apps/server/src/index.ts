/**
 * @prisms/server — Hono API, Better Auth, command dispatcher, pg-boss jobs.
 *
 * s10: app shell + auth + /health + powersync JWT + settings.update.
 * s11: command dispatcher full catalog. s12: convergence rules.
 * s13: pg-boss workers (weather.poll, aggregates.recompute,
 *      automation.backstop, retention.purge).
 * s14: schedule.optimize, pastdue.scan, layout.precompute, notify.dispatch.
 */
export { createApp, type AppOptions, type PrismsServer } from './app';
export { createDispatcher, type Dispatcher, type UploadResponse, type BackstopJob } from './dispatcher';
export {
  DEV_AUTH_SECRET,
  DEV_POWERSYNC_SECRET,
  loadConfig,
  type PowersyncJwtConfig,
  type ServerConfig,
} from './env';
export { createRateLimiter, type RateLimiter } from './rate-limit';
export { startJobs, QUEUES, type JobsHandle } from './jobs/boss';
export { runWeatherPoll, openMeteoFetcher, type ForecastFetcher, type DailyForecast } from './jobs/weather-poll';
export { runAggregatesRecompute, runAggregatesRecomputeAll } from './jobs/aggregates-recompute';
export { runAutomationBackstop } from './jobs/automation-backstop';
export { runRetentionPurge } from './jobs/retention-purge';
export { systemClock, type JobClock } from './jobs/clock';
export { runScheduleOptimize, runScheduleOptimizeAll, NIGHTLY_OPTIMIZATION } from './jobs/schedule-optimize';
export { runPastdueScan, runPastdueScanAll, PAST_DUE_RESCHEDULE, type PastDueNotification } from './jobs/pastdue-scan';
export { runLayoutPrecompute, type LayoutJob } from './jobs/layout-precompute';
export { runNotifyDispatch, type NotifyJob } from './jobs/notify-dispatch';
export {
  WebPushAdapter,
  ExpoPushAdapter,
  createPushAdapters,
  type PushAdapter,
  type PushAdapters,
  type PushNotification,
  type PushTarget,
} from './jobs/push';
export { loadSchedulerInput, DEFAULT_WINDOWS } from './jobs/scheduler-context';
