import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { redis } from '../../src/lib/redis';
import { rateKeyPrefix, RateLimiterService, slotKey } from '../../src/services/rate-limiter.service';
import { hourIndex, hourWindowLabel, HOUR_MS } from '../../src/utils/time';
import { resetState } from '../helpers';

// A fixed "now" well inside an hour window, so tests never straddle a boundary.
const NOW = Date.UTC(2030, 0, 1, 10, 5, 0);

// Separate connections simulate separate worker processes / hosts.
const extraClients = [new Redis(env.REDIS_URL), new Redis(env.REDIS_URL), new Redis(env.REDIS_URL)];
const limiters = [new RateLimiterService(redis), ...extraClients.map((c) => new RateLimiterService(c))];

afterAll(() => extraClients.forEach((c) => c.disconnect()));

describe('distributed rate limiter (Redis Lua)', () => {
  beforeEach(resetState);

  it('allows the first send immediately and spaces the next by the minimum delay', async () => {
    const [limiter] = limiters as [RateLimiterService];
    const ids = { userId: randomUUID(), senderId: randomUUID() };
    const a = await limiter.reserve({ ...ids, delayMs: 2000, hourlyLimit: 10, now: NOW });
    const b = await limiter.reserve({ ...ids, delayMs: 2000, hourlyLimit: 10, now: NOW });
    expect(a).toMatchObject({ status: 'ALLOWED', slotAt: NOW, count: 1 });
    expect(b).toMatchObject({ status: 'DELAYED', slotAt: NOW + 2000, count: 2 });
  });

  it('concurrent workers get distinct slots at least `delay` apart', async () => {
    const ids = { userId: randomUUID(), senderId: randomUUID() };
    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (limiters[i % limiters.length] as RateLimiterService).reserve({ ...ids, delayMs: 1500, hourlyLimit: 1000, now: NOW }),
      ),
    );
    const slots = decisions.map((d) => d.slotAt).sort((x, y) => x - y);
    expect(new Set(slots).size).toBe(40);
    for (let i = 1; i < slots.length; i++) {
      expect((slots[i] as number) - (slots[i - 1] as number)).toBeGreaterThanOrEqual(1500);
    }
    expect(decisions.filter((d) => d.status === 'ALLOWED')).toHaveLength(1);
  });

  it('concurrent workers can never exceed the hourly limit (Redis-backed counter)', async () => {
    const ids = { userId: randomUUID(), senderId: randomUUID() };
    const limit = 10;
    const decisions = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (limiters[i % limiters.length] as RateLimiterService).reserve({ ...ids, delayMs: 100, hourlyLimit: limit, now: NOW }),
      ),
    );
    const byWindow = new Map<string, number>();
    for (const d of decisions) byWindow.set(d.window, (byWindow.get(d.window) ?? 0) + 1);

    const current = hourWindowLabel(hourIndex(NOW));
    expect(byWindow.get(current)).toBe(limit);
    for (const count of byWindow.values()) expect(count).toBeLessThanOrEqual(limit);
    // 50 reservations at 10/hour → 5 consecutive windows.
    expect(byWindow.size).toBe(5);

    // The counter lives in Redis, keyed by tenant + sender + hour window.
    expect(await redis.get(`${rateKeyPrefix(ids.userId, ids.senderId)}${current}`)).toBe(String(limit));
    expect(await (limiters[0] as RateLimiterService).getCount(ids.userId, ids.senderId, current)).toBe(limit);
    expect(await redis.exists(slotKey(ids.senderId))).toBe(1);
  });

  it('returns RATE_LIMITED with the exact start of the next window once the hour is full', async () => {
    const [limiter] = limiters as [RateLimiterService];
    const ids = { userId: randomUUID(), senderId: randomUUID() };
    for (let i = 0; i < 3; i++) await limiter.reserve({ ...ids, delayMs: 1000, hourlyLimit: 3, now: NOW });

    const limited = await limiter.reserve({ ...ids, delayMs: 1000, hourlyLimit: 3, now: NOW });
    const nextHour = (hourIndex(NOW) + 1) * HOUR_MS;
    expect(limited).toMatchObject({
      status: 'RATE_LIMITED',
      slotAt: nextHour,
      hitWindow: hourWindowLabel(hourIndex(NOW)),
      window: hourWindowLabel(hourIndex(NOW) + 1),
      count: 1,
    });

    // Following jobs queue up behind it in the new window, still spaced by the delay.
    const after = await limiter.reserve({ ...ids, delayMs: 1000, hourlyLimit: 3, now: NOW });
    expect(after.slotAt).toBe(nextHour + 1000);
  });

  it('keeps counters independent per tenant and per sender', async () => {
    const [limiter] = limiters as [RateLimiterService];
    const user = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();
    await limiter.reserve({ userId: user, senderId: s1, delayMs: 0, hourlyLimit: 1, now: NOW });
    const other = await limiter.reserve({ userId: user, senderId: s2, delayMs: 0, hourlyLimit: 1, now: NOW });
    expect(other.status).toBe('ALLOWED');
  });

  it('computes the same UTC hour label in Lua as in TypeScript', async () => {
    const [limiter] = limiters as [RateLimiterService];
    const samples = [
      Date.UTC(2026, 9, 1, 10, 0, 0),
      Date.UTC(2028, 1, 29, 23, 59, 59),
      Date.UTC(2026, 11, 31, 23, 30, 0),
      Date.UTC(2100, 2, 1, 0, 0, 0),
    ];
    for (const now of samples) {
      const d = await limiter.reserve({ userId: randomUUID(), senderId: randomUUID(), delayMs: 0, hourlyLimit: 5, now });
      expect(d.window).toBe(hourWindowLabel(hourIndex(now)));
    }
  });
});
