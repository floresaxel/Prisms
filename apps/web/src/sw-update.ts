/**
 * Reload once a NEW build's service worker takes this page over.
 *
 * The app shell is served from the service worker's precache, which is what
 * makes a load fast and an offline reload possible — and also what makes the
 * first load after a rebuild show the PREVIOUS build: the page is on screen
 * before the browser has even asked whether `sw.js` changed. The new worker then
 * installs in the background and (skipWaiting + clientsClaim, from
 * `registerType: 'autoUpdate'`) takes control of the open page, which carries on
 * running the old bundle against the new worker's cache until someone reloads.
 * This is that reload.
 *
 * It waits for a quiet moment: half-typed text in a field lives nowhere but the
 * DOM, and a reload would drop it. Everything already committed is in the local
 * database and survives.
 */

export interface ReloadWhenUpdatedOptions {
  /** `navigator.serviceWorker`; absent where service workers are (plain http off localhost, jsdom). */
  serviceWorker?: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener'>;
  reload?: () => void;
  doc?: Document;
  /** How often to look again while the user is mid-edit. */
  retryMs?: number;
}

/** Is there input on screen that only the DOM holds? */
function isEditing(doc: Document): boolean {
  const el = doc.activeElement;
  const typing =
    el instanceof HTMLElement &&
    (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  // An open dialog is a form in progress even while focus rests on one of its buttons.
  return typing || doc.querySelector('[role="dialog"]') !== null;
}

export function reloadWhenUpdated(options: ReloadWhenUpdatedOptions = {}): void {
  const serviceWorker = options.serviceWorker ?? (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker);
  if (!serviceWorker) return;
  const reload = options.reload ?? (() => window.location.reload());
  const doc = options.doc ?? document;
  const retryMs = options.retryMs ?? 2000;

  // With no controller this page came from the network — a first visit, or a
  // hard reload — so the worker about to claim it is serving the same build the
  // page already runs. Only a change of an EXISTING controller is an update.
  let controlled = serviceWorker.controller !== null;
  let pending = false;
  serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (pending) return;
    pending = true;
    const attempt = (): void => {
      if (isEditing(doc)) setTimeout(attempt, retryMs);
      else reload();
    };
    attempt();
  });
}
