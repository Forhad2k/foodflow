import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ApprovalAction, applyApprovalAction } from '../restaurants/approval';
import { loadReadiness } from '../restaurants/readiness';
import { AdminListRestaurantsDto } from '../schemas/admin';
export class AdminRestaurantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async list(q: AdminListRestaurantsDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.RestaurantWhereInput = {
      ...(q.status && { approvalStatus: q.status }),
      ...(q.q && { OR: [
        { name: { contains: q.q, mode: 'insensitive' } },
        { city: { contains: q.q, mode: 'insensitive' } },
        { owner: { email: { contains: q.q.toLowerCase() } } },
      ] }),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.restaurant.count({ where }),
      this.prisma.restaurant.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: {
          id: true, name: true, slug: true, city: true, addressLine: true, phone: true, approvalStatus: true,
          isPaused: true, commissionBps: true, createdAt: true,
          owner: { select: { id: true, email: true, phone: true, profile: { select: { fullName: true } } } },
        },
      }),
    ]);
    return {
      items: await Promise.all(items.map(async (restaurant) => ({
        ...restaurant,
        readiness: await loadReadiness(this.prisma, restaurant.id),
        owner: { ...restaurant.owner, fullName: restaurant.owner.profile?.fullName ?? '' },
      }))),
      page, limit, total,
    };
  }

  async get(id: string) {
    const r = await this.prisma.restaurant.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, email: true, phone: true, profile: { select: { fullName: true } } } },
        cuisines: { select: { cuisine: { select: { name: true } } } },
      },
    });
    if (!r) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);
    const s = await this.settings.get();
    return {
      ...r,
      cuisines: r.cuisines.map((c) => c.cuisine.name),
      effectiveCommissionBps: r.commissionBps ?? s['commission.defaultBps'],
      readiness: await loadReadiness(this.prisma, id),
    };
  }

  /** One transaction: lock → validate transition → (for approve) check go-live readiness → update → audit. */
  async act(adminId: string, id: string, action: Exclude<ApprovalAction, 'resubmit'>, reason: string | undefined, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "restaurants" WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await tx.restaurant.findUnique({ where: { id }, select: { approvalStatus: true } });
      if (!r) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);

      const to = applyApprovalAction(r.approvalStatus, action, reason);
      if (action === 'approve') {
        const readiness = await loadReadiness(tx, id);
        if (!readiness.ready) throw new DomainError('RESTAURANT_NOT_READY', 'The restaurant is not ready to go live', 422, { missing: readiness.missing });
      }
      await tx.restaurant.update({
        where: { id },
        data: { approvalStatus: to, reviewedById: adminId, reviewedAt: new Date(), rejectionReason: action === 'reject' ? reason!.trim() : null },
      });
      await this.audit.log(
        { actorId: adminId, action: `restaurant.${action}`, entityType: 'Restaurant', entityId: id, ip, metadata: { from: r.approvalStatus, to, ...(reason && { reason: reason.trim() }) } },
        tx,
      );
      return { id, approvalStatus: to };
    });
  }

  async setCommission(adminId: string, id: string, commissionBps: number | null, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.restaurant.findUnique({ where: { id }, select: { commissionBps: true } });
      if (!r) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);
      await tx.restaurant.update({ where: { id }, data: { commissionBps } });
      await this.audit.log({ actorId: adminId, action: 'restaurant.set_commission', entityType: 'Restaurant', entityId: id, ip, metadata: { from: r.commissionBps, to: commissionBps } }, tx);
      return { id, commissionBps };
    });
  }
}
