import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { Db } from '../common/db';
import { DomainError, notFound } from '../common/errors/domain-error';
import { createLogger } from '../common/logger';
import type { Env } from '../config/env';
import type { NotificationService } from '../notifications/notification.service';
import type { OrderTransitionService } from '../orders/order-transition.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import { autoRefundInTx } from './ledger';
import type { PaymentProvider } from './provider';

const log = createLogger('payments');
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/**
 * Online payments. Rules this class enforces:
 *  - an order is only ever PLACED because the PROVIDER confirmed payment server-to-server (fetchStatus). A browser
 *    redirect, a callback body, or anything the client says is never believed on its own
 *  - callbacks are authenticated (signature over the raw body) and idempotent ((provider, eventId) unique, plus the
 *    row lock and the one-successful-payment-per-order index): duplicates and races are harmless
 *  - the paid amount must equal the amount we asked for; anything else is refused and flagged
 *  - money that arrives for an order that has already ended is automatically refunded
 *  - lost callbacks are covered by a reconciliation sweep that asks the provider directly
 */
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: Env,
    readonly provider: PaymentProvider | null,
    private readonly transitions: OrderTransitionService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  get enabled(): boolean {
    return this.provider !== null;
  }

  /** After an ONLINE order commits: open the payment at the gateway and return where the customer pays. */
  async start(orderId: string): Promise<{ redirectUrl: string; expiresAt: Date }> {
    if (!this.provider) throw new DomainError('PAYMENT_METHOD_UNAVAILABLE', 'Online payment is not available', 422);
    const pay = await this.prisma.payment.findFirst({ where: { orderId, method: PaymentMethod.ONLINE, status: PaymentStatus.PENDING }, include: { order: { select: { orderNumber: true, currency: true } } } });
    if (!pay) throw new DomainError('NO_PENDING_PAYMENT', 'This order has no payment waiting', 409);
    const expiresAt = new Date(pay.initiatedAt.getTime() + (await this.settings.get())['payments.pendingTimeoutMinutes'] * 60_000);
    if (pay.providerRef) return { redirectUrl: this.provider.redirectUrl(pay.providerRef), expiresAt };
    try {
      const s = await this.provider.initialize({ paymentId: pay.id, orderNumber: pay.order.orderNumber, amountMinor: pay.amountMinor, currency: pay.currency });
      const claimed = await this.prisma.payment.updateMany({ where: { id: pay.id, providerRef: null }, data: { providerRef: s.providerRef } });
      if (claimed.count === 0) return this.start(orderId); // a concurrent call won; use its session
      return { redirectUrl: s.redirectUrl, expiresAt };
    } catch (e) {
      log.error(`could not start payment for ${orderId}: ${(e as Error).message}`);
      await this.transitions.transition({ orderId, to: OrderStatus.CANCELLED, actor: { role: 'SYSTEM' }, reason: 'Payment could not be started' }).catch(() => undefined);
      throw new DomainError('PAYMENT_PROVIDER_ERROR', 'The payment service is unavailable. Your order was not placed.', 502);
    }
  }

  /** Authenticated callback from the gateway. */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, ip?: string) {
    if (!this.provider) throw notFound('Online payment is not enabled');
    const v = this.provider.verifyWebhook(rawBody, headers);
    if (!v.signatureOk) {
      await this.audit.log({ action: 'payment.webhook_rejected', ip, metadata: { reason: 'bad signature' } });
      throw new DomainError('INVALID_SIGNATURE', 'Invalid signature', 401);
    }
    let event = await this.prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: this.provider.name, eventId: v.eventId } } });
    if (event?.processedAt) return { duplicate: true };
    if (!event) {
      try {
        event = await this.prisma.paymentWebhookEvent.create({ data: { provider: this.provider.name, eventId: v.eventId, payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue, signatureOk: true } });
      } catch (e) {
        if (!isUnique(e)) throw e; // a concurrent identical delivery: processing below is safe to repeat
        event = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: this.provider.name, eventId: v.eventId } } });
      }
    }
    const pay = await this.prisma.payment.findFirst({ where: { provider: this.provider.name, providerRef: v.providerRef }, select: { id: true } });
    if (pay) {
      const status = await this.provider.fetchStatus(v.providerRef); // the authoritative answer
      await this.prisma.$transaction((tx) => this.applyOutcome(tx, pay.id, status));
    }
    await this.prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    return { processed: !!pay, duplicate: false };
  }

  /** Lost-callback safety net + payment timeout. Run every minute. */
  async reconcilePending(now = new Date()): Promise<number> {
    if (!this.provider) return 0;
    const timeoutMs = (await this.settings.get())['payments.pendingTimeoutMinutes'] * 60_000;
    const pending = await this.prisma.payment.findMany({
      where: { method: PaymentMethod.ONLINE, status: PaymentStatus.PENDING, initiatedAt: { lt: new Date(now.getTime() - 60_000) }, order: { status: OrderStatus.PENDING_PAYMENT } },
      orderBy: { initiatedAt: 'asc' }, take: 50, select: { id: true, orderId: true, providerRef: true, initiatedAt: true },
    });
    let changed = 0;
    for (const p of pending) {
      try {
        const st = p.providerRef ? await this.provider.fetchStatus(p.providerRef) : null;
        if (st && st.status !== 'PENDING') {
          await this.prisma.$transaction((tx) => this.applyOutcome(tx, p.id, st));
          changed++;
        } else if (now.getTime() - p.initiatedAt.getTime() > timeoutMs) {
          await this.transitions.transition({ orderId: p.orderId, to: OrderStatus.CANCELLED, actor: { role: 'SYSTEM' }, reason: 'Payment was not completed in time' }); // also cancels the pending payment
          changed++;
        }
      } catch (e) {
        if (!(e instanceof DomainError)) log.error(`reconcile ${p.id}: ${(e as Error).message}`);
      }
    }
    return changed;
  }

  /** Applies a provider-confirmed outcome inside a transaction. Safe to call any number of times. */
  async applyOutcome(tx: Db, paymentId: string, st: { status: 'PAID' | 'FAILED' | 'PENDING'; amountMinor: number; currency: string }): Promise<'APPLIED' | 'NOOP'> {
    await tx.$queryRaw`SELECT id FROM "payments" WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const pay = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${pay.orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: pay.orderId }, select: { status: true, customerId: true, orderNumber: true } });
    if (st.status === 'PENDING' || pay.status === PaymentStatus.SUCCESSFUL || pay.status === PaymentStatus.REFUNDED) return 'NOOP';
    const now = new Date();

    if (st.status === 'PAID') {
      if (st.amountMinor !== pay.amountMinor || st.currency !== pay.currency) {
        await tx.payment.update({ where: { id: pay.id }, data: { status: PaymentStatus.FAILED, failureReason: `AMOUNT_MISMATCH: expected ${pay.amountMinor} ${pay.currency}, gateway reports ${st.amountMinor} ${st.currency}` } });
        await this.audit.log({ action: 'payment.amount_mismatch', entityType: 'Payment', entityId: pay.id, metadata: { expected: pay.amountMinor, got: st.amountMinor } }, tx);
        if (order.status === OrderStatus.PENDING_PAYMENT) await this.transitions.applyInTx(tx, { orderId: pay.orderId, to: OrderStatus.PAYMENT_FAILED, actor: { role: 'SYSTEM' } });
        return 'APPLIED';
      }
      await tx.payment.update({ where: { id: pay.id }, data: { status: PaymentStatus.SUCCESSFUL, paidAt: now, failureReason: null } });
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        await this.transitions.applyInTx(tx, { orderId: pay.orderId, to: OrderStatus.PLACED, actor: { role: 'SYSTEM' } }); // restaurant + customer are notified by the transition
        await this.notifications.create(tx, { userId: order.customerId, type: 'PAYMENT', title: 'Payment received', body: `We received your payment for order #${order.orderNumber}.`, data: { orderId: pay.orderId } });
      } else {
        // The order ended (cancelled / timed out) before the money arrived: give it back.
        await autoRefundInTx(tx, pay.orderId, 'Payment arrived after the order had ended', now);
      }
      return 'APPLIED';
    }

    // FAILED
    await tx.payment.update({ where: { id: pay.id }, data: { status: PaymentStatus.FAILED, failureReason: 'Declined or abandoned at the gateway' } });
    if (order.status === OrderStatus.PENDING_PAYMENT) await this.transitions.applyInTx(tx, { orderId: pay.orderId, to: OrderStatus.PAYMENT_FAILED, actor: { role: 'SYSTEM' } });
    return 'APPLIED';
  }
}
