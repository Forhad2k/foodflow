import { CouponType, Prisma } from '@prisma/client';
import { DomainError, notFound } from '../common/errors/domain-error';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';

export interface CouponInput {
  code: string; type: CouponType; value: number; maxDiscountMinor?: number | null; minSubtotalMinor?: number; startsAt: Date; endsAt: Date;
  usageLimitTotal?: number | null; usageLimitPerUser?: number; firstOrderOnly?: boolean; isActive?: boolean;
}

/** Pure rules for a coupon definition. `owner` = created by a restaurant owner, who gets tighter limits. */
export function validateCoupon(c: CouponInput, who: 'ADMIN' | 'OWNER'): string | null {
  if (!(c.startsAt < c.endsAt)) return 'The end date must be after the start date';
  if (c.type === CouponType.PERCENTAGE && (c.value < 1 || c.value > 100)) return 'A percentage discount must be between 1 and 100';
  if (c.type === CouponType.FIXED_AMOUNT && c.value < 1) return 'A fixed discount must be positive';
  if (c.type === CouponType.FREE_DELIVERY && c.value !== 0) return 'A free-delivery coupon has no value';
  if (c.type === CouponType.PERCENTAGE && c.maxDiscountMinor == null && who === 'OWNER') return 'Set a maximum discount for percentage coupons';
  if (who === 'OWNER' && c.type === CouponType.PERCENTAGE && c.value > 50) return 'Restaurants can offer at most 50% off';
  if (who === 'OWNER' && c.usageLimitTotal == null) return 'Set a total usage limit';
  return null;
}

export class CouponService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** scope.restaurantId = a restaurant's own coupon (owner-created, restaurant-funded); undefined = platform-wide (admin only). */
  async create(actor: { id: string; role: 'ADMIN' | 'OWNER' }, scope: { restaurantId?: string }, dto: CouponInput) {
    const code = dto.code.trim().toUpperCase();
    const problem = validateCoupon(dto, actor.role);
    if (problem) throw new DomainError('INVALID_COUPON', problem, 422);
    if (scope.restaurantId && actor.role === 'OWNER' && (await this.prisma.coupon.count({ where: { restaurantId: scope.restaurantId, isActive: true } })) >= 20) {
      throw new DomainError('COUPON_LIMIT', 'A restaurant can have up to 20 active coupons', 422);
    }
    try {
      const c = await this.prisma.coupon.create({
        data: { code, type: dto.type, value: dto.value, maxDiscountMinor: dto.maxDiscountMinor ?? null, minSubtotalMinor: dto.minSubtotalMinor ?? 0, startsAt: dto.startsAt, endsAt: dto.endsAt, usageLimitTotal: dto.usageLimitTotal ?? null, usageLimitPerUser: dto.usageLimitPerUser ?? 1, firstOrderOnly: dto.firstOrderOnly ?? false, isActive: dto.isActive ?? true, restaurantId: scope.restaurantId ?? null },
      });
      await this.audit.log({ actorId: actor.id, action: 'coupon.create', entityType: 'Coupon', entityId: c.id, metadata: { code, restaurantId: scope.restaurantId ?? null } });
      return c;
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new DomainError('COUPON_CODE_TAKEN', 'That coupon code already exists', 409);
      throw e;
    }
  }

  async list(scope: { restaurantId?: string | null; all?: boolean }, q: { page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.CouponWhereInput = scope.all ? {} : { restaurantId: scope.restaurantId ?? null };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.coupon.count({ where }),
      this.prisma.coupon.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, include: { _count: { select: { redemptions: true } } } }),
    ]);
    return { items: items.map(({ _count, ...c }) => ({ ...c, redemptions: _count.redemptions })), page, limit, total };
  }

  /** Once a coupon has been used, its code, type, value and owner are frozen: only limits, dates and the active flag change. */
  async update(actor: { id: string; role: 'ADMIN' | 'OWNER' }, scope: { restaurantId?: string }, id: string, dto: Partial<CouponInput>) {
    const existing = await this.prisma.coupon.findFirst({ where: { id, ...(actor.role === 'OWNER' ? { restaurantId: scope.restaurantId } : {}) }, include: { _count: { select: { redemptions: true } } } });
    if (!existing) throw notFound('Coupon not found'); // another restaurant's coupon is "not found"
    const frozen = existing._count.redemptions > 0;
    if (frozen && (dto.code !== undefined || dto.type !== undefined || dto.value !== undefined || dto.maxDiscountMinor !== undefined)) throw new DomainError('COUPON_IN_USE', 'This coupon has been used: you can change its dates, limits and active flag only', 409);
    const merged: CouponInput = { code: dto.code ?? existing.code, type: dto.type ?? existing.type, value: dto.value ?? existing.value, maxDiscountMinor: dto.maxDiscountMinor !== undefined ? dto.maxDiscountMinor : existing.maxDiscountMinor, minSubtotalMinor: dto.minSubtotalMinor ?? existing.minSubtotalMinor, startsAt: dto.startsAt ?? existing.startsAt, endsAt: dto.endsAt ?? existing.endsAt, usageLimitTotal: dto.usageLimitTotal !== undefined ? dto.usageLimitTotal : existing.usageLimitTotal };
    const problem = validateCoupon(merged, actor.role);
    if (problem) throw new DomainError('INVALID_COUPON', problem, 422);
    if (dto.usageLimitTotal != null && dto.usageLimitTotal < existing._count.redemptions) throw new DomainError('INVALID_COUPON', 'The limit cannot be lower than the uses so far', 422);
    const { code, ...rest } = dto;
    const c = await this.prisma.coupon.update({ where: { id }, data: { ...rest, ...(code && { code: code.trim().toUpperCase() }) } });
    await this.audit.log({ actorId: actor.id, action: 'coupon.update', entityType: 'Coupon', entityId: id, metadata: { fields: Object.keys(dto) } });
    return c;
  }
}
