import { PaymentMethod, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { DEFAULT_SETTINGS } from '../settings/settings.defaults';
import { computeEarnings, refundable } from './rules';

/**
 * Money bookkeeping that must commit atomically with an order's final status. Called from OrderTransitionService
 * inside its transaction, so an order can never be DELIVERED without its earnings, nor CANCELLED after payment
 * without the refund that gives the money back.
 */
export async function settleDeliveredInTx(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      restaurantId: true, subtotalMinor: true, deliveryFeeMinor: true, discountMinor: true, commissionBps: true, paymentMethod: true, totalMinor: true,
      coupon: { select: { restaurantId: true } }, assignments: { where: { status: 'COMPLETED' }, select: { riderId: true }, take: 1 },
    },
  });
  const share = (await tx.platformSetting.findUnique({ where: { key: 'rider.deliveryFeeShareBps' } }))?.value;
  const e = computeEarnings({
    subtotalMinor: o.subtotalMinor, deliveryFeeMinor: o.deliveryFeeMinor, commissionBps: o.commissionBps,
    restaurantFundedDiscountMinor: o.coupon?.restaurantId ? o.discountMinor : 0,
    riderShareBps: typeof share === 'number' ? share : DEFAULT_SETTINGS['rider.deliveryFeeShareBps'],
    cashCollectedMinor: o.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? o.totalMinor : 0,
  });
  await tx.restaurantEarning.createMany({ data: [{ orderId, restaurantId: o.restaurantId, ...e.restaurant }], skipDuplicates: true });
  const riderId = o.assignments[0]?.riderId;
  if (riderId) await tx.riderEarning.createMany({ data: [{ orderId, riderId, ...e.rider }], skipDuplicates: true });
}

/** A paid online order that ends without delivery is refunded in full, automatically (the gateway call happens after commit). */
export async function autoRefundInTx(tx: Prisma.TransactionClient, orderId: string, reason: string, now = new Date()): Promise<string | null> {
  const pay = await tx.payment.findFirst({ where: { orderId, method: PaymentMethod.ONLINE, status: PaymentStatus.SUCCESSFUL }, include: { refunds: true } });
  if (!pay) return null;
  const left = refundable(pay.amountMinor, pay.refunds);
  if (left <= 0) return null;
  const r = await tx.refund.create({
    data: { paymentId: pay.id, orderId, amountMinor: left, status: RefundStatus.APPROVED, reason, reviewNote: 'Automatic: the order did not complete', reviewedAt: now },
    select: { id: true },
  });
  return r.id;
}
