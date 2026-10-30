import { RefundStatus } from '@prisma/client';
import { assertRefundTransition, computeEarnings, nextAverage, refundable } from './rules';

const R = RefundStatus;
describe('refund state machine', () => {
  it('allows the legitimate paths only', () => {
    for (const [a, b] of [[R.REQUESTED, R.APPROVED], [R.REQUESTED, R.REJECTED], [R.APPROVED, R.PROCESSED], [R.APPROVED, R.FAILED], [R.FAILED, R.APPROVED]] as const) expect(() => assertRefundTransition(a, b)).not.toThrow();
    for (const [a, b] of [[R.REQUESTED, R.PROCESSED], [R.REJECTED, R.APPROVED], [R.PROCESSED, R.APPROVED], [R.PROCESSED, R.FAILED], [R.APPROVED, R.REQUESTED]] as const) expect(() => assertRefundTransition(a, b)).toThrow(/cannot become/);
  });
});
describe('refundable amount', () => {
  const r = (status: RefundStatus, amountMinor: number) => ({ status, amountMinor });
  it('subtracts everything that is committed, ignores rejected/failed ones, never goes negative', () => {
    expect(refundable(10000, [])).toBe(10000);
    expect(refundable(10000, [r(R.PROCESSED, 4000), r(R.REQUESTED, 1000)])).toBe(5000);
    expect(refundable(10000, [r(R.REJECTED, 9000), r(R.FAILED, 9000)])).toBe(10000);
    expect(refundable(10000, [r(R.APPROVED, 12000)])).toBe(0);
  });
});
describe('earnings', () => {
  const base = { subtotalMinor: 100000, deliveryFeeMinor: 6000, commissionBps: 1500, restaurantFundedDiscountMinor: 0, riderShareBps: 8000, cashCollectedMinor: 0 };
  it('restaurant keeps the food money minus commission; rider gets a share of the delivery fee', () => {
    expect(computeEarnings(base)).toEqual({ restaurant: { grossMinor: 100000, commissionMinor: 15000, netMinor: 85000 }, rider: { amountMinor: 4800, cashCollectedMinor: 0 } });
  });
  it('a restaurant-funded discount comes out of the restaurant, never below zero; platform coupons do not', () => {
    expect(computeEarnings({ ...base, restaurantFundedDiscountMinor: 10000 }).restaurant.netMinor).toBe(75000);
    expect(computeEarnings({ ...base, restaurantFundedDiscountMinor: 999999 }).restaurant.netMinor).toBe(0);
    expect(computeEarnings({ ...base, restaurantFundedDiscountMinor: 0 }).restaurant.netMinor).toBe(85000);
  });
  it('records the cash a rider collected, and rounds the rider share down to a whole unit', () => {
    expect(computeEarnings({ ...base, cashCollectedMinor: 112000, deliveryFeeMinor: 3333 }).rider).toEqual({ amountMinor: 2666, cashCollectedMinor: 112000 });
  });
});
describe('ratings', () => {
  it('maintains a running average', () => {
    let s = { avg: 0, count: 0 };
    for (const x of [5, 4, 3]) s = nextAverage(s.avg, s.count, x);
    expect(s.count).toBe(3);
    expect(s.avg).toBeCloseTo(4, 10);
  });
});
