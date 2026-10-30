import { PayoutStatus, Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { DomainError, notFound } from '../common/errors/domain-error';
import type { PrismaService } from '../prisma/prisma.service';
import { utc } from '../dispatch/dispatch.sql';

/**
 * Earnings → payouts → reconciliation.
 *  - Restaurant payout = Σ net earnings (food − commission − any discount the restaurant funded), paid to the owner.
 *  - Rider payout = Σ delivery-fee share − Σ cash-on-delivery money the rider collected. NEGATIVE means the rider owes
 *    the platform that cash; "paid" then means it was collected.
 *  - Platform-wide coupons are platform-funded; restaurant coupons are restaurant-funded.
 *  - Refunds after delivery are borne by the platform unless an admin adjusts a payout manually (not automated).
 */
export class PayoutService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Bundles all unpaid earnings created in [from, to) into one payout per payee. `to` must be in the past so nothing can slip in. */
  async generate(adminId: string, periodStart: Date, periodEnd: Date, ip?: string) {
    if (!(periodStart < periodEnd) || periodEnd > new Date()) throw new DomainError('INVALID_PERIOD', 'The period must end in the past and start before it ends', 422);
    return this.prisma.$transaction(async (tx) => {
      const range = { payoutId: null, createdAt: { gte: periodStart, lt: periodEnd } };
      const created: { id: string; payeeId: string; payeeRole: Role; amountMinor: number }[] = [];

      const byRestaurant = await tx.restaurantEarning.groupBy({ by: ['restaurantId'], where: range, _sum: { netMinor: true } });
      const owners = new Map((await tx.restaurant.findMany({ where: { id: { in: byRestaurant.map((r) => r.restaurantId) } }, select: { id: true, ownerId: true } })).map((r) => [r.id, r.ownerId]));
      const perOwner = new Map<string, { amount: number; restaurantIds: string[] }>();
      for (const r of byRestaurant) {
        const o = owners.get(r.restaurantId)!;
        const cur = perOwner.get(o) ?? { amount: 0, restaurantIds: [] };
        cur.amount += r._sum.netMinor ?? 0;
        cur.restaurantIds.push(r.restaurantId);
        perOwner.set(o, cur);
      }
      for (const [ownerId, v] of perOwner) {
        const p = await tx.payout.create({ data: { payeeId: ownerId, payeeRole: Role.RESTAURANT_OWNER, amountMinor: v.amount, periodStart, periodEnd }, select: { id: true } });
        await tx.restaurantEarning.updateMany({ where: { ...range, restaurantId: { in: v.restaurantIds } }, data: { payoutId: p.id } });
        created.push({ id: p.id, payeeId: ownerId, payeeRole: Role.RESTAURANT_OWNER, amountMinor: v.amount });
      }

      const byRider = await tx.riderEarning.groupBy({ by: ['riderId'], where: range, _sum: { amountMinor: true, cashCollectedMinor: true } });
      for (const r of byRider) {
        const amount = (r._sum.amountMinor ?? 0) - (r._sum.cashCollectedMinor ?? 0); // negative: the rider owes the platform
        const p = await tx.payout.create({ data: { payeeId: r.riderId, payeeRole: Role.RIDER, amountMinor: amount, periodStart, periodEnd }, select: { id: true } });
        await tx.riderEarning.updateMany({ where: { ...range, riderId: r.riderId }, data: { payoutId: p.id } });
        created.push({ id: p.id, payeeId: r.riderId, payeeRole: Role.RIDER, amountMinor: amount });
      }
      await this.audit.log({ actorId: adminId, action: 'payout.generate', ip, metadata: { from: periodStart.toISOString(), to: periodEnd.toISOString(), payouts: created.length } }, tx);
      return { payouts: created };
    });
  }

  async list(q: { status?: PayoutStatus; role?: Role; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.PayoutWhereInput = { ...(q.status && { status: q.status }), ...(q.role && { payeeRole: q.role }) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.payout.count({ where }),
      this.prisma.payout.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { items, page, limit, total };
  }

  async markPaid(adminId: string, payoutId: string, reference: string, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payout.updateMany({ where: { id: payoutId, status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING, PayoutStatus.FAILED] } }, data: { status: PayoutStatus.PAID, paidAt: new Date(), reference: reference.trim() } });
      if (claimed.count === 0) {
        if (!(await tx.payout.findUnique({ where: { id: payoutId }, select: { id: true } }))) throw notFound('Payout not found');
        throw new DomainError('ALREADY_PAID', 'This payout is already paid', 409);
      }
      await this.audit.log({ actorId: adminId, action: 'payout.mark_paid', entityType: 'Payout', entityId: payoutId, ip, metadata: { reference } }, tx);
      return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
    });
  }

  // ───────── what payees see ─────────
  async restaurantEarnings(restaurantId: string, q: { page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const [total, items, unpaid, paid] = await this.prisma.$transaction([
      this.prisma.restaurantEarning.count({ where: { restaurantId } }),
      this.prisma.restaurantEarning.findMany({ where: { restaurantId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { orderId: true, grossMinor: true, commissionMinor: true, netMinor: true, payoutId: true, createdAt: true, order: { select: { orderNumber: true } } } }),
      this.prisma.restaurantEarning.aggregate({ where: { restaurantId, payoutId: null }, _sum: { netMinor: true } }),
      this.prisma.restaurantEarning.aggregate({ where: { restaurantId, payoutId: { not: null } }, _sum: { netMinor: true } }),
    ]);
    return { items, page, limit, total, unpaidNetMinor: unpaid._sum.netMinor ?? 0, includedInPayoutsMinor: paid._sum.netMinor ?? 0 };
  }

  async riderEarnings(riderId: string, q: { page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const [total, items, unpaid] = await this.prisma.$transaction([
      this.prisma.riderEarning.count({ where: { riderId } }),
      this.prisma.riderEarning.findMany({ where: { riderId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { orderId: true, amountMinor: true, cashCollectedMinor: true, payoutId: true, createdAt: true, order: { select: { orderNumber: true } } } }),
      this.prisma.riderEarning.aggregate({ where: { riderId, payoutId: null }, _sum: { amountMinor: true, cashCollectedMinor: true } }),
    ]);
    const earned = unpaid._sum.amountMinor ?? 0;
    const cash = unpaid._sum.cashCollectedMinor ?? 0;
    return { items, page, limit, total, unpaidEarningsMinor: earned, cashToRemitMinor: cash, netUnpaidMinor: earned - cash };
  }

  payoutsFor(payeeId: string) {
    return this.prisma.payout.findMany({ where: { payeeId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, amountMinor: true, status: true, periodStart: true, periodEnd: true, paidAt: true, reference: true } });
  }

  // ───────── reconciliation ─────────
  /** Orders ↔ payments ↔ refunds ↔ earnings must agree. Anything listed here needs a human. */
  async reconcile(from: Date, to: Date) {
    const range = Prisma.sql`o."placedAt" >= ${utc(from)} AND o."placedAt" < ${utc(to)}`;
    const issues = await this.prisma.$queryRaw<{ orderId: string; orderNumber: string; issue: string }[]>(Prisma.sql`
      SELECT o.id AS "orderId", o."orderNumber", 'DELIVERED_WITHOUT_EARNING' AS issue FROM orders o
        LEFT JOIN restaurant_earnings e ON e."orderId" = o.id WHERE o.status = 'DELIVERED' AND e.id IS NULL AND ${range}
      UNION ALL
      SELECT o.id, o."orderNumber", 'PAYMENT_AMOUNT_MISMATCH' FROM payments p JOIN orders o ON o.id = p."orderId"
        WHERE p.status IN ('SUCCESSFUL','REFUNDED') AND p."amountMinor" <> o."totalMinor" AND ${range}
      UNION ALL
      SELECT o.id, o."orderNumber", 'PAID_ORDER_ENDED_WITHOUT_REFUND' FROM payments p JOIN orders o ON o.id = p."orderId"
        WHERE p.method = 'ONLINE' AND p.status = 'SUCCESSFUL' AND o.status IN ('CANCELLED','REJECTED_BY_RESTAURANT','DELIVERY_FAILED','PAYMENT_FAILED')
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r."paymentId" = p.id AND r.status IN ('APPROVED','PROCESSED')) AND ${range}
      UNION ALL
      SELECT o.id, o."orderNumber", 'REFUNDS_EXCEED_PAYMENT' FROM payments p JOIN orders o ON o.id = p."orderId"
        WHERE (SELECT COALESCE(SUM(r."amountMinor"), 0) FROM refunds r WHERE r."paymentId" = p.id AND r.status IN ('REQUESTED','APPROVED','PROCESSED')) > p."amountMinor" AND ${range}
      UNION ALL
      SELECT o.id, o."orderNumber", 'PAID_BUT_STILL_PENDING_PAYMENT' FROM payments p JOIN orders o ON o.id = p."orderId"
        WHERE p.status = 'SUCCESSFUL' AND o.status = 'PENDING_PAYMENT' AND ${range}
      UNION ALL
      SELECT o.id, o."orderNumber", 'DELIVERED_COD_PAYMENT_NOT_COLLECTED' FROM payments p JOIN orders o ON o.id = p."orderId"
        WHERE p.method = 'CASH_ON_DELIVERY' AND p.status = 'PENDING' AND o.status = 'DELIVERED' AND ${range}`);

    const [s] = await this.prisma.$queryRaw<{ orders: number; gmv: number; food: number; delivery: number; service: number; discounts: number; platformFundedDiscounts: number; commission: number; riderEarnings: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS orders, COALESCE(SUM(o."totalMinor"),0)::float8 AS gmv, COALESCE(SUM(o."subtotalMinor"),0)::float8 AS food,
             COALESCE(SUM(o."deliveryFeeMinor"),0)::float8 AS delivery, COALESCE(SUM(o."serviceFeeMinor"),0)::float8 AS service,
             COALESCE(SUM(o."discountMinor"),0)::float8 AS discounts,
             COALESCE(SUM(o."discountMinor") FILTER (WHERE c."restaurantId" IS NULL),0)::float8 AS "platformFundedDiscounts",
             COALESCE(SUM(e."commissionMinor"),0)::float8 AS commission, COALESCE(SUM(re.amount),0)::float8 AS "riderEarnings"
      FROM orders o LEFT JOIN coupons c ON c.id = o."couponId"
        LEFT JOIN restaurant_earnings e ON e."orderId" = o.id
        LEFT JOIN (SELECT "orderId", SUM("amountMinor") AS amount FROM rider_earnings GROUP BY "orderId") re ON re."orderId" = o.id
      WHERE o.status = 'DELIVERED' AND ${range}`);
    const platformNetMinor = s.commission + s.service + (s.delivery - s.riderEarnings) - s.platformFundedDiscounts;
    return { from, to, ok: issues.length === 0, issues, summary: { deliveredOrders: s.orders, gmvMinor: s.gmv, foodMinor: s.food, deliveryFeesMinor: s.delivery, serviceFeesMinor: s.service, discountsMinor: s.discounts, commissionMinor: s.commission, riderEarningsMinor: s.riderEarnings, platformNetMinor } };
  }
}
