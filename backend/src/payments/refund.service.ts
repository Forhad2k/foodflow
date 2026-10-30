import { NotificationType, OrderStatus, PaymentStatus, RefundStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { DomainError, notFound } from '../common/errors/domain-error';
import { createLogger } from '../common/logger';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { PaymentProvider } from './provider';
import { assertRefundTransition, refundable } from './rules';

const log = createLogger('refunds');

/**
 * Refunds. Automatic ones (a paid order that did not complete) are created by the ledger inside the order transaction;
 * customer-requested ones (after delivery) go REQUESTED → admin review → APPROVED → paid out at the gateway.
 * The gateway call is idempotent on the refund id and happens OUTSIDE any database transaction; the result is then
 * recorded with a conditional update, so retries and concurrent workers cannot refund twice.
 */
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider | null,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** A customer asks for money back on a delivered order. */
  async request(customerId: string, orderId: string, input: { amountMinor?: number; reason: string }) {
    const s = await this.settings.get();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: orderId, customerId },
        select: { status: true, deliveredAt: true, payments: { where: { status: { in: [PaymentStatus.SUCCESSFUL, PaymentStatus.REFUNDED] } }, include: { refunds: true }, take: 1 } },
      });
      if (!order) throw notFound('Order not found');
      const pay = order.payments[0];
      if (pay?.status === PaymentStatus.REFUNDED) throw new DomainError('ALREADY_REFUNDED', 'This order has already been fully refunded', 409);
      if (order.status !== OrderStatus.DELIVERED || !pay || !order.deliveredAt) throw new DomainError('NOT_REFUNDABLE', 'Only delivered, paid orders can be refunded', 409);
      if (Date.now() - order.deliveredAt.getTime() > s['refunds.windowDays'] * 86_400_000) throw new DomainError('REFUND_WINDOW_CLOSED', `Refunds can be requested within ${s['refunds.windowDays']} days of delivery`, 409);
      if (pay.refunds.some((r) => r.status === RefundStatus.REQUESTED)) throw new DomainError('REFUND_ALREADY_REQUESTED', 'A refund request for this order is already being reviewed', 409);
      const left = refundable(pay.amountMinor, pay.refunds);
      const amountMinor = input.amountMinor ?? left;
      if (amountMinor <= 0 || amountMinor > left) throw new DomainError('INVALID_REFUND_AMOUNT', `You can request up to ${left}`, 422, { maxMinor: left });
      return tx.refund.create({ data: { paymentId: pay.id, orderId, amountMinor, reason: input.reason.trim(), requestedById: customerId }, select: { id: true, status: true, amountMinor: true } });
    });
  }

  listForOrder(customerId: string, orderId: string) {
    return this.prisma.refund.findMany({ where: { orderId, order: { customerId } }, orderBy: { requestedAt: 'desc' }, select: { id: true, amountMinor: true, status: true, reason: true, reviewNote: true, requestedAt: true, processedAt: true } });
  }

  async listAll(q: { status?: RefundStatus; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where = q.status ? { status: q.status } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({ where, orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, include: { order: { select: { orderNumber: true, totalMinor: true } }, payment: { select: { method: true, provider: true } } } }),
    ]);
    return { items, page, limit, total };
  }

  /** Admin decision. Approving a gateway-paid refund pays it out immediately. */
  async review(adminId: string, refundId: string, d: { approve: boolean; note?: string; amountMinor?: number }, ip?: string) {
    if (!d.approve && !d.note?.trim()) throw new DomainError('REASON_REQUIRED', 'Tell the customer why the refund was declined', 422);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "refunds" WHERE id = ${refundId}::uuid FOR UPDATE`;
      const r = await tx.refund.findUnique({ where: { id: refundId }, include: { payment: { include: { refunds: true } } } });
      if (!r) throw notFound('Refund not found');
      assertRefundTransition(r.status, d.approve ? RefundStatus.APPROVED : RefundStatus.REJECTED);
      let amountMinor = r.amountMinor;
      if (d.approve && d.amountMinor !== undefined && d.amountMinor !== r.amountMinor) {
        const others = r.payment.refunds.filter((x) => x.id !== r.id);
        const max = refundable(r.payment.amountMinor, others);
        if (d.amountMinor <= 0 || d.amountMinor > max) throw new DomainError('INVALID_REFUND_AMOUNT', `Up to ${max} can be refunded`, 422, { maxMinor: max });
        amountMinor = d.amountMinor;
      }
      await tx.refund.update({ where: { id: refundId }, data: { status: d.approve ? RefundStatus.APPROVED : RefundStatus.REJECTED, amountMinor, reviewedById: adminId, reviewedAt: new Date(), reviewNote: d.note?.trim() || null } });
      await this.audit.log({ actorId: adminId, action: d.approve ? 'refund.approve' : 'refund.reject', entityType: 'Refund', entityId: refundId, ip, metadata: { amountMinor, from: r.status } }, tx);
      if (!d.approve) await this.notifications.create(tx, { userId: r.requestedById ?? (await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { customerId: true } })).customerId, type: NotificationType.REFUND, title: 'Refund declined', body: d.note!.trim(), data: { orderId: r.orderId } });
    });
    return d.approve ? this.process(refundId) : this.get(refundId);
  }

  /** Pays an APPROVED refund out. Idempotent; safe to call repeatedly and concurrently. */
  async process(refundId: string) {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!r) throw notFound('Refund not found');
    if (r.status !== RefundStatus.APPROVED) return this.get(refundId);
    if (!this.provider || r.payment.provider !== this.provider.name || !r.payment.providerRef) return this.get(refundId); // cash refunds are recorded by an admin (markProcessed)
    let outcome: { status: 'SUCCEEDED' | 'FAILED'; providerRefundRef: string };
    try {
      outcome = await this.provider.refund({ refundId, providerRef: r.payment.providerRef, amountMinor: r.amountMinor });
    } catch (e) {
      log.error(`refund ${refundId} gateway error: ${(e as Error).message}`);
      return this.get(refundId); // stays APPROVED: the sweep retries
    }
    await this.record(refundId, outcome.status === 'SUCCEEDED', outcome.providerRefundRef);
    return this.get(refundId);
  }

  /** Admin records a refund that was paid outside the gateway (cash-on-delivery orders). */
  async markProcessed(adminId: string, refundId: string, reference: string, ip?: string) {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { status: true, payment: { select: { method: true } } } });
    if (!r) throw notFound('Refund not found');
    if (r.payment.method === 'ONLINE') throw new DomainError('GATEWAY_REFUND', 'Online refunds are paid through the gateway', 409);
    await this.record(refundId, true, reference.trim());
    await this.audit.log({ actorId: adminId, action: 'refund.mark_processed', entityType: 'Refund', entityId: refundId, ip, metadata: { reference } });
    return this.get(refundId);
  }

  /** Sweep: pay out approved refunds that are still waiting (automatic ones and retries). */
  async processPending(): Promise<number> {
    if (!this.provider) return 0;
    const due = await this.prisma.refund.findMany({ where: { status: RefundStatus.APPROVED, payment: { provider: this.provider.name } }, take: 20, select: { id: true } });
    for (const { id } of due) await this.process(id);
    return due.length;
  }

  private async record(refundId: string, succeeded: boolean, ref: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "refunds" WHERE id = ${refundId}::uuid FOR UPDATE`;
      const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: { include: { refunds: true } }, order: { select: { customerId: true, orderNumber: true } } } });
      if (r.status !== RefundStatus.APPROVED) return; // someone else already recorded it
      if (!succeeded) {
        await tx.refund.update({ where: { id: refundId }, data: { status: RefundStatus.FAILED, reviewNote: 'The payment gateway refused the refund' } });
        return;
      }
      await tx.refund.update({ where: { id: refundId }, data: { status: RefundStatus.PROCESSED, processedAt: new Date(), providerRef: ref } });
      const paid = r.payment.refunds.filter((x) => x.status === RefundStatus.PROCESSED || x.id === refundId).reduce((s, x) => s + x.amountMinor, 0);
      if (paid >= r.payment.amountMinor) await tx.payment.update({ where: { id: r.paymentId }, data: { status: PaymentStatus.REFUNDED } });
      await this.notifications.create(tx, { userId: r.order.customerId, type: NotificationType.REFUND, title: 'Refund issued', body: `Your refund for order #${r.order.orderNumber} has been issued.`, data: { orderId: r.orderId, refundId } });
    });
  }

  private get(refundId: string) {
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { id: true, orderId: true, amountMinor: true, status: true, reason: true, reviewNote: true, processedAt: true } });
  }
}
