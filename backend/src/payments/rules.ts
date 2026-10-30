import { RefundStatus } from '@prisma/client';
import { DomainError } from '../common/errors/domain-error';
import { commissionMinor } from '../checkout/pricing';

// ─────────── refunds ───────────
const R = RefundStatus;
/** REQUESTED → APPROVED | REJECTED ; APPROVED → PROCESSED | FAILED ; FAILED → APPROVED (retry). REJECTED and PROCESSED are final. */
const REFUND_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  [R.REQUESTED]: [R.APPROVED, R.REJECTED],
  [R.APPROVED]: [R.PROCESSED, R.FAILED],
  [R.FAILED]: [R.APPROVED],
  [R.REJECTED]: [],
  [R.PROCESSED]: [],
};
export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!REFUND_TRANSITIONS[from].includes(to)) throw new DomainError('INVALID_REFUND_TRANSITION', `A ${from} refund cannot become ${to}`, 409, { from, to });
}

/** Money still refundable on a payment: paid amount minus every refund that is approved, processed or still being asked for. */
export function refundable(paymentAmountMinor: number, refunds: readonly { status: RefundStatus; amountMinor: number }[]): number {
  const committed = refunds.filter((r) => r.status !== R.REJECTED && r.status !== R.FAILED).reduce((s, r) => s + r.amountMinor, 0);
  return Math.max(0, paymentAmountMinor - committed);
}

// ─────────── earnings ───────────
export interface EarningsInput {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  commissionBps: number;
  /** Discount the RESTAURANT paid for (its own coupon). Platform-wide coupons are funded by the platform. */
  restaurantFundedDiscountMinor: number;
  riderShareBps: number;
  cashCollectedMinor: number;
}
export function computeEarnings(i: EarningsInput) {
  const commission = commissionMinor(i.subtotalMinor, i.commissionBps); // on the food subtotal, before any discount
  return {
    restaurant: { grossMinor: i.subtotalMinor, commissionMinor: commission, netMinor: Math.max(0, i.subtotalMinor - commission - i.restaurantFundedDiscountMinor) },
    rider: { amountMinor: Math.floor((i.deliveryFeeMinor * i.riderShareBps) / 10_000), cashCollectedMinor: i.cashCollectedMinor },
  };
}

// ─────────── ratings ───────────
/** Running average after adding one rating (the database does the same arithmetic atomically in one UPDATE). */
export function nextAverage(avg: number, count: number, rating: number): { avg: number; count: number } {
  return { avg: (avg * count + rating) / (count + 1), count: count + 1 };
}
