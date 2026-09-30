import { describe, expect, it } from 'vitest';
import {
  assignSendersRoundRobin,
  effectiveDelayMs,
  effectiveHourlyLimit,
  initialScheduleTimes,
} from '../../src/utils/scheduling';
import { hourIndex, hourWindowLabel, hourWindowRange, HOUR_MS } from '../../src/utils/time';

describe('round-robin sender assignment', () => {
  it('alternates senders deterministically', () => {
    expect(assignSendersRoundRobin(5, ['A', 'B'])).toEqual(['A', 'B', 'A', 'B', 'A']);
  });

  it('uses the single sender for everything', () => {
    expect(assignSendersRoundRobin(3, ['A'])).toEqual(['A', 'A', 'A']);
  });

  it('rejects an empty sender list', () => {
    expect(() => assignSendersRoundRobin(1, [])).toThrow();
  });
});

describe('initial schedule times', () => {
  const start = new Date('2026-10-01T10:00:00.000Z');

  it('spaces each sender’s emails by the delay', () => {
    const times = initialScheduleTimes(start, 5, 2, 2000).map((d) => d.toISOString());
    expect(times).toEqual([
      '2026-10-01T10:00:00.000Z', // sender A #0
      '2026-10-01T10:00:00.000Z', // sender B #0
      '2026-10-01T10:00:02.000Z', // sender A #1
      '2026-10-01T10:00:02.000Z', // sender B #1
      '2026-10-01T10:00:04.000Z', // sender A #2
    ]);
  });

  it('is non-decreasing (preserves recipient order)', () => {
    const times = initialScheduleTimes(start, 1000, 3, 1500).map((d) => d.getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] as number);
  });
});

describe('effective limits', () => {
  it('floors the delay at the configured minimum', () => {
    expect(effectiveDelayMs(500, 2000)).toBe(2000);
    expect(effectiveDelayMs(5000, 2000)).toBe(5000);
  });

  it('caps the hourly limit at the configured maximum', () => {
    expect(effectiveHourlyLimit(1000, 200)).toBe(200);
    expect(effectiveHourlyLimit(50, 200)).toBe(50);
  });
});

describe('hour windows', () => {
  it('labels UTC hours', () => {
    const t = Date.parse('2026-10-01T10:59:59.999Z');
    expect(hourWindowLabel(hourIndex(t))).toBe('2026-10-01T10');
    expect(hourWindowLabel(hourIndex(t + 1))).toBe('2026-10-01T11');
  });

  it('handles year boundaries and leap days', () => {
    expect(hourWindowLabel(hourIndex(Date.parse('2028-02-29T23:30:00Z')))).toBe('2028-02-29T23');
    expect(hourWindowLabel(hourIndex(Date.parse('2026-12-31T23:00:00Z')) + 1)).toBe('2027-01-01T00');
    expect(hourIndex(HOUR_MS * 5)).toBe(5);
  });

  it('formats a readable range', () => {
    expect(hourWindowRange('2026-10-01T10')).toBe('2026-10-01 10:00–10:59 UTC');
  });
});
