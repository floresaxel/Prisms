/**
 * Per-launch device id for the §7.4 double-clock-in merge and command HLCs.
 * TODO(s23): persist across launches (expo-secure-store) so the merge rule
 * recognizes the same device after a restart.
 */
import { newId } from '@prisms/ui';

let cached: string | null = null;

export function getDeviceId(): string {
  if (cached === null) cached = `mobile-${newId().slice(0, 18)}`;
  return cached;
}
