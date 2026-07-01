/**
 * M14 — lazy Tier 2 (`history`) stream subscription (§7.3). Uses a mock db that
 * satisfies the `StreamSubscriber` port so the helper is verified without a live
 * PowerSync service (the real subscription is exercised by the platform e2e/CI).
 */
import { describe, expect, it, vi } from 'vitest';

import { HISTORY_STREAM, subscribeHistory, type StreamSubscriber } from '@prisms/ui';

describe('subscribeHistory (§7.3 Tier 2 lazy)', () => {
  it('subscribes the history stream with a TTL + low priority and returns an unsubscribe fn', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn().mockResolvedValue({ unsubscribe, waitForFirstSync: vi.fn() });
    const db: StreamSubscriber = { syncStream: vi.fn().mockReturnValue({ subscribe }) };

    const stop = await subscribeHistory(db, { ttlSeconds: 120 });

    expect(db.syncStream).toHaveBeenCalledWith(HISTORY_STREAM);
    expect(subscribe).toHaveBeenCalledWith({ ttl: 120, priority: 3 });
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('defaults the TTL to an hour and can await the first sync', async () => {
    const waitForFirstSync = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockResolvedValue({ unsubscribe: vi.fn(), waitForFirstSync });
    const db: StreamSubscriber = { syncStream: () => ({ subscribe }) };

    await subscribeHistory(db, { waitForFirstSync: true });

    expect(subscribe).toHaveBeenCalledWith({ ttl: 3600, priority: 3 });
    expect(waitForFirstSync).toHaveBeenCalledTimes(1);
  });
});
