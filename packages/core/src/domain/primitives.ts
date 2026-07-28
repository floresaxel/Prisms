/**
 * Primitive value schemas shared by every entity (ARCHITECTURE.md §6, §16).
 *
 * Conventions:
 * - timestamptz columns → ISO 8601 strings carrying 'Z' or an explicit offset.
 * - date columns        → 'YYYY-MM-DD' strings.
 * - uuid columns        → RFC 9562 uuid strings (v7 client-generated, v5 for
 *   automation outputs, §6/§9.4).
 */
import { z } from 'zod';

export const uuidSchema = z.uuid();
export type Uuid = string;

/** timestamptz wire format: ISO 8601 with 'Z' or ±hh:mm offset. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = string;

/** date wire format: 'YYYY-MM-DD'. */
export const isoDateSchema = z.iso.date();
export type IsoDate = string;

/**
 * Device ids are client-generated and embedded inside HLC strings (§7.3),
 * so their alphabet is restricted to keep HLC encoding unambiguous and
 * lexicographically sortable.
 */
export const DEVICE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
export const deviceIdSchema = z
  .string()
  .regex(DEVICE_ID_REGEX, 'device_id must match [A-Za-z0-9_-]{1,64}');
export type DeviceId = string;

/**
 * Encoded hybrid logical clock (§7.3): 12 hex chars (48-bit physical ms),
 * 4 hex chars (16-bit logical counter), then the device id. Zero-padded so
 * plain string comparison equals HLC ordering (property-tested in core).
 */
export const HLC_STRING_REGEX = /^[0-9a-f]{12}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64}$/;
export const hlcStringSchema = z
  .string()
  .regex(HLC_STRING_REGEX, 'expected "<12 hex>-<4 hex>-<device_id>"');
export type HlcString = string;

/** Arbitrary JSON for jsonb columns. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonLiteralSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = Record<string, JsonValue>;

// --- bounded JSON (SEC-3/F6) -------------------------------------------------
// `jsonValueSchema` accepts arbitrarily deep, arbitrarily wide JSON. It backs
// the free-form command fields (node `attributes`, automation `conditions`/
// `actions`, blocker `scope`/`predicate`), so a single 2 MB upload could carry
// pathological input that costs far more to validate, store and re-evaluate than
// it did to send — and those same values are re-walked on every rule evaluation.
// These ceilings are orders of magnitude above real payloads.

export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_NODES = 2_000;
export const MAX_JSON_STRING_LENGTH = 10_000;
export const MAX_JSON_KEY_LENGTH = 200;

/**
 * Describe the first limit `value` breaches, or null when it is within bounds.
 *
 * Deliberately ITERATIVE: a recursive walker would itself overflow the stack on
 * the very input it exists to reject, throwing a RangeError out of `safeParse`
 * (which only traps ZodError) instead of producing a clean rejection.
 */
export function jsonLimitViolation(value: unknown): string | null {
  let nodes = 0;
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 1 }];
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (depth > MAX_JSON_DEPTH) return `nested deeper than ${MAX_JSON_DEPTH} levels`;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return `more than ${MAX_JSON_NODES} values`;

    if (typeof v === 'string') {
      if (v.length > MAX_JSON_STRING_LENGTH) return `a string longer than ${MAX_JSON_STRING_LENGTH} characters`;
      continue;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
      continue;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v)) {
        if (key.length > MAX_JSON_KEY_LENGTH) return `a key longer than ${MAX_JSON_KEY_LENGTH} characters`;
        stack.push({ v: (v as Record<string, unknown>)[key], depth: depth + 1 });
      }
      continue;
    }
    return 'a value that is not valid JSON';
  }
  return null;
}

/**
 * `jsonValueSchema` plus the size/depth ceilings above. The bounds are checked
 * FIRST (see `.pipe()` below): the shape check is Zod's recursive `z.lazy`, so
 * letting it run on unbounded input is the very thing we are guarding against.
 */
const withinJsonLimits = z.unknown().superRefine((value, ctx) => {
  const violation = jsonLimitViolation(value);
  if (violation !== null) {
    ctx.addIssue({ code: 'custom', message: `JSON value exceeds the allowed size: ${violation}` });
  }
});

export const boundedJsonSchema: z.ZodType<JsonValue> = withinJsonLimits.pipe(jsonValueSchema);

/** `jsonObjectSchema` under the same ceilings (node `attributes`). */
export const boundedJsonObjectSchema: z.ZodType<JsonObject> = withinJsonLimits.pipe(jsonObjectSchema);
