import { ApprovalStatus, Prisma, ZoneType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { DomainError } from '../common/errors/domain-error';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { applyApprovalAction } from './approval';
import { loadReadiness } from './readiness';
import { CreateRestaurantDto, CreateZoneDto, SetHoursDto, StatsQueryDto, UpdateRestaurantDto, UpdateZoneDto } from '../schemas/restaurants';
import { validateHours } from './hours.validation';
import { assertImageUrls } from './image-urls';
import { RestaurantAccessService } from './restaurant-access.service';
import {
  buildInsertPolygonZone, buildListZonesQuery, buildPolygonCheckQuery, buildSalesSummaryQuery, MAX_ZONE_AREA_M2, ringToWkt, validateRing,
} from './zones.sql';

const MAX_RESTAURANTS_PER_OWNER = 5;
const MAX_ZONES = 10;

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50) || 'restaurant';
export class OwnerRestaurantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly config: Env,
  ) {}

  private get imageHosts() {
    return this.config.IMAGE_HOST_ALLOWLIST;
  }

  async list(ownerId: string) {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, slug: true, phone: true, addressLine: true, city: true, lat: true, lng: true,
        approvalStatus: true, rejectionReason: true, isPaused: true, logoUrl: true, coverUrl: true,
        description: true, priceTier: true, avgPrepMinutes: true, minOrderMinor: true, baseDeliveryFeeMinor: true,
        cuisines: { select: { cuisine: { select: { id: true, name: true, slug: true } } } },
      },
    });
    return Promise.all(restaurants.map(async ({ cuisines, ...restaurant }) => ({
      ...restaurant,
      cuisines: cuisines.map(({ cuisine }) => cuisine),
      readiness: await this.readiness(restaurant.id),
    })));
  }

  async get(ownerId: string, id: string) {
    await this.access.assertOwner(ownerId, id);
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id },
      include: {
        cuisines: { select: { cuisine: { select: { id: true, name: true, slug: true } } } },
        hours: { orderBy: [{ dayOfWeek: 'asc' }, { opensAtMin: 'asc' }], select: { dayOfWeek: true, opensAtMin: true, closesAtMin: true } },
      },
    });
    const { commissionBps: _internal, reviewedById: _rb, ...rest } = r; // commission is negotiated with admin, not shown here
    return { ...rest, cuisines: r.cuisines.map((c) => c.cuisine), readiness: await this.readiness(id) };
  }

  /** Setup checklist shown to the owner; the same facts gate admin approval. */
  readiness(restaurantId: string) {
    return loadReadiness(this.prisma, restaurantId);
  }

  async create(ownerId: string, dto: CreateRestaurantDto) {
    assertImageUrls([dto.logoUrl, dto.coverUrl].filter((x): x is string => !!x), this.imageHosts, 2);
    const { cuisineIds, ...fields } = dto;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${ownerId}::uuid FOR UPDATE`; // serialise the per-owner cap
      if ((await tx.restaurant.count({ where: { ownerId } })) >= MAX_RESTAURANTS_PER_OWNER) {
        throw new DomainError('RESTAURANT_LIMIT', `You can register up to ${MAX_RESTAURANTS_PER_OWNER} restaurants`, 422);
      }
      await this.assertCuisines(tx, cuisineIds);
      let slug = slugify(dto.name);
      while (await tx.restaurant.findUnique({ where: { slug }, select: { id: true } })) slug = `${slugify(dto.name)}-${randomBytes(2).toString('hex')}`;
      const restaurant = await tx.restaurant.create({
        data: { ...fields, ownerId, slug, approvalStatus: ApprovalStatus.PENDING, cuisines: { create: cuisineIds.map((cuisineId) => ({ cuisineId })) } },
        select: { id: true, name: true, slug: true, approvalStatus: true },
      });
      await this.audit.log({ actorId: ownerId, action: 'restaurant.create', entityType: 'Restaurant', entityId: restaurant.id }, tx);
      return restaurant;
    });
  }

  async update(ownerId: string, id: string, dto: UpdateRestaurantDto) {
    await this.access.assertOwner(ownerId, id);
    assertImageUrls([dto.logoUrl, dto.coverUrl].filter((x): x is string => !!x), this.imageHosts, 2);
    const { cuisineIds, ...fields } = dto;
    await this.prisma.$transaction(async (tx) => {
      if (cuisineIds) {
        await this.assertCuisines(tx, cuisineIds);
        await tx.restaurantCuisine.deleteMany({ where: { restaurantId: id } });
        await tx.restaurantCuisine.createMany({ data: cuisineIds.map((cuisineId) => ({ restaurantId: id, cuisineId })) });
      }
      if (Object.keys(fields).length) await tx.restaurant.update({ where: { id }, data: fields }); // slug is stable: links never break
    });
    return this.get(ownerId, id);
  }

  /** Temporarily stop/start taking orders. Does not touch orders already accepted. */
  async setPaused(ownerId: string, id: string, isPaused: boolean) {
    await this.access.assertOwner(ownerId, id);
    await this.prisma.restaurant.update({ where: { id }, data: { isPaused } });
    return { id, isPaused };
  }

  /** Rejected → pending again, after the owner has fixed what the admin flagged. */
  async resubmit(ownerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "restaurants" WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await this.access.assertOwner(ownerId, id, tx);
      const to = applyApprovalAction(r.approvalStatus, 'resubmit');
      await tx.restaurant.update({ where: { id }, data: { approvalStatus: to, rejectionReason: null } });
      await this.audit.log({ actorId: ownerId, action: 'restaurant.resubmit', entityType: 'Restaurant', entityId: id }, tx);
      return { id, approvalStatus: to };
    });
  }

  // ───────────── hours ─────────────
  async setHours(ownerId: string, id: string, dto: SetHoursDto) {
    await this.access.assertOwner(ownerId, id);
    const problem = validateHours(dto.hours);
    if (problem) throw new DomainError('INVALID_HOURS', `Opening hours are not valid: ${problem}`, 422);
    await this.prisma.$transaction([
      this.prisma.operatingHour.deleteMany({ where: { restaurantId: id } }),
      this.prisma.operatingHour.createMany({ data: dto.hours.map((h) => ({ ...h, restaurantId: id })) }),
    ]);
    return { hours: dto.hours };
  }

  // ───────────── delivery zones ─────────────
  async listZones(ownerId: string, id: string) {
    await this.access.assertOwner(ownerId, id);
    return this.prisma.$queryRaw(buildListZonesQuery(id));
  }

  async createZone(ownerId: string, id: string, dto: CreateZoneDto) {
    await this.access.assertOwner(ownerId, id);
    if ((await this.prisma.deliveryZone.count({ where: { restaurantId: id } })) >= MAX_ZONES) {
      throw new DomainError('ZONE_LIMIT', `A restaurant can have up to ${MAX_ZONES} delivery zones`, 422);
    }
    if (dto.type === ZoneType.RADIUS) {
      const zone = await this.prisma.deliveryZone.create({
        data: { restaurantId: id, name: dto.name, type: ZoneType.RADIUS, radiusMeters: dto.radiusMeters, deliveryFeeMinor: dto.deliveryFeeMinor, minOrderMinor: dto.minOrderMinor },
        select: { id: true },
      });
      return { id: zone.id };
    }
    const ringProblem = validateRing(dto.polygon);
    if (ringProblem) throw new DomainError('INVALID_POLYGON', `Delivery area is not valid: ${ringProblem}`, 422);
    const wkt = ringToWkt(dto.polygon!);
    const [check] = await this.prisma.$queryRaw<{ valid: boolean; reason: string; area: number | null }[]>(buildPolygonCheckQuery(wkt));
    if (!check?.valid) throw new DomainError('INVALID_POLYGON', `Delivery area is not valid: ${check?.reason ?? 'unknown'}`, 422);
    if ((check.area ?? 0) > MAX_ZONE_AREA_M2) throw new DomainError('ZONE_TOO_LARGE', 'Delivery area is too large (max 5,000 km²)', 422);
    const [row] = await this.prisma.$queryRaw<{ id: string }[]>(
      buildInsertPolygonZone({ restaurantId: id, name: dto.name, wkt, deliveryFeeMinor: dto.deliveryFeeMinor ?? null, minOrderMinor: dto.minOrderMinor ?? null }),
    );
    return { id: row.id };
  }

  async updateZone(ownerId: string, id: string, zoneId: string, dto: UpdateZoneDto) {
    await this.access.assertOwner(ownerId, id);
    const zone = await this.prisma.deliveryZone.findFirst({ where: { id: zoneId, restaurantId: id }, select: { type: true } });
    if (!zone) throw new DomainError('ZONE_NOT_FOUND', 'Delivery zone not found', 404);
    if (dto.radiusMeters !== undefined && zone.type !== ZoneType.RADIUS) {
      throw new DomainError('NOT_A_RADIUS_ZONE', 'Polygon zones cannot be resized: delete and redraw them', 422);
    }
    await this.prisma.deliveryZone.update({ where: { id: zoneId }, data: dto });
    return { id: zoneId };
  }

  async deleteZone(ownerId: string, id: string, zoneId: string) {
    await this.access.assertOwner(ownerId, id);
    const res = await this.prisma.deliveryZone.deleteMany({ where: { id: zoneId, restaurantId: id } });
    if (res.count === 0) throw new DomainError('ZONE_NOT_FOUND', 'Delivery zone not found', 404);
  }

  // ───────────── sales ─────────────
  async stats(ownerId: string, id: string, q: StatsQueryDto) {
    const r = await this.access.assertOwner(ownerId, id);
    const to = q.to ?? new Date(Date.now() + 1000);
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new DomainError('INVALID_RANGE', 'from must be before to', 422);
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new DomainError('RANGE_TOO_LARGE', 'Choose a range of at most one year', 422);
    const [s] = await this.prisma.$queryRaw<{ deliveredCount: number; cancelledCount: number; inProgressCount: number; grossMinor: number; commissionMinor: number }[]>(
      buildSalesSummaryQuery(id, from, to),
    );
    return {
      from, to, currency: 'BDT',
      ordersDelivered: s.deliveredCount, ordersCancelled: s.cancelledCount, ordersInProgress: s.inProgressCount,
      grossSalesMinor: s.grossMinor, // food subtotal of delivered orders (before platform discounts)
      commissionMinor: s.commissionMinor,
      netMinor: s.grossMinor - s.commissionMinor,
      rating: { average: r.ratingAvg, count: r.ratingCount },
      // Payout schedule and coupon funding are settled with the payments module (Phase 7).
    };
  }

  private async assertCuisines(tx: Prisma.TransactionClient, ids: string[]) {
    const unique = [...new Set(ids)];
    if ((await tx.cuisineType.count({ where: { id: { in: unique } } })) !== unique.length) {
      throw new DomainError('UNKNOWN_CUISINE', 'One or more cuisines do not exist', 422);
    }
  }
}
