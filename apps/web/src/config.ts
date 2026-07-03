/**
 * Web app config. In dev the API + /sync are reverse-proxied by Vite so the
 * browser sees them same-origin (no cross-origin cookie/CSRF dance);
 * PowerSync connects directly to the sync service with the JWT.
 */
export const config = {
  /** Same-origin in dev (Vite proxy); set VITE_API_URL for a split deploy. */
  apiBaseUrl: import.meta.env.VITE_API_URL ?? '',
  // Default matches compose's container port mapping (8080). Machines whose
  // 8080 is taken override BOTH sides: PRISMS_POWERSYNC_PORT for compose and
  // VITE_POWERSYNC_URL here (audit S1-F7/S9-F4).
  powersyncUrl: import.meta.env.VITE_POWERSYNC_URL ?? 'http://localhost:8080',
};
