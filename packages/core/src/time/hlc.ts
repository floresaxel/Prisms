/**
 * Hybrid logical clock (ARCHITECTURE.md §7.3).
 *
 * 48-bit physical milliseconds + 16-bit logical counter + device id, encoded
 * as `pppppppppppp-cccc-<device_id>` (zero-padded lowercase hex). The
 * encoding is designed so that plain string comparison of encoded HLCs is
 * exactly HLC ordering — same-field conflicts resolve LWW by HLC, and the
 * device id is the final tiebreak, so the order is total (property-tested).
 */
import { domainError } from '../domain/errors';
import {
  DEVICE_ID_REGEX,
  HLC_STRING_REGEX,
  type DeviceId,
  type HlcString,
} from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import type { EpochMillis } from './instant';

export interface Hlc {
  readonly physicalMs: number;
  readonly counter: number;
  readonly deviceId: DeviceId;
}

export const HLC_PHYSICAL_MAX = 2 ** 48 - 1;
export const HLC_COUNTER_MAX = 0xffff;

function assertValidHlc(hlc: Hlc): void {
  if (
    !Number.isInteger(hlc.physicalMs) ||
    hlc.physicalMs < 0 ||
    hlc.physicalMs > HLC_PHYSICAL_MAX
  ) {
    throw new TypeError(`hlc: physicalMs out of 48-bit range: ${hlc.physicalMs}`);
  }
  if (
    !Number.isInteger(hlc.counter) ||
    hlc.counter < 0 ||
    hlc.counter > HLC_COUNTER_MAX
  ) {
    throw new TypeError(`hlc: counter out of 16-bit range: ${hlc.counter}`);
  }
  if (!DEVICE_ID_REGEX.test(hlc.deviceId)) {
    throw new TypeError(`hlc: invalid device id "${hlc.deviceId}"`);
  }
}

export function hlcEncode(hlc: Hlc): HlcString {
  assertValidHlc(hlc);
  const phys = hlc.physicalMs.toString(16).padStart(12, '0');
  const counter = hlc.counter.toString(16).padStart(4, '0');
  return `${phys}-${counter}-${hlc.deviceId}`;
}

export function hlcParse(encoded: string): Result<Hlc> {
  if (!HLC_STRING_REGEX.test(encoded)) {
    return err(
      domainError('E_PARSE', `not a valid HLC string: "${encoded}"`, {
        encoded,
      }),
    );
  }
  // Fixed-width prefix: chars 0-11 = physical hex, 13-16 = counter hex,
  // 18.. = device id (which may itself contain '-').
  return ok({
    physicalMs: Number.parseInt(encoded.slice(0, 12), 16),
    counter: Number.parseInt(encoded.slice(13, 17), 16),
    deviceId: encoded.slice(18),
  });
}

/** Total order: physical ms, then counter, then device id (code-unit compare). */
export function hlcCompare(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

/** Equivalent to `hlcCompare` on parsed values — the encoding makes it so. */
export function hlcCompareEncoded(a: HlcString, b: HlcString): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Advances the local clock for a new local event (the "send" rule).
 *
 * Strictly monotonic even when the wall clock stalls or jumps backwards:
 * physical = max(prev.physical, now); the counter increments while physical
 * stands still and overflows into +1ms.
 */
export function hlcTick(
  prev: Hlc | null,
  now: EpochMillis,
  deviceId: DeviceId,
): Hlc {
  if (!DEVICE_ID_REGEX.test(deviceId)) {
    throw new TypeError(`hlcTick: invalid device id "${deviceId}"`);
  }
  let physicalMs = Math.max(prev?.physicalMs ?? 0, now, 0);
  let counter =
    prev !== null && physicalMs === prev.physicalMs ? prev.counter + 1 : 0;
  if (counter > HLC_COUNTER_MAX) {
    physicalMs += 1;
    counter = 0;
  }
  const next: Hlc = { physicalMs, counter, deviceId };
  assertValidHlc(next);
  return next;
}

/**
 * The HLC "receive" rule (1.3 §7.9a `mergeHlc`): advance the local clock on
 * observing a remote event, so a subsequent local event is causally after both.
 *
 * The merged clock keeps THIS device's id (it is still this device's clock).
 * physical = max(local, remote, now); the counter advances past whichever
 * component(s) tie the new physical time, and overflows into +1ms. The result
 * strictly dominates both `local` and `remote` in (physical, counter) order, so
 * `hlcCompare(result, local) > 0` and `hlcCompare(result, remote) > 0`.
 */
export function mergeHlc(
  local: Hlc | null,
  remote: Hlc,
  now: EpochMillis,
  deviceId: DeviceId,
): Hlc {
  if (!DEVICE_ID_REGEX.test(deviceId)) {
    throw new TypeError(`mergeHlc: invalid device id "${deviceId}"`);
  }
  assertValidHlc(remote);
  const localPhys = local?.physicalMs ?? 0;
  const localCounter = local?.counter ?? 0;
  let physicalMs = Math.max(localPhys, remote.physicalMs, now, 0);
  let counter: number;
  if (physicalMs === localPhys && physicalMs === remote.physicalMs) {
    counter = Math.max(localCounter, remote.counter) + 1;
  } else if (physicalMs === localPhys) {
    counter = localCounter + 1;
  } else if (physicalMs === remote.physicalMs) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  if (counter > HLC_COUNTER_MAX) {
    physicalMs += 1;
    counter = 0;
  }
  const next: Hlc = { physicalMs, counter, deviceId };
  assertValidHlc(next);
  return next;
}
