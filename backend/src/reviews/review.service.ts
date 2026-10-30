import { AssignmentStatus, OrderStatus } from '@prisma/client';
import { DomainError, notFound } from '../common/errors/domain-error';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/** Verified-purchase reviews: only the customer of a DELIVERED order, once, within a window. Aggregates update atomically. */
export class ReviewService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async create(customerId: string, orderId: string, input: { restaurantRating: number; riderRating?: number; comment?: string }) {
    const s = await this.settings.get();
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, customerId },
        select: { restaurantId: true, status: true, deliveredAt: true, review: { select: { id: true } }, assignments: { where: { status: AssignmentStatus.COMPLETED }, select: { riderId: true }, take: 1 } },
      });
      if (!order) throw notFound('Order not found');
      if (order.status !== OrderStatus.DELIVERED || !order.deliveredAt) throw new DomainError('NOT_REVIEWABLE', 'You can review an order once it has been delivered', 409);
      if (order.review) throw new DomainError('ALREADY_REVIEWED', 'You already reviewed this order', 409);
      if (Date.now() - order.deliveredAt.getTime() > s['reviews.windowDays'] * 86_400_000) throw new DomainError('REVIEW_WINDOW_CLOSED', `Reviews can be left within ${s['reviews.windowDays']} days of delivery`, 409);
      const riderId = order.assignments[0]?.riderId ?? null;
      if (input.riderRating !== undefined && !riderId) throw new DomainError('NO_RIDER_TO_RATE', 'This order had no rider to rate', 422);

      let review;
      try {
        review = await tx.review.create({ data: { orderId, customerId, restaurantId: order.restaurantId, riderId, restaurantRating: input.restaurantRating, riderRating: input.riderRating ?? null, comment: input.comment?.trim() || null }, select: { id: true, restaurantRating: true, riderRating: true, comment: true, createdAt: true } });
      } catch (e) {
        if (isUnique(e)) throw new DomainError('ALREADY_REVIEWED', 'You already reviewed this order', 409);
        throw e;
      }
      // One atomic statement each: concurrent reviews cannot lose an update.
      await tx.$executeRaw`UPDATE "restaurants" SET "ratingAvg" = ("ratingAvg" * "ratingCount" + ${input.restaurantRating}::float8) / ("ratingCount" + 1), "ratingCount" = "ratingCount" + 1 WHERE id = ${order.restaurantId}::uuid`;
      if (riderId && input.riderRating !== undefined) {
        await tx.$executeRaw`UPDATE "rider_profiles" SET "ratingAvg" = ("ratingAvg" * "ratingCount" + ${input.riderRating}::float8) / ("ratingCount" + 1), "ratingCount" = "ratingCount" + 1 WHERE "userId" = ${riderId}::uuid`;
      }
      return review;
    });
  }

  /** Public list for an APPROVED restaurant. Reviewers appear as "First L." only. */
  async forRestaurant(restaurantId: string, q: { page?: number; limit?: number }, opts: { requireApproved: boolean }) {
    const r = await this.prisma.restaurant.findFirst({ where: { id: restaurantId, ...(opts.requireApproved && { approvalStatus: 'APPROVED' }) }, select: { id: true, ratingAvg: true, ratingCount: true } });
    if (!r) throw notFound('Restaurant not found');
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where: { restaurantId } }),
      this.prisma.review.findMany({ where: { restaurantId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { id: true, restaurantRating: true, comment: true, createdAt: true, customer: { select: { profile: { select: { fullName: true } } } } } }),
    ]);
    return {
      rating: { average: Math.round(r.ratingAvg * 100) / 100, count: r.ratingCount },
      items: rows.map((x) => ({ id: x.id, rating: x.restaurantRating, comment: x.comment, createdAt: x.createdAt, reviewer: shortName(x.customer.profile?.fullName) })),
      page, limit, total,
    };
  }
}

export function shortName(full?: string | null): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Customer';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
