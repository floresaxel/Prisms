/**
 * S9-F2: Expo/Hermes provides `crypto.getRandomValues` (via the
 * react-native-get-random-values polyfill) but NOT `crypto.subtle`, so the shared
 * @prisms/ui export encryption — which calls `globalThis.crypto.subtle` — throws
 * on mobile ("WebCrypto SubtleCrypto is unavailable in this runtime"), making the
 * encrypted-by-default export (V12/DoF 21) 100% unavailable rather than degraded.
 *
 * This module holds the PURE installer that grafts a WebCrypto `subtle` onto
 * `globalThis.crypto` without clobbering an existing full implementation or the
 * getRandomValues polyfill. It imports nothing native, so it runs under
 * vitest/node — the native SubtleCrypto provider (react-native-quick-crypto) is
 * imported and passed in by `crypto-setup.ts`.
 */

/** The minimal WebCrypto surface we need from a provider (react-native-quick-crypto). */
export interface WebCryptoProvider {
  subtle: SubtleCrypto;
  getRandomValues?: Crypto['getRandomValues'];
}

/** A `globalThis`-like object we install onto (parameterized so it is testable). */
export interface CryptoTarget {
  crypto?: Partial<Crypto>;
}

/**
 * Ensure `target.crypto.subtle` exists, sourcing it from `provider`. Preserves an
 * already-present `getRandomValues` (the react-native-get-random-values polyfill)
 * and is a no-op when the runtime already exposes a full `subtle` (browser, Node,
 * or a future RN that ships WebCrypto) — so it is safe to call unconditionally.
 *
 * @returns true if it installed `subtle`, false if the runtime already had one.
 */
export function installWebCrypto(provider: WebCryptoProvider, target: CryptoTarget = globalThis): boolean {
  const existing = target.crypto;
  if (existing?.subtle) return false; // full WebCrypto already present — leave it untouched.
  const merged = {
    ...(existing ?? {}),
    subtle: provider.subtle,
    getRandomValues: existing?.getRandomValues?.bind(existing) ?? provider.getRandomValues?.bind(provider),
  } as Crypto;
  Object.defineProperty(target, 'crypto', { value: merged, configurable: true, writable: true });
  return true;
}
