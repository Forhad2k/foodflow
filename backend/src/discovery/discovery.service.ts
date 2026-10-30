import { ApprovalStatus } from '@prisma/client';
import { isOpenAt } from '../common/geo/hours';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ListRestaurantsDto, RestaurantDetailQueryDto } from '../schemas/discovery';
import { DiscoveryRepository } from './discovery.repository';
import { estimateDelivery } from './eta';
import { Rankable, sortRestaurants } from './ranking';

const CANDIDATE_LIMIT = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DiscoveryRepository,
    private readonly settings: SettingsService,
  ) {}

  listCuisines() {
    return this.prisma.cuisineType.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } });
  }

  async listRestaurants(dto: ListRestaurantsDto) {
    const s = await this.settings.get();
    const now = new Date();
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;

    const candidates = await this.repo.findCandidates(this.prisma, {
      lat: dto.lat,
      lng: dto.lng,
      maxRadiusMeters: s['discovery.maxRadiusMeters'],
      q: dto.q || undefined,
      cuisineSlugs: dto.cuisine,
      priceTiers: dto.priceTier,
      minRating: dto.minRating,
      limit: CANDIDATE_LIMIT,
    });

    const rows = candidates.length
      ? await this.prisma.restaurant.findMany({
          where: { id: { in: candidates.map((c) => c.id) } },
          select: {
            id: true, name: true, slug: true, logoUrl: true, coverUrl: true, priceTier: true, ratingAvg: true, ratingCount: true,
            avgPrepMinutes: true,
            cuisines: { select: { cuisine: { select: { name: true, slug: true } } } },
            hours: { select: { dayOfWeek: true, opensAtMin: true, closesAtMin: true } },
          },
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    // "Closed" restaurants are filtered out, as are those that fail the fee/ETA filters.
    const open = candidates.filter((c) => {
      const r = byId.get(c.id);
      return r && isOpenAt(r.hours, now);
    });

    const cards = open
      .map((c) => {
        const r = byId.get(c.id)!;
        const eta = estimateDelivery(r.avgPrepMinutes, c.distanceMeters, s['discovery.assumedSpeedKmh']);
        return {
          id: r.id, name: r.name, slug: r.slug, logoUrl: r.logoUrl, coverUrl: r.coverUrl,
          cuisines: r.cuisines.map((x) => x.cuisine),
          priceTier: r.priceTier, ratingAvg: r.ratingAvg, ratingCount: r.ratingCount,
          distanceMeters: Math.round(c.distanceMeters),
          deliveryFeeMinor: c.deliveryFeeMinor, minOrderMinor: c.minOrderMinor,
          estimatedDeliveryMinutes: { min: eta.minMinutes, max: eta.maxMinutes },
          isOpen: true,
          // internal ranking inputs
          etaMaxMinutes: eta.maxMinutes,
          relevance: dto.q ? (c.nameMatch ? 1 : c.dishMatch ? 0.6 : 0) : 0.5,
        };
      })
      .filter((c) => (dto.maxDeliveryFee === undefined || c.deliveryFeeMinor <= dto.maxDeliveryFee) && (dto.maxEtaMinutes === undefined || c.etaMaxMinutes <= dto.maxEtaMinutes));

    const sorted = sortRestaurants<Rankable & (typeof cards)[number]>(cards, dto.sort ?? 'recommended', s['discovery.rankingWeights'], s['discovery.maxRadiusMeters']);
    const items = sorted.slice((page - 1) * limit, page * limit).map(({ etaMaxMinutes: _e, relevance: _r, ...card }) => card);

    // Lets the UI show the right empty state instead of a generic "nothing found".
    let emptyReason: 'NO_RESTAURANTS_IN_AREA' | 'ALL_CLOSED' | 'FILTERS_TOO_STRICT' | undefined;
    if (sorted.length === 0) {
      emptyReason = candidates.length === 0 ? 'NO_RESTAURANTS_IN_AREA' : open.length === 0 ? 'ALL_CLOSED' : 'FILTERS_TOO_STRICT';
    }
    return { items, page, limit, total: sorted.length, emptyReason };
  }

  async getRestaurant(ref: string, loc: RestaurantDetailQueryDto) {
    const s = await this.settings.get();
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { approvalStatus: ApprovalStatus.APPROVED, ...(UUID.test(ref) ? { id: ref } : { slug: ref }) },
      select: {
        id: true, name: true, slug: true, description: true, phone: true, logoUrl: true, coverUrl: true,
        addressLine: true, city: true, lat: true, lng: true, isPaused: true, avgPrepMinutes: true, priceTier: true,
        ratingAvg: true, ratingCount: true, minOrderMinor: true, baseDeliveryFeeMinor: true,
        cuisines: { select: { cuisine: { select: { name: true, slug: true } } } },
        hours: { select: { dayOfWeek: true, opensAtMin: true, closesAtMin: true }, orderBy: [{ dayOfWeek: 'asc' }, { opensAtMin: 'asc' }] },
        categories: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true, name: true,
            items: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true, name: true, description: true, basePriceMinor: true, isAvailable: true, stockQuantity: true,
                images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
                variants: { select: { id: true, name: true, priceMinor: true, isDefault: true, isAvailable: true } },
                addonGroups: { select: { id: true, name: true, minSelect: true, maxSelect: true, addons: { select: { id: true, name: true, priceMinor: true, isAvailable: true } } } },
              },
            },
          },
        },
      },
    });
    if (!restaurant) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);

    const isOpen = !restaurant.isPaused && isOpenAt(restaurant.hours, new Date());

    let deliverability: null | {
      deliverable: boolean; distanceMeters?: number; deliveryFeeMinor?: number; minOrderMinor?: number;
      estimatedDeliveryMinutes?: { min: number; max: number };
    } = null;
    if (loc.lat !== undefined && loc.lng !== undefined) {
      const d = await this.repo.checkDeliverable(this.prisma, restaurant.id, loc.lat, loc.lng);
      if (!d) deliverability = { deliverable: false };
      else {
        const eta = estimateDelivery(restaurant.avgPrepMinutes, d.distanceMeters, s['discovery.assumedSpeedKmh']);
        deliverability = {
          deliverable: true, distanceMeters: Math.round(d.distanceMeters), deliveryFeeMinor: d.deliveryFeeMinor,
          minOrderMinor: d.minOrderMinor, estimatedDeliveryMinutes: { min: eta.minMinutes, max: eta.maxMinutes },
        };
      }
    }

    const { categories, cuisines, isPaused: _paused, ...rest } = restaurant;
    return {
      ...rest,
      cuisines: cuisines.map((c) => c.cuisine),
      isOpen,
      deliverability,
      menu: categories.map((cat) => ({
        ...cat,
        items: cat.items.map(({ stockQuantity, ...item }) => ({
          ...item,
          // Customers see "sold out" but never the exact stock level.
          isAvailable: item.isAvailable && (stockQuantity === null || stockQuantity > 0),
        })),
      })),
    };
  }
}
