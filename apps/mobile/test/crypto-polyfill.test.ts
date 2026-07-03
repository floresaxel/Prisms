/**
 * S9-F2: the mobile crypto polyfill REGISTRATION path. `crypto-setup.ts` wires the
 * native provider (react-native-quick-crypto), which is untestable off-device — but
 * the merge logic it delegates to (`installWebCrypto`) is pure and pinned here: it
 * must add `subtle` on a Hermes-like runtime (getRandomValues-only crypto), PRESERVE
 * that getRandomValues polyfill, and NEVER clobber a runtime that already has full
 * WebCrypto. Real end-to-end proof (an actual encrypted export) is the device run.
 */
import { describe, expect, it, vi } from 'vitest';

import { installWebCrypto, type CryptoTarget, type WebCryptoProvider } from '../src/crypto-polyfill';

const fakeSubtle = {} as SubtleCrypto;
const passthroughRandom = ((a: ArrayBufferView | null) => a) as Crypto['getRandomValues'];
const provider: WebCryptoProvider = { subtle: fakeSubtle, getRandomValues: passthroughRandom };

describe('installWebCrypto (S9-F2 mobile polyfill)', () => {
  it('adds subtle on a Hermes-like runtime and preserves the getRandomValues polyfill', () => {
    const grv = vi.fn((a: ArrayBufferView | null) => a) as unknown as Crypto['getRandomValues'];
    const target: CryptoTarget = { crypto: { getRandomValues: grv } };

    const installed = installWebCrypto(provider, target);

    expect(installed).toBe(true);
    expect(target.crypto?.subtle).toBe(fakeSubtle); // subtle now available to serializeExport()
    expect(typeof target.crypto?.getRandomValues).toBe('function');
    // the original getRandomValues polyfill is preserved (bound + still callable)
    target.crypto?.getRandomValues?.(new Uint8Array(4));
    expect(grv).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the runtime already has full WebCrypto (does not clobber subtle)', () => {
    const realSubtle = {} as SubtleCrypto;
    const target: CryptoTarget = { crypto: { subtle: realSubtle, getRandomValues: passthroughRandom } };

    const installed = installWebCrypto(provider, target);

    expect(installed).toBe(false);
    expect(target.crypto?.subtle).toBe(realSubtle); // untouched
  });

  it('creates crypto from scratch when the runtime has none, falling back to the provider RNG', () => {
    const target: CryptoTarget = {};
    const installed = installWebCrypto(provider, target);
    expect(installed).toBe(true);
    expect(target.crypto?.subtle).toBe(fakeSubtle);
    expect(typeof target.crypto?.getRandomValues).toBe('function');
  });
});
