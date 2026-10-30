/** Restaurants operate in Asia/Dhaka (UTC+6, no DST). Make this per-restaurant when expanding to other time zones. */
export const DEFAULT_UTC_OFFSET_MIN = 360;

export interface HourWindow {
  dayOfWeek: number; // 0 = Sunday
  opensAtMin: number; // minutes after local midnight
  closesAtMin: number; // may exceed 1440 to close after midnight
}

export function localDayAndMinute(date: Date, offsetMin = DEFAULT_UTC_OFFSET_MIN) {
  const local = new Date(date.getTime() + offsetMin * 60_000);
  return { day: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** A restaurant with no configured hours is treated as closed (the owner must set them). */
export function isOpenAt(hours: readonly HourWindow[], date: Date, offsetMin = DEFAULT_UTC_OFFSET_MIN): boolean {
  const { day, minute } = localDayAndMinute(date, offsetMin);
  const yesterday = (day + 6) % 7;
  return hours.some(
    (h) =>
      (h.dayOfWeek === day && minute >= h.opensAtMin && minute < Math.min(h.closesAtMin, 1440)) ||
      // spill-over of yesterday's after-midnight window
      (h.dayOfWeek === yesterday && h.closesAtMin > 1440 && minute < h.closesAtMin - 1440) ||
      // today's window that runs past midnight is also open from its start until 24:00
      (h.dayOfWeek === day && h.closesAtMin > 1440 && minute >= h.opensAtMin),
  );
}
