import { ApprovalStatus, Coupon, CouponType, OrderStatus } from '@prisma/client';
import { CartService, LineIssue, ResolvedLine } from '../cart/cart.service';
import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import { isOpenAt } from '../common/geo/hours';
import { DiscoveryRepository } from '../discovery/discovery.repository';
import { estimateDelivery } from '../discovery/eta';
import { SettingsService } from '../settings/settings.service';
import { evaluateCoupon, normalizeCouponCode } from './coupons';
import { computeTotals, Totals } from './pricing';

export interface CheckoutIssue extends LineIssue {}

export interface CheckoutComputation {
  restaurant: NonNullable<Awaited<ReturnType<CartService['snapshot']>>['restaurant']>;
  cartId: string;
  address: { id: string; label: string; line1: string; line2: string | null; area: string | null; city: string; lat: number; lng: number };
  lines: ResolvedLine[];
  totals: Totals;
  commissionBps: number;
  coupon: null | { code: string; valid: boolean; discountMinor: number; reason?: string; reasonCode?: string; row: Coupon | null };
  delivery: null | { distanceMeters: number; estimatedMinutes: { min: number; max: number } };
  issues: CheckoutIssue[];
}

/** Statuses that do not count as "an order the customer has really had" (for first-order coupons). */
const NOT_COUNTED: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.REJECTED_BY_RESTAURANT, OrderStatus.PAYMENT_FAILED];

/**
 * The one place prices are decided. Used for the quote the customer sees AND re-run inside the order
 * transaction, so what is charged is always computed on the server from current data.
 * Nothing from the client (totals, prices, fees) is ever trusted.
 */
export class CheckoutService {
  constructor(
    private readonly carts: CartService,
    private readonly discovery: DiscoveryRepository,
    private readonly settings: SettingsService,
  ) {}

  async compute(db: Db, userId: string, opts: { addressId: string; couponCode?: string | null }): Promise<CheckoutComputation> {
    const snap = await this.carts.snapshot(db, userId);
    if (!snap.cart || !snap.restaurant || snap.lines.length === 0) throw new DomainError('CART_EMPTY', 'Your cart is empty', 422);
    const { restaurant, cart } = snap;
    const issues: CheckoutIssue[] = [...snap.issues];

    const address = await db.address.findFirst({
      where: { id: opts.addressId, userId, deletedAt: null },
      select: { id: true, label: true, line1: true, line2: true, area: true, city: true, lat: true, lng: true },
    });
    if (!address) throw new DomainError('ADDRESS_NOT_FOUND', 'Delivery address not found', 404);

    if (restaurant.approvalStatus !== ApprovalStatus.APPROVED || restaurant.isPaused) {
      issues.push({ code: 'RESTAURANT_UNAVAILABLE', message: `${restaurant.name} is not taking orders right now` });
    } else if (!isOpenAt(restaurant.hours, new Date())) {
      issues.push({ code: 'RESTAURANT_CLOSED', message: `${restaurant.name} is closed right now` });
    }

    // Delivery eligibility is re-validated here, not just when browsing.
    const s = await this.settings.get();
    const deliverable = await this.discovery.checkDeliverable(db, restaurant.id, address.lat, address.lng);
    if (!deliverable) issues.push({ code: 'ADDRESS_NOT_DELIVERABLE', message: `${restaurant.name} does not deliver to this address` });

    const deliveryFeeMinor = deliverable?.deliveryFeeMinor ?? restaurant.baseDeliveryFeeMinor;
    const minOrderMinor = deliverable?.minOrderMinor ?? restaurant.minOrderMinor;
    const subtotalMinor = snap.subtotalMinor;
    if (subtotalMinor < minOrderMinor) {
      issues.push({ code: 'MIN_ORDER_NOT_MET', message: `Minimum order is ${minOrderMinor / 100}. Add ${(minOrderMinor - subtotalMinor) / 100} more.` });
    }

    // Coupon: an explicit code replaces the cart's; `null` removes it.
    const rawCode = opts.couponCode !== undefined ? opts.couponCode : cart.couponCode;
    let coupon: CheckoutComputation['coupon'] = null;
    let discountMinor = 0;
    let couponType: CouponType | undefined;
    if (rawCode) {
      const code = normalizeCouponCode(rawCode);
      const row = await db.coupon.findUnique({ where: { code } });
      if (!row) {
        coupon = { code, valid: false, discountMinor: 0, reasonCode: 'COUPON_NOT_FOUND', reason: 'Coupon code not found', row: null };
        issues.push({ code: 'COUPON_NOT_FOUND', message: 'Coupon code not found' });
      } else {
        const [totalRedemptions, userRedemptions, priorOrders] = await Promise.all([
          db.couponRedemption.count({ where: { couponId: row.id } }),
          db.couponRedemption.count({ where: { couponId: row.id, userId } }),
          db.order.count({ where: { customerId: userId, status: { notIn: NOT_COUNTED } } }),
        ]);
        const result = evaluateCoupon(row, {
          now: new Date(), restaurantId: restaurant.id, subtotalMinor, deliveryFeeMinor, totalRedemptions, userRedemptions, isFirstOrder: priorOrders === 0,
        });
        if (result.ok) {
          discountMinor = result.discountMinor;
          couponType = row.type;
          coupon = { code, valid: true, discountMinor, row };
        } else {
          coupon = { code, valid: false, discountMinor: 0, reasonCode: result.code, reason: result.message, row };
          issues.push({ code: result.code, message: result.message });
        }
      }
    }

    const totals = computeTotals({
      subtotalMinor, deliveryFeeMinor, serviceFeeMinor: s['fees.serviceFeeMinor'], taxBps: s['fees.taxBps'], discountMinor, couponType,
    });
    const eta = deliverable ? estimateDelivery(restaurant.avgPrepMinutes, deliverable.distanceMeters, s['discovery.assumedSpeedKmh']) : null;

    return {
      restaurant, cartId: cart.id, address, lines: snap.lines, totals,
      commissionBps: restaurant.commissionBps ?? s['commission.defaultBps'],
      coupon,
      delivery: deliverable && eta ? { distanceMeters: Math.round(deliverable.distanceMeters), estimatedMinutes: { min: eta.minMinutes, max: eta.maxMinutes } } : null,
      issues,
    };
  }
}
