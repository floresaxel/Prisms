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
