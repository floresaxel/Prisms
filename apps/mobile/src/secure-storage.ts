/**
 * Mobile secure-storage adapter (§13.2, R13; M14): the OS keystore impl of the
 * shared `SecureStorage` port (@prisms/ui), backed by expo-secure-store. Lives in
 * the app (not @prisms/ui) so the native module never leaks into the web bundle.
 *
 * The device id (§7.4) and any local secret material go through this instead of
 * AsyncStorage; the auth SESSION itself is a Better Auth cookie held in the RN
 * native cookie store, never in JS.
 */
import * as SecureStore from 'expo-secure-store';

import type { SecureStorage } from '@prisms/ui';

export const mobileSecureStorage: SecureStorage = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  delete: (key) => SecureStore.deleteItemAsync(key),
};
