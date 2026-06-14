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

export class WebPushAdapter implements PushAdapter {
  readonly kind = 'web' as const;
  constructor(vapid: VapidConfig) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }
  async send(target: PushTarget, notification: PushNotification): Promise<PushSendResult> {
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
