export type RateLimitStatus = 'ALLOWED' | 'DELAYED' | 'RATE_LIMITED';

export interface RateLimitDecision {
  /**
   * ALLOWED       – slot reserved at (about) now; send immediately.
   * DELAYED       – slot reserved in the future (minimum-delay spacing); run at slotAt.
   * RATE_LIMITED  – the hourly window was full; slot reserved in the next window
   *                 with capacity; run at slotAt.
   */
  status: RateLimitStatus;
  /** Reserved send time, epoch ms. */
  slotAt: number;
  /** Hour window (UTC, "YYYY-MM-DDTHH") the reserved slot belongs to. */
  window: string;
  /** Hour window that was full when status = RATE_LIMITED. */
  hitWindow: string | null;
  /** Counter value of `window` after this reservation. */
  count: number;
  limit: number;
}

export interface ReserveSlotInput {
  userId: string;
  senderId: string;
  delayMs: number;
  hourlyLimit: number;
  now?: number;
}
