/**
 * ID generation (ARCHITECTURE.md §6, §9.4).
 *
 * - Client-generated row ids are UUIDv7 (time-ordered) — built from the
 *   injected Clock and Rng so core stays pure (§16).
 * - Automation outputs are UUIDv5 under PRISMS_NS: two devices running the
 *   same rule offline produce byte-identical rows (§2 principle 7, §9.4).
 */
import { v5 as uuidV5Lib, v7 as uuidV7Lib } from 'uuid';

import type { Clock } from '../time/clock';
import type { Rng } from '../time/rng';
import type { Uuid } from './primitives';

/**
 * Fixed Prisms namespace: `uuidv5('prisms', DNS_NAMESPACE)` where
 * DNS_NAMESPACE is RFC 4122's 6ba7b810-9dad-11d1-80b4-00c04fd430c8.
 * The derivation is locked by a test; never change this value — it would
 * break automation idempotency across every existing device.
 */
export const PRISMS_NS: Uuid = '0b8114a9-e130-548e-ba1e-2f28358da501';

/** Deterministic name-based id. §9.4: name = `${rule_id}:${trigger_node_id}:${slot}`. */
export function uuidV5(name: string, namespace: Uuid = PRISMS_NS): Uuid {
  return uuidV5Lib(name, namespace);
}

/** Low-level deterministic v7 (exact ms + 16 injected random bytes). */
export function uuidV7From(msecs: number, random: Uint8Array): Uuid {
  if (!Number.isInteger(msecs) || msecs < 0) {
    throw new TypeError(`uuidV7From: msecs must be a non-negative integer, got ${msecs}`);
  }
  if (random.length < 16) {
    throw new TypeError(
      `uuidV7From: need 16 random bytes, got ${random.length}`,
    );
  }
  return uuidV7Lib({ msecs, random });
}

/** Standard client-side row id: time-ordered, random tail. */
export function uuidV7(clock: Clock, rng: Rng): Uuid {
  return uuidV7From(clock.now(), rng.randomBytes(16));
}
