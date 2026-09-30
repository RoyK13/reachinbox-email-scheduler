import type { Redis } from 'ioredis';
import { RESERVE_SEND_SLOT_LUA } from '../lib/lua/reserve-send-slot';
import type { RateLimitDecision, RateLimitStatus, ReserveSlotInput } from '../types/rate-limit';

/** A reserved slot this close to "now" is sent immediately (tiny in-process wait). */
export const SLOT_TOLERANCE_MS = 100;
/** How far ahead (in hour windows) the limiter searches for capacity: 30 days. */
const MAX_HOURS_AHEAD = 24 * 30;

type ReserveReply = [string, string, string, string, number];

interface RedisWithReserve extends Redis {
  reserveSendSlot(
    slotKey: string,
    ratePrefix: string,
    now: number,
    delayMs: number,
    limit: number,
    maxAhead: number,
    tolerance: number,
  ): Promise<ReserveReply>;
}

export function slotKey(senderId: string): string {
  return `email-slot:${senderId}`;
}

export function rateKeyPrefix(userId: string, senderId: string): string {
  return `email-rate:${userId}:${senderId}:`;
}

/**
 * Distributed per-sender throttle + hourly limit. All state lives in Redis and
 * every decision is a single atomic Lua call, so it is safe across worker
 * concurrency, multiple worker processes and multiple hosts.
 */
export class RateLimiterService {
  private readonly client: RedisWithReserve;

  constructor(redis: Redis) {
    if (!('reserveSendSlot' in redis)) {
      redis.defineCommand('reserveSendSlot', { numberOfKeys: 2, lua: RESERVE_SEND_SLOT_LUA });
    }
    this.client = redis as RedisWithReserve;
  }

  async reserve(input: ReserveSlotInput): Promise<RateLimitDecision> {
    const now = input.now ?? Date.now();
    const [status, slotAt, window, hitWindow, count] = await this.client.reserveSendSlot(
      slotKey(input.senderId),
      rateKeyPrefix(input.userId, input.senderId),
      now,
      Math.max(0, Math.floor(input.delayMs)),
      Math.max(1, Math.floor(input.hourlyLimit)),
      MAX_HOURS_AHEAD,
      SLOT_TOLERANCE_MS,
    );
    return {
      status: status as RateLimitStatus,
      slotAt: Number(slotAt),
      window,
      hitWindow: hitWindow === '' ? null : hitWindow,
      count: Number(count),
      limit: input.hourlyLimit,
    };
  }

  /** Current reservation count for a tenant/sender/hour window (for UI and tests). */
  async getCount(userId: string, senderId: string, window: string): Promise<number> {
    const value = await this.client.get(`${rateKeyPrefix(userId, senderId)}${window}`);
    return value ? Number(value) : 0;
  }
}
