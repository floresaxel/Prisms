/**
 * Local-database-encryption adapter port (1.3 §13.2/§13.3, R13). Provider-neutral,
 * OUTSIDE `packages/core`. Desktop/mobile at-rest DB encryption (SQLCipher, OS
 * keychain-derived keys) is an EXPLICIT adapter choice so it can be added without
 * touching core or the PowerSync open path.
 *
 * The port yields the key material a SQLite driver opens the local DB with (or
 * null = plaintext). No core change: the app wires the adapter where it opens the
 * database (M14 supplies the SQLCipher-backed impls; web is plaintext OPFS).
 */

export interface DbEncryptionAdapter {
  /** Whether at-rest encryption is active for this target. */
  readonly enabled: boolean;
  /**
   * The passphrase/key the SQLite driver opens the DB with, or null for
   * plaintext. Async because a real keystore lookup is.
   */
  key(): Promise<string | null>;
}

/**
 * Web/dev default: plaintext. **Documented limitation (§13.2):** browser OPFS is
 * NOT encryptable from JS — the web replica is unencrypted at rest, so treat the
 * device as the trust boundary. Installed targets (M14) supply a real adapter.
 */
export const noopDbEncryption: DbEncryptionAdapter = {
  enabled: false,
  key: () => Promise.resolve(null),
};

/** A fixed-key adapter — installed-target impls (M14) and tests derive the key from a keystore. */
export function createStaticDbEncryption(key: string): DbEncryptionAdapter {
  return { enabled: true, key: () => Promise.resolve(key) };
}
