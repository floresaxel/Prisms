/**
 * Web app config. In dev the API + /sync are reverse-proxied by Vite so the
 * browser sees them same-origin (no cross-origin cookie/CSRF dance);
 * PowerSync connects directly to the sync service with the JWT.
 */
export const config = {
  /** Same-origin in dev (Vite proxy); set VITE_API_URL for a split deploy. */
  apiBaseUrl: import.meta.env.VITE_API_URL ?? '',
  powersyncUrl: import.meta.env.VITE_POWERSYNC_URL ?? 'http://localhost:8081',
};
