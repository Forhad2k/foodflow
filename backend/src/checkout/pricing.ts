import { CouponType } from '@prisma/client';

export interface PricedAddon {
  priceMinor: number;
}

/** (unit price + add-ons) × quantity: the single definition of a line total. */
export function lineTotal(unitPriceMinor: number, addons: readonly PricedAddon[], quantity: number): number {
  const perUnit = unitPriceMinor + addons.reduce((sum, a) => sum + a.priceMinor, 0);
  return perUnit * quantity;
}

export interface TotalsInput {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  serviceFeeMinor: number;
  taxBps: number;
  discountMinor: number;
  couponType?: CouponType;
}

export interface Totals {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  serviceFeeMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * total = subtotal + delivery + service + tax − discount  (matches the orders_amounts_chk DB constraint).
 * Tax applies to food after any item discount; a free-delivery coupon does not reduce taxable food.
 * The discount is clamped so the total can never go negative.
 */
export function computeTotals(i: TotalsInput): Totals {
  const maxDiscount = i.subtotalMinor + i.deliveryFeeMinor;
  const discountMinor = Math.min(Math.max(0, i.discountMinor), maxDiscount);
  const itemDiscount = i.couponType === CouponType.FREE_DELIVERY ? 0 : discountMinor;
  const taxable = Math.max(0, i.subtotalMinor - itemDiscount);
  const taxMinor = Math.round((taxable * i.taxBps) / 10_000);
  const totalMinor = i.subtotalMinor + i.deliveryFeeMinor + i.serviceFeeMinor + taxMinor - discountMinor;
  return {
    subtotalMinor: i.subtotalMinor,
    deliveryFeeMinor: i.deliveryFeeMinor,
    serviceFeeMinor: i.serviceFeeMinor,
    discountMinor,
    taxMinor,
    totalMinor,
  };
}

/** Platform commission on the food subtotal, rounded to the nearest minor unit. Used by stats now and earnings in Phase 7. */
export function commissionMinor(subtotalMinor: number, commissionBps: number): number {
  return Math.round((subtotalMinor * commissionBps) / 10_000);
}
