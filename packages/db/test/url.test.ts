/**
 * The database-URL parse guard (`src/url.ts`).
 *
 * `.env.example` requires POSTGRES_PASSWORD to be URL-safe, because
 * docker-compose.prod.yml interpolates it raw into the connection URI and a `/`
 * ends the authority component. That rule was documentation only: nothing failed
 * until postgres.js threw `Invalid URL` deep in the connection path, which
 * presents as api + powersync crash-looping on a fresh deploy with no mention of
 * the password. These tests pin the guard, and the property that makes its error
 * safe to paste anywhere — it never echoes the URL, which embeds the credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDatabaseUrl } from '../src/url';

/** Shaped like `openssl rand -base64`: the `/` is what breaks the URI. */
const BASE64_ISH_PASSWORD = 'aB3+xY7/zQ1';

describe('resolveDatabaseUrl — URL parse guard', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('rejects a password that ends the authority early (the base64 `/` case)', () => {
    process.env.DATABASE_URL = `postgresql://prisms:${BASE64_ISH_PASSWORD}@postgres:5432/prisms`;
    // names the actual suspect, not just "invalid url"
    expect(() => resolveDatabaseUrl()).toThrow(/POSTGRES_PASSWORD/);
  });

  it('never echoes the URL — the message would leak the password', () => {
    process.env.DATABASE_URL = `postgresql://prisms:${BASE64_ISH_PASSWORD}@postgres:5432/prisms`;
    let message = '';
    try {
      resolveDatabaseUrl();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(BASE64_ISH_PASSWORD);
  });

  it('passes a URL-safe password through untouched', () => {
    // what `openssl rand -hex 32` produces — no authority delimiters
    const url = 'postgresql://prisms:0123456789abcdef0123456789abcdef@postgres:5432/prisms';
    process.env.DATABASE_URL = url;
    expect(resolveDatabaseUrl()).toBe(url);
  });

  it('the compose-default fallback is itself parseable', () => {
    delete process.env.DATABASE_URL;
    const url = resolveDatabaseUrl();
    expect(() => new URL(url)).not.toThrow();
    expect(url).toContain('/prisms');
  });

  it('guards the fallback too — a malformed PRISMS_POSTGRES_PORT cannot slip through', () => {
    delete process.env.DATABASE_URL;
    const savedPort = process.env.PRISMS_POSTGRES_PORT;
    process.env.PRISMS_POSTGRES_PORT = 'not-a-port';
    try {
      expect(() => resolveDatabaseUrl()).toThrow(/does not parse/);
    } finally {
      if (savedPort === undefined) delete process.env.PRISMS_POSTGRES_PORT;
      else process.env.PRISMS_POSTGRES_PORT = savedPort;
    }
  });
});
