/**
 * Desktop (Tauri v2) glue (§12.3). The desktop app loads this *identical* web
 * bundle inside a Tauri WebView; PowerSync persists via the web SDK
 * (wa-sqlite/OPFS) in that WebView — Tauri's vanilla SQL plugin can't host
 * PowerSync's required SQLite extension, so OPFS-in-WebView is the supported
 * path. The one desktop-only capability wired here is OS notifications via the
 * Tauri notification plugin; in a plain browser these helpers are inert.
 */

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
}

/** True only inside a Tauri WebView. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriWindow);
}

/**
 * Fire an OS notification. Under Tauri → the native notification plugin
 * (requesting permission once); in a browser → the Web Notification API;
 * otherwise a no-op. Best-effort — never throws.
 */
export async function osNotify(title: string, body: string): Promise<void> {
  try {
    if (isDesktop()) {
      const plugin = await import('@tauri-apps/plugin-notification');
      const granted = (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === 'granted';
      if (granted) plugin.sendNotification({ title, body });
      return;
    }
    if (typeof Notification !== 'undefined') {
      const ok = Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted';
      if (ok) new Notification(title, { body });
    }
  } catch {
    // notifications are best-effort (§11): server push is the guarantee.
  }
}
