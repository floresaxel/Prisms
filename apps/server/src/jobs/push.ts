/**
 * Push adapters behind one interface (§11 notify.dispatch, §12.3). Web Push
 * (browser/desktop) and Expo (mobile) implement the same `PushAdapter` so the
 * dispatch job is transport-agnostic; tests use a recording mock adapter.
 */
import { Expo } from 'expo-server-sdk';
import webpush from 'web-push';

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushTarget {
  kind: 'web' | 'expo';
  endpoint: string;
  keys?: { p256dh?: string; auth?: string } | null;
}

export interface PushSendResult {
  ok: boolean;
  error?: string;
}

export interface PushAdapter {
  readonly kind: 'web' | 'expo';
  send(target: PushTarget, notification: PushNotification): Promise<PushSendResult>;
}

export interface PushAdapters {
  web?: PushAdapter;
  expo?: PushAdapter;
}

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * SEC-6/F12: is this Web Push endpoint safe for the server to POST to?
 *
 * `webpush.sendNotification` issues a server-side request to whatever URL the
 * subscription row carries. Push endpoints are browser-vendor URLs, but the
 * value originates on the client, so an attacker-chosen endpoint would turn the
 * job queue into an SSRF probe — and this server sits on a Tailscale network
 * alongside private hosts, with Postgres and PowerSync on localhost.
 *
 * NOTE: no route currently writes `push_subscriptions`, so this is a LATENT
 * vector, not a live one. It is guarded now because the wearables work adds the
 * registration path, and a guard added after the route is a guard added late.
 *
 * Rejects anything that is not HTTPS, and anything resolving to a literal
 * loopback/link-local/private address. Hostname-based DNS rebinding is out of
 * scope for this check — the scheme + literal-IP rules remove the cheap paths.
 */
export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IPv6 loopback / unique-local / link-local. Gate on an actual IPv6 literal
  // (it contains a colon) — matching these prefixes against a DNS name rejects
  // legitimate hosts, e.g. "fcm.googleapis.com" starts with "fc".
  if (host.includes(':')) {
    if (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80')) return false;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return false; // loopback, this-host, private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT — Tailscale's range
  }
  return true;
}

export class WebPushAdapter implements PushAdapter {
  readonly kind = 'web' as const;
  constructor(vapid: VapidConfig) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }
  async send(target: PushTarget, notification: PushNotification): Promise<PushSendResult> {
    if (!isAllowedWebPushEndpoint(target.endpoint)) {
      return { ok: false, error: 'endpoint rejected: not a public https push endpoint (SEC-6/F12)' };
    }
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.keys?.p256dh ?? '', auth: target.keys?.auth ?? '' } },
        JSON.stringify({ title: notification.title, body: notification.body, data: notification.data ?? {} }),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

export class ExpoPushAdapter implements PushAdapter {
  readonly kind = 'expo' as const;
  private readonly expo = new Expo();
  async send(target: PushTarget, notification: PushNotification): Promise<PushSendResult> {
    if (!Expo.isExpoPushToken(target.endpoint)) return { ok: false, error: 'invalid expo push token' };
    try {
      const [ticket] = await this.expo.sendPushNotificationsAsync([
        { to: target.endpoint, title: notification.title, body: notification.body, data: notification.data ?? {} },
      ]);
      return ticket && ticket.status === 'ok' ? { ok: true } : { ok: false, error: ticket?.status ?? 'no ticket' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

/** Build the real adapters from env (VAPID for web; Expo needs no server key). Missing config ⇒ that channel is unavailable. */
export function createPushAdapters(env: NodeJS.ProcessEnv = process.env): PushAdapters {
  const adapters: PushAdapters = { expo: new ExpoPushAdapter() };
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    adapters.web = new WebPushAdapter({
      subject: env.VAPID_SUBJECT ?? 'mailto:admin@prisms.local',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
  }
  return adapters;
}
