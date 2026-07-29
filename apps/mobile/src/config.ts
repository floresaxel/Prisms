/**
 * API + sync endpoints.
 *
 * On a device or emulator `localhost` is the device itself, not your machine,
 * so these have to be overridden to reach a dev stack. Expo inlines
 * `process.env.EXPO_PUBLIC_*` at bundle time, so set them on the Metro process:
 *
 *   Android emulator (10.0.2.2 is its alias for the host loopback):
 *     EXPO_PUBLIC_API_URL=http://10.0.2.2:3001
 *     EXPO_PUBLIC_POWERSYNC_URL=http://10.0.2.2:8081
 *
 *   Physical device: use the host's LAN IP, or a tunnel.
 *
 * The defaults stay on localhost so the desktop/simulator path is unchanged.
 */
export const config = {
  apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001',
  powersyncUrl: process.env.EXPO_PUBLIC_POWERSYNC_URL ?? 'http://localhost:8081',
};
