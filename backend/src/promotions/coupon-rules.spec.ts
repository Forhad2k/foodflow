import { CouponType } from '@prisma/client';
import { shortName } from '../reviews/review.service';
import { SETTING_SCHEMAS } from '../admin/settings-schema';
import { DEFAULT_SETTINGS } from '../settings/settings.defaults';
import { validateCoupon } from './coupon.service';

const base = { code: 'SAVE10', type: CouponType.PERCENTAGE, value: 10, maxDiscountMinor: 5000, startsAt: new Date('2026-10-01'), endsAt: new Date('2026-11-01'), usageLimitTotal: 100 };
describe('coupon definitions', () => {
  it('accepts sensible coupons and rejects nonsense', () => {
    expect(validateCoupon(base, 'ADMIN')).toBeNull();
    expect(validateCoupon({ ...base, endsAt: base.startsAt }, 'ADMIN')).toMatch(/end date/);
    expect(validateCoupon({ ...base, value: 0 }, 'ADMIN')).toMatch(/between 1 and 100/);
    expect(validateCoupon({ ...base, value: 101 }, 'ADMIN')).toMatch(/between 1 and 100/);
    expect(validateCoupon({ ...base, type: CouponType.FIXED_AMOUNT, value: 0 }, 'ADMIN')).toMatch(/positive/);
    expect(validateCoupon({ ...base, type: CouponType.FREE_DELIVERY, value: 5 }, 'ADMIN')).toMatch(/no value/);
    expect(validateCoupon({ ...base, type: CouponType.FREE_DELIVERY, value: 0 }, 'ADMIN')).toBeNull();
  });
  it('restaurants get tighter limits (they are spending their own money)', () => {
    expect(validateCoupon({ ...base, value: 60 }, 'OWNER')).toMatch(/at most 50%/);
    expect(validateCoupon({ ...base, maxDiscountMinor: null }, 'OWNER')).toMatch(/maximum discount/);
    expect(validateCoupon({ ...base, usageLimitTotal: null }, 'OWNER')).toMatch(/usage limit/);
    expect(validateCoupon({ ...base, value: 60, maxDiscountMinor: null, usageLimitTotal: null }, 'ADMIN')).toBeNull();
  });
});
describe('admin settings are range-checked', () => {
  it('has a schema for every setting and accepts every default', () => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) expect(SETTING_SCHEMAS[k as keyof typeof DEFAULT_SETTINGS].safeParse(v).success).toBe(true);
    expect(Object.keys(SETTING_SCHEMAS).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
  it('refuses absurd values and the wrong shape', () => {
    const s = SETTING_SCHEMAS;
    expect(s['commission.defaultBps'].safeParse(9000).success).toBe(false);
    expect(s['commission.defaultBps'].safeParse(15.5).success).toBe(false);
    expect(s['commission.defaultBps'].safeParse('15').success).toBe(false);
    expect(s['dispatch.offerTimeoutSeconds'].safeParse(1).success).toBe(false);
    expect(s['discovery.rankingWeights'].safeParse({ distance: 0, eta: 0, rating: 0, relevance: 0 }).success).toBe(false);
    expect(s['discovery.rankingWeights'].safeParse({ distance: 1, eta: 1, rating: 1 }).success).toBe(false);
    expect(s['discovery.rankingWeights'].safeParse({ distance: 1, eta: 1, rating: 1, relevance: 1, extra: 1 }).success).toBe(false);
    expect(s['rider.deliveryFeeShareBps'].safeParse(10_001).success).toBe(false);
  });
});
describe('reviewer names', () => {
  it('shows only first name and last initial', () => {
    expect(shortName('Nusrat Jahan')).toBe('Nusrat J.');
    expect(shortName('  Rahim   Uddin Ahmed ')).toBe('Rahim A.');
    expect(shortName('Madonna')).toBe('Madonna');
    expect(shortName('')).toBe('Customer');
    expect(shortName(null)).toBe('Customer');
  });
});
