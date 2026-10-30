import type { HourWindow } from '../common/geo/hours';

const MAX_WINDOWS_PER_DAY = 4;
const MAX_CLOSE_MIN = 1440 + 360; // may close up to 06:00 the next day

/** Returns a human-readable problem, or null when the weekly schedule is valid. */
export function validateHours(windows: readonly HourWindow[]): string | null {
  for (const w of windows) {
    if (!Number.isInteger(w.dayOfWeek) || w.dayOfWeek < 0 || w.dayOfWeek > 6) return 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)';
    if (!Number.isInteger(w.opensAtMin) || w.opensAtMin < 0 || w.opensAtMin >= 1440) return 'opening time must be within the day';
    if (!Number.isInteger(w.closesAtMin) || w.closesAtMin <= w.opensAtMin) return 'closing time must be after opening time';
    if (w.closesAtMin > MAX_CLOSE_MIN) return 'closing time may be at most 06:00 the next day';
  }
  const byDay = new Map<number, HourWindow[]>();
  for (const w of windows) byDay.set(w.dayOfWeek, [...(byDay.get(w.dayOfWeek) ?? []), w]);

  for (const [day, list] of byDay) {
    if (list.length > MAX_WINDOWS_PER_DAY) return `at most ${MAX_WINDOWS_PER_DAY} opening periods per day`;
    const sorted = [...list].sort((a, b) => a.opensAtMin - b.opensAtMin);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].opensAtMin < sorted[i - 1].closesAtMin) return `overlapping opening periods on day ${day}`;
    }
    // After-midnight spill-over must not collide with the next day's first opening.
    const last = sorted[sorted.length - 1];
    if (last.closesAtMin > 1440) {
      const next = (byDay.get((day + 1) % 7) ?? []).map((w) => w.opensAtMin);
      if (next.length && Math.min(...next) < last.closesAtMin - 1440) return `day ${day} runs past midnight into the next day's opening`;
    }
  }
  return null;
}
