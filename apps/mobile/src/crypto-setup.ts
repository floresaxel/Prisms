/**
 * S9-F2 mobile crypto bootstrap. Imported for its side effect from `index.ts`
 * BEFORE the app mounts (and thus before any portability/export call), so
 * `globalThis.crypto.subtle` exists on Hermes — where it otherwise does not.
 *
 * react-native-quick-crypto is a NATIVE (Nitro) WebCrypto implementation, so
 * PBKDF2/AES-GCM stay fast (a pure-JS 600k-iteration PBKDF2 on Hermes would take
 * many seconds). This file is the native seam; the merge logic it delegates to
 * lives in `crypto-polyfill.ts` (which is unit-tested without the native module).
 */
import { install as installQuickCrypto, subtle } from 'react-native-quick-crypto';

import { installWebCrypto } from './crypto-polyfill';

// Registers quick-crypto's global polyfills (Buffer/process and, version
// depending, global.crypto). Idempotent enough to call once at startup.
installQuickCrypto();
// Guarantee crypto.subtle regardless of what install() polyfilled, while keeping
// the getRandomValues polyfill react-native-get-random-values installed first.
installWebCrypto({ subtle: subtle as unknown as SubtleCrypto });
