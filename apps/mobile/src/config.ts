/**
 * API + sync endpoints. On a device/emulator `localhost` is the device itself,
 * so point these at your host machine's LAN IP (or a tunnel) to reach the dev
 * stack; a real Expo build can override via EXPO_PUBLIC_* env at build time.
 */
export const config = {
  apiBaseUrl: 'http://localhost:3001',
  powersyncUrl: 'http://localhost:8081',
};
