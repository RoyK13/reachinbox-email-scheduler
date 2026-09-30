/** Pure scheduling helpers (no I/O) — shared by the scheduler service and unit tests. */

/** Requested delay, floored at the configured minimum. */
export function effectiveDelayMs(requested: number, minDelayMs: number): number {
  return Math.max(requested, minDelayMs);
}

/** Requested hourly limit, capped at the configured per-sender maximum. */
export function effectiveHourlyLimit(requested: number, maxPerHour: number): number {
  return Math.min(requested, maxPerHour);
}

/** Deterministic round-robin: recipient i → senders[i % n]. */
export function assignSendersRoundRobin<T>(count: number, senders: readonly T[]): T[] {
  if (senders.length === 0) throw new Error('At least one sender is required');
  return Array.from({ length: count }, (_, i) => senders[i % senders.length] as T);
}

/**
 * Initial scheduledAt hint per recipient. Recipients are spread round-robin
 * over n senders, so the k-th email of a given sender is k = floor(i / n) and
 * lands at start + k * delay. The real send time is decided by the Redis rate
 * limiter at execution time; the DB row is updated if it moves.
 */
export function initialScheduleTimes(start: Date, count: number, senderCount: number, delayMs: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + Math.floor(i / senderCount) * delayMs));
}
