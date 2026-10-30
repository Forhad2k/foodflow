import { CouponType } from '@prisma/client';
import { CouponLike, evaluateCoupon, normalizeCouponCode } from './coupons';
import { computeTotals, lineTotal } from './pricing';

describe('lineTotal', () => {
  it('multiplies (unit + add-ons) by quantity', () => {
    expect(lineTotal(25000, [{ priceMinor: 3000 }, { priceMinor: 2000 }], 3)).toBe(90000);
    expect(lineTotal(25000, [], 1)).toBe(25000);
  });
});

describe('computeTotals', () => {
  const base = { subtotalMinor: 100000, deliveryFeeMinor: 6000, serviceFeeMinor: 1000, taxBps: 0, discountMinor: 0 };
  it('sums components', () => {
    expect(computeTotals(base).totalMinor).toBe(107000);
  });
  it('matches the DB constraint: total = subtotal + delivery + service + tax − discount', () => {
    const t = computeTotals({ ...base, taxBps: 500, discountMinor: 10000 });
    expect(t.taxMinor).toBe(4500); // 5% of 90,000
    expect(t.totalMinor).toBe(t.subtotalMinor + t.deliveryFeeMinor + t.serviceFeeMinor + t.taxMinor - t.discountMinor);
  });
  it('never lets the discount exceed what is being charged for', () => {
    const t = computeTotals({ ...base, discountMinor: 999999 });
    expect(t.discountMinor).toBe(106000);
    expect(t.totalMinor).toBe(1000); // only the service fee remains
  });
  it('free-delivery coupons do not reduce taxable food', () => {
    const t = computeTotals({ ...base, taxBps: 1000, discountMinor: 6000, couponType: CouponType.FREE_DELIVERY });
    expect(t.taxMinor).toBe(10000);
  });
  it('uses integers only', () => {
    const t = computeTotals({ ...base, subtotalMinor: 33333, taxBps: 750 });
    for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('evaluateCoupon', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const coupon: CouponLike = {
    code: 'WELCOME', type: CouponType.PERCENTAGE, value: 20, maxDiscountMinor: 15000, minSubtotalMinor: 30000,
    startsAt: new Date('2026-10-01T00:00:00Z'), endsAt: new Date('2026-11-01T00:00:00Z'),
    usageLimitTotal: 100, usageLimitPerUser: 1, firstOrderOnly: false, restaurantId: null, isActive: true,
  };
  const ctx = { now, restaurantId: 'r1', subtotalMinor: 50000, deliveryFeeMinor: 6000, totalRedemptions: 0, userRedemptions: 0, isFirstOrder: true };
  const fails = (c: CouponLike, x = ctx) => {
    const r = evaluateCoupon(c, x);
    return r.ok ? null : r.code;
  };

  it('computes percentage with a cap', () => {
    expect(evaluateCoupon(coupon, ctx)).toEqual({ ok: true, discountMinor: 10000 });
    expect(evaluateCoupon(coupon, { ...ctx, subtotalMinor: 200000 })).toEqual({ ok: true, discountMinor: 15000 });
  });
  it('fixed amount cannot exceed subtotal; free delivery equals the fee', () => {
    expect(evaluateCoupon({ ...coupon, type: CouponType.FIXED_AMOUNT, value: 99999 }, ctx)).toEqual({ ok: true, discountMinor: 50000 });
    expect(evaluateCoupon({ ...coupon, type: CouponType.FREE_DELIVERY }, ctx)).toEqual({ ok: true, discountMinor: 6000 });
  });
  it('enforces every eligibility rule', () => {
    expect(fails({ ...coupon, isActive: false })).toBe('COUPON_INACTIVE');
    expect(fails({ ...coupon, startsAt: new Date('2026-10-20T00:00:00Z') })).toBe('COUPON_NOT_STARTED');
    expect(fails({ ...coupon, endsAt: now })).toBe('COUPON_EXPIRED'); // end is exclusive
    expect(fails({ ...coupon, restaurantId: 'other' })).toBe('COUPON_WRONG_RESTAURANT');
    expect(fails(coupon, { ...ctx, subtotalMinor: 29999 })).toBe('COUPON_MIN_SPEND');
    expect(fails(coupon, { ...ctx, totalRedemptions: 100 })).toBe('COUPON_USAGE_LIMIT');
    expect(fails(coupon, { ...ctx, userRedemptions: 1 })).toBe('COUPON_USER_LIMIT');
    expect(fails({ ...coupon, firstOrderOnly: true }, { ...ctx, isFirstOrder: false })).toBe('COUPON_FIRST_ORDER_ONLY');
  });
  it('restaurant-specific coupon works for its restaurant', () => {
    expect(evaluateCoupon({ ...coupon, restaurantId: 'r1' }, ctx).ok).toBe(true);
  });
  it('normalises codes', () => {
    expect(normalizeCouponCode('  welcome50 ')).toBe('WELCOME50');
  });
});
