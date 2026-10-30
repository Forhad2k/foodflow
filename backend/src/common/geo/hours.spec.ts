import { isOpenAt } from './hours';

// Dhaka = UTC+6. 2026-10-12 is a Monday (dayOfWeek 1).
const dhaka = (iso: string) => new Date(`${iso}+06:00`);

describe('isOpenAt', () => {
  const mon10to23 = [{ dayOfWeek: 1, opensAtMin: 600, closesAtMin: 1380 }];

  it('is open inside the window and closed outside, in restaurant-local time', () => {
    expect(isOpenAt(mon10to23, dhaka('2026-10-12T12:00:00'))).toBe(true);
    expect(isOpenAt(mon10to23, dhaka('2026-10-12T09:59:00'))).toBe(false);
    expect(isOpenAt(mon10to23, dhaka('2026-10-12T23:00:00'))).toBe(false); // close is exclusive
    expect(isOpenAt(mon10to23, dhaka('2026-10-13T12:00:00'))).toBe(false); // Tuesday has no hours
  });
  it('does not confuse UTC and local time', () => {
    // 20:00 UTC Sunday = 02:00 Monday Dhaka → closed. 05:00 UTC Monday = 11:00 Dhaka → open.
    expect(isOpenAt(mon10to23, new Date('2026-10-11T20:00:00Z'))).toBe(false);
    expect(isOpenAt(mon10to23, new Date('2026-10-12T05:00:00Z'))).toBe(true);
  });
  it('supports after-midnight closing (spill-over into the next day)', () => {
    const lateNight = [{ dayOfWeek: 1, opensAtMin: 1080, closesAtMin: 1560 }]; // Mon 18:00 → Tue 02:00
    expect(isOpenAt(lateNight, dhaka('2026-10-12T23:30:00'))).toBe(true);
    expect(isOpenAt(lateNight, dhaka('2026-10-13T01:30:00'))).toBe(true);
    expect(isOpenAt(lateNight, dhaka('2026-10-13T02:00:00'))).toBe(false);
    expect(isOpenAt(lateNight, dhaka('2026-10-12T17:59:00'))).toBe(false);
  });
  it('treats a restaurant with no hours as closed', () => {
    expect(isOpenAt([], dhaka('2026-10-12T12:00:00'))).toBe(false);
  });
  it('supports split shifts', () => {
    const split = [
      { dayOfWeek: 1, opensAtMin: 660, closesAtMin: 900 },
      { dayOfWeek: 1, opensAtMin: 1080, closesAtMin: 1320 },
    ];
    expect(isOpenAt(split, dhaka('2026-10-12T12:00:00'))).toBe(true);
    expect(isOpenAt(split, dhaka('2026-10-12T16:00:00'))).toBe(false);
    expect(isOpenAt(split, dhaka('2026-10-12T19:00:00'))).toBe(true);
  });
});
