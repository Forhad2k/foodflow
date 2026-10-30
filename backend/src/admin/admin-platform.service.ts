import { NotificationType, OrderStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { DomainError, forbidden, notFound } from '../common/errors/domain-error';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import { buildInsertServiceArea, buildListServiceAreasQuery, buildPolygonCheckQuery, MAX_ZONE_AREA_M2, ringToWkt, validateRing } from '../restaurants/zones.sql';
import { DEFAULT_SETTINGS } from '../settings/settings.defaults';
import type { SettingsService } from '../settings/settings.service';
import { isSettingKey, SETTING_SCHEMAS } from './settings-schema';

/** Back-office tools: users, operational statistics, audit trail, platform settings, service areas, promotions. */
export class AdminPlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly dispatch: DispatchService,
  ) {}

  // ───────── users ─────────
  async listUsers(q: { role?: Role; status?: UserStatus; q?: string; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.UserWhereInput = { ...(q.role && { role: q.role }), ...(q.status && { status: q.status }), ...(q.q && { OR: [{ email: { contains: q.q.toLowerCase() } }, { profile: { fullName: { contains: q.q, mode: 'insensitive' } } }] }) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { id: true, email: true, phone: true, role: true, status: true, createdAt: true, profile: { select: { fullName: true } } } }),
    ]);
    return { items, page, limit, total };
  }

  async getUser(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, phone: true, role: true, status: true, createdAt: true, profile: { select: { fullName: true } }, _count: { select: { orders: true, tickets: true, sessions: true } } } });
    if (!u) throw notFound('User not found');
    return u;
  }

  /** Suspending ends every session immediately. Admin accounts cannot be suspended through the API (and never by themselves). */
  async setUserStatus(adminId: string, id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string | undefined, ip?: string) {
    if (id === adminId) throw forbidden('You cannot change your own status');
    if (status === 'SUSPENDED' && !reason?.trim()) throw new DomainError('REASON_REQUIRED', 'A reason is required to suspend an account', 422);
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, select: { role: true, status: true } });
      if (!u) throw notFound('User not found');
      if (u.role === Role.ADMIN) throw forbidden('Admin accounts are managed outside the API');
      if (u.status === UserStatus.DELETED) throw new DomainError('USER_DELETED', 'This account was deleted', 409);
      await tx.user.update({ where: { id }, data: { status } });
      if (status === 'SUSPENDED') {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        if (u.role === Role.RIDER) {
          await tx.riderProfile.update({ where: { userId: id }, data: { isOnline: false, lastLat: null, lastLng: null, lastLocationAt: null } });
          await tx.deliveryAssignment.updateMany({ where: { riderId: id, status: 'OFFERED' }, data: { status: 'CANCELLED', respondedAt: new Date(), rejectReason: 'Rider suspended' } });
        }
      }
      await this.audit.log({ actorId: adminId, action: status === 'SUSPENDED' ? 'user.suspend' : 'user.reactivate', entityType: 'User', entityId: id, ip, metadata: { from: u.status, ...(reason && { reason: reason.trim() }) } }, tx);
      return { id, status };
    });
  }

  // ───────── operational statistics ─────────
  async stats(now = new Date()) {
    const day = new Date(now.getTime() - 86_400_000);
    const week = new Date(now.getTime() - 7 * 86_400_000);
    const delivered = (since: Date) => this.prisma.order.aggregate({ where: { status: OrderStatus.DELIVERED, deliveredAt: { gte: since } }, _count: true, _sum: { totalMinor: true } });
    const [byStatus, d1, d7, ridersOnline, ridersPending, restaurantsPending, ticketsOpen, refundsOpen, reportsOpen, stuck] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { placedAt: { gte: day } }, _count: true }),
      delivered(day), delivered(week),
      this.prisma.riderProfile.count({ where: { isOnline: true } }),
      this.prisma.riderProfile.count({ where: { approvalStatus: 'PENDING' } }),
      this.prisma.restaurant.count({ where: { approvalStatus: 'PENDING' } }),
      this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER'] } } }),
      this.prisma.refund.count({ where: { status: { in: ['REQUESTED', 'APPROVED', 'FAILED'] } } }),
      this.prisma.chatMessageReport.count({ where: { status: 'OPEN' } }),
      this.dispatch.stuckOrders(now),
    ]);
    return {
      generatedAt: now,
      orders: { last24h: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), deliveredLast24h: d1._count, deliveredLast7d: d7._count },
      gmvMinor: { last24h: d1._sum.totalMinor ?? 0, last7d: d7._sum.totalMinor ?? 0 },
      riders: { online: ridersOnline, pendingApproval: ridersPending },
      needsAttention: { restaurantsPendingApproval: restaurantsPending, ridersPendingApproval: ridersPending, openTickets: ticketsOpen, refundsToAction: refundsOpen, chatReportsOpen: reportsOpen, ordersWithoutRider: stuck.length },
    };
  }

  // ───────── audit trail ─────────
  async auditLogs(q: { action?: string; actorId?: string; entityType?: string; entityId?: string; from?: Date; to?: Date; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action && { action: { startsWith: q.action } }), ...(q.actorId && { actorId: q.actorId }), ...(q.entityType && { entityType: q.entityType }), ...(q.entityId && { entityId: q.entityId }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, action: true, entityType: true, entityId: true, metadata: true, ip: true, createdAt: true, actor: { select: { id: true, email: true, role: true } } } }),
    ]);
    return { items, page, limit, total };
  }

  // ───────── platform settings ─────────
  async getSettings() {
    const effective = await this.settings.get();
    const rows = await this.prisma.platformSetting.findMany({ select: { key: true, updatedAt: true } });
    const changed = new Map(rows.map((r) => [r.key, r.updatedAt]));
    return Object.entries(effective).map(([key, value]) => ({ key, value, default: DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS], customised: changed.has(key), updatedAt: changed.get(key) ?? null }));
  }

  async setSetting(adminId: string, key: string, value: unknown, ip?: string) {
    if (!isSettingKey(key)) throw new DomainError('UNKNOWN_SETTING', `"${key}" is not a platform setting`, 404);
    const parsed = SETTING_SCHEMAS[key].safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_SETTING', 'Value is not allowed for this setting', 422, parsed.error.issues.map((i) => i.message));
    const before = (await this.settings.get())[key];
    await this.prisma.$transaction(async (tx) => {
      await tx.platformSetting.upsert({ where: { key }, update: { value: parsed.data as Prisma.InputJsonValue, updatedBy: adminId }, create: { key, value: parsed.data as Prisma.InputJsonValue, updatedBy: adminId } });
      await this.audit.log({ actorId: adminId, action: 'settings.update', entityType: 'PlatformSetting', entityId: key, ip, metadata: { before: before as Prisma.InputJsonValue, after: parsed.data as Prisma.InputJsonValue } }, tx);
    });
    this.settings.invalidate(); // other instances pick it up within 30 s
    return { key, value: parsed.data };
  }

  // ───────── service areas ─────────
  listServiceAreas() {
    return this.prisma.$queryRaw(buildListServiceAreasQuery());
  }
  async createServiceArea(adminId: string, input: { name: string; polygon: [number, number][] }, ip?: string) {
    const bad = validateRing(input.polygon);
    if (bad) throw new DomainError('INVALID_POLYGON', `Service area is not valid: ${bad}`, 422);
    const wkt = ringToWkt(input.polygon);
    const [check] = await this.prisma.$queryRaw<{ valid: boolean; reason: string; area: number | null }[]>(buildPolygonCheckQuery(wkt));
    if (!check?.valid) throw new DomainError('INVALID_POLYGON', `Service area is not valid: ${check?.reason}`, 422);
    if ((check.area ?? 0) > MAX_ZONE_AREA_M2 * 4) throw new DomainError('AREA_TOO_LARGE', 'Service area is too large', 422);
    if (await this.prisma.serviceArea.findUnique({ where: { name: input.name.trim() }, select: { id: true } })) throw new DomainError('AREA_NAME_TAKEN', 'A service area with that name exists', 409);
    const [row] = await this.prisma.$queryRaw<{ id: string }[]>(buildInsertServiceArea(input.name.trim(), wkt));
    await this.audit.log({ actorId: adminId, action: 'service_area.create', entityType: 'ServiceArea', entityId: row.id, ip });
    return { id: row.id };
  }
  /** NOTE: once ANY area is active, addresses outside every active area get no restaurants. Deactivate all to lift the restriction. */
  async setServiceAreaActive(adminId: string, id: string, isActive: boolean, ip?: string) {
    const res = await this.prisma.serviceArea.updateMany({ where: { id }, data: { isActive } });
    if (res.count === 0) throw notFound('Service area not found');
    await this.audit.log({ actorId: adminId, action: isActive ? 'service_area.activate' : 'service_area.deactivate', entityType: 'ServiceArea', entityId: id, ip });
    return { id, isActive };
  }
  async deleteServiceArea(adminId: string, id: string, ip?: string) {
    const res = await this.prisma.serviceArea.deleteMany({ where: { id } });
    if (res.count === 0) throw notFound('Service area not found');
    await this.audit.log({ actorId: adminId, action: 'service_area.delete', entityType: 'ServiceArea', entityId: id, ip });
  }

  // ───────── promotions (only to users who opted in) ─────────
  async broadcastPromotion(adminId: string, input: { title: string; body: string; role?: Role; limit?: number }, ip?: string) {
    const users = await this.prisma.user.findMany({
      where: { status: UserStatus.ACTIVE, profile: { marketingConsent: true }, ...(input.role && { role: input.role }) },
      select: { id: true }, take: input.limit ?? 1000, orderBy: { createdAt: 'asc' },
    });
    for (let i = 0; i < users.length; i += 200) {
      await this.prisma.$transaction(async (tx) => {
        for (const u of users.slice(i, i + 200)) await this.notifications.create(tx, { userId: u.id, type: NotificationType.PROMOTION, title: input.title.trim(), body: input.body.trim() });
      });
    }
    await this.audit.log({ actorId: adminId, action: 'promotion.broadcast', ip, metadata: { recipients: users.length, title: input.title.trim() } });
    return { recipients: users.length };
  }
}
