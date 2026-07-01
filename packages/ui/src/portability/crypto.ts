/**
 * Passphrase encryption for portable exports (1.3 §13.1, V12). WebCrypto only
 * (browser + Node ≥20 global `crypto.subtle`) — no Node Buffer, so it runs in the
 * web bundle and the mobile/desktop JS runtimes unchanged.
 *
 * AES-256-GCM (authenticated) with a PBKDF2-SHA-256-derived key; a random salt +
 * IV per export. The envelope is a versioned JSON object so a future KDF/cipher
 * change is an explicit migration, never a silent guess (R11). A wrong passphrase
 * fails GCM authentication → `decryptExport` throws (never returns garbage).
 *
 * On installed targets export defaults to encrypted (§13.1); on web it is opt-in.
 */

export const ENCRYPTED_EXPORT_FORMAT = 'prisms-export-enc';
export const ENCRYPTED_EXPORT_VERSION = 1;
const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 PBKDF2-SHA256 floor
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** The self-describing encrypted envelope written to disk (all binary fields base64). */
export interface EncryptedExport {
  format: typeof ENCRYPTED_EXPORT_FORMAT;
  version: number;
  kdf: 'PBKDF2-SHA256';
  cipher: 'AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto SubtleCrypto is unavailable in this runtime');
  return c.subtle;
};

const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

/** Uint8Array → base64 (chunked; no `...spread`, so it is safe for large exports). */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt an export's JSON text under a passphrase. Rejects an empty passphrase. */
export async function encryptExport(plaintext: string, passphrase: string): Promise<EncryptedExport> {
  if (passphrase.length === 0) throw new Error('a passphrase is required to encrypt an export');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return {
    format: ENCRYPTED_EXPORT_FORMAT,
    version: ENCRYPTED_EXPORT_VERSION,
    kdf: 'PBKDF2-SHA256',
    cipher: 'AES-GCM',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ct)),
  };
}

/** True when a parsed object is an encrypted-export envelope (vs. a plaintext manifest). */
export function isEncryptedExport(value: unknown): value is EncryptedExport {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === ENCRYPTED_EXPORT_FORMAT
  );
}

/** Decrypt an envelope. Wrong passphrase / tampered ciphertext → throws (GCM auth). */
export async function decryptExport(env: EncryptedExport, passphrase: string): Promise<string> {
  if (!isEncryptedExport(env)) throw new Error('not a prisms encrypted export');
  if (env.version > ENCRYPTED_EXPORT_VERSION) {
    throw new Error(`encrypted export version ${env.version} is newer than this app supports (${ENCRYPTED_EXPORT_VERSION})`);
  }
  const key = await deriveKey(passphrase, fromBase64(env.salt), env.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(env.iv) as BufferSource }, key, fromBase64(env.ciphertext) as BufferSource);
  } catch {
    throw new Error('decryption failed — wrong passphrase or corrupted file');
  }
  return new TextDecoder().decode(plain);
}
