/**
 * Injected randomness (ARCHITECTURE.md §16): core never calls Math.random
 * or platform crypto.
 *
 * Apps inject a crypto-quality Rng (wrapping crypto.getRandomValues) for ID
 * generation; the seeded Rng here is for deterministic tests and for the
 * optimize-mode scheduler's reproducible local search (§10). It is NOT
 * cryptographically secure.
 */
export interface Rng {
  randomBytes(byteLength: number): Uint8Array;
}

/** Deterministic PRNG (mulberry32). Same seed ⇒ same byte stream, everywhere. */
export function createSeededRng(seed: number): Rng {
  if (!Number.isFinite(seed)) {
    throw new TypeError(`createSeededRng: expected a finite seed, got ${seed}`);
  }
  let state = seed >>> 0;
  const nextWord = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    randomBytes(byteLength: number): Uint8Array {
      if (!Number.isInteger(byteLength) || byteLength < 0) {
        throw new TypeError(
          `randomBytes: expected a non-negative integer length, got ${byteLength}`,
        );
      }
      const out = new Uint8Array(byteLength);
      for (let i = 0; i < byteLength; i += 4) {
        const word = nextWord();
        for (let j = 0; j < 4 && i + j < byteLength; j += 1) {
          out[i + j] = (word >>> (8 * j)) & 0xff;
        }
      }
      return out;
    },
  };
}
