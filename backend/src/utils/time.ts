export const HOUR_MS = 3_600_000;

/** Index of the UTC hour containing `epochMs` (hours since the Unix epoch). */
export function hourIndex(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS);
}

/**
 * UTC hour window label, e.g. "2026-10-01T10". Must produce exactly the same
 * string as `hourLabel` in the reserve-send-slot Lua script (see unit test).
 */
export function hourWindowLabel(hour: number): string {
  return new Date(hour * HOUR_MS).toISOString().slice(0, 13);
}

/** "10:00–10:59 UTC" style range for human-readable notifications. */
export function hourWindowRange(label: string): string {
  const start = new Date(`${label}:00:00.000Z`);
  const hh = String(start.getUTCHours()).padStart(2, '0');
  return `${label.slice(0, 10)} ${hh}:00–${hh}:59 UTC`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
