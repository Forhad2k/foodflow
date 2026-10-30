import { CouponType } from '@prisma/client';

export interface CouponLike {
  code: string;
  type: CouponType;
  value: number;
  maxDiscountMinor: number | null;
  minSubtotalMinor: number;
  startsAt: Date;
  endsAt: Date;
  usageLimitTotal: number | null;
  usageLimitPerUser: number;
  firstOrderOnly: boolean;
  restaurantId: string | null;
  isActive: boolean;
}

export interface CouponContext {
  now: Date;
  restaurantId: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  totalRedemptions: number;
  userRedemptions: number;
  isFirstOrder: boolean;
}

export type CouponResult =
  | { ok: true; discountMinor: number }
  | { ok: false; code: CouponFailure; message: string };

export type CouponFailure =
  | 'COUPON_NOT_FOUND'
  | 'COUPON_INACTIVE'
  | 'COUPON_NOT_STARTED'
  | 'COUPON_EXPIRED'
  | 'COUPON_WRONG_RESTAURANT'
  | 'COUPON_MIN_SPEND'
  | 'COUPON_USAGE_LIMIT'
  | 'COUPON_USER_LIMIT'
  | 'COUPON_FIRST_ORDER_ONLY';

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

/** Pure eligibility + discount calculation. All amounts are integer minor units. */
export function evaluateCoupon(c: CouponLike, ctx: CouponContext): CouponResult {
  const fail = (code: CouponFailure, message: string): CouponResult => ({ ok: false, code, message });
  if (!c.isActive) return fail('COUPON_INACTIVE', 'This coupon is not active');
  if (ctx.now < c.startsAt) return fail('COUPON_NOT_STARTED', 'This coupon is not valid yet');
  if (ctx.now >= c.endsAt) return fail('COUPON_EXPIRED', 'This coupon has expired');
  if (c.restaurantId && c.restaurantId !== ctx.restaurantId) return fail('COUPON_WRONG_RESTAURANT', 'This coupon is for a different restaurant');
  if (ctx.subtotalMinor < c.minSubtotalMinor) return fail('COUPON_MIN_SPEND', 'Order total is below the minimum spend for this coupon');
  if (c.usageLimitTotal !== null && ctx.totalRedemptions >= c.usageLimitTotal) return fail('COUPON_USAGE_LIMIT', 'This coupon has been fully redeemed');
  if (ctx.userRedemptions >= c.usageLimitPerUser) return fail('COUPON_USER_LIMIT', 'You have already used this coupon');
  if (c.firstOrderOnly && !ctx.isFirstOrder) return fail('COUPON_FIRST_ORDER_ONLY', 'This coupon is only for first orders');

  let discount: number;
  switch (c.type) {
    case CouponType.PERCENTAGE:
      discount = Math.floor((ctx.subtotalMinor * c.value) / 100);
      if (c.maxDiscountMinor !== null) discount = Math.min(discount, c.maxDiscountMinor);
      break;
    case CouponType.FIXED_AMOUNT:
      discount = Math.min(c.value, ctx.subtotalMinor);
      break;
    case CouponType.FREE_DELIVERY:
      discount = ctx.deliveryFeeMinor;
      break;
  }
  return { ok: true, discountMinor: Math.max(0, discount) };
}
