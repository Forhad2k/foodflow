import { ApprovalStatus, Prisma } from '@prisma/client';
import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { lineTotal } from '../checkout/pricing';
import { normalizeCouponCode } from '../checkout/coupons';
import { AddCartItemDto, UpdateCartItemDto } from '../schemas/cart';
import { lineSignature, resolveSelection } from './menu-selection';

const MAX_LINES = 50;
const MAX_QTY = 99;

export interface LineIssue {
  code: string;
  message: string;
  cartItemId?: string;
}

export interface ResolvedLine {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  notes: string | null;
  variantId: string | null;
  variantName: string | null;
  unitPriceMinor: number;
  addons: { addonId: string; name: string; priceMinor: number }[];
  lineTotalMinor: number;
  stockQuantity: number | null;
  valid: boolean;
}

const cartInclude = {
  restaurant: {
    select: {
      id: true, ownerId: true, name: true, slug: true, logoUrl: true, approvalStatus: true, isPaused: true,
      avgPrepMinutes: true, minOrderMinor: true, baseDeliveryFeeMinor: true, commissionBps: true,
      hours: { select: { dayOfWeek: true, opensAtMin: true, closesAtMin: true } },
    },
  },
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      addons: true,
      menuItem: { include: { variants: true, addonGroups: { include: { addons: true } } } },
    },
  },
} satisfies Prisma.CartInclude;
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Re-prices every line from the CURRENT menu and flags anything that has become invalid
   * (item removed, option sold out, add-on gone, not enough stock). Used by the cart view and by checkout.
   */
  async snapshot(db: Db, userId: string) {
    const cart = await db.cart.findUnique({ where: { userId }, include: cartInclude });
    const lines: ResolvedLine[] = [];
    const issues: LineIssue[] = [];

    for (const li of cart?.items ?? []) {
      const base = {
        id: li.id, menuItemId: li.menuItemId, name: li.menuItem.name, quantity: li.quantity, notes: li.notes,
        stockQuantity: li.menuItem.stockQuantity,
      };
      try {
        const sel = resolveSelection(li.menuItem, li.variantId, li.addons.map((a) => a.addonId));
        lines.push({
          ...base, variantId: sel.variantId, variantName: sel.variantName, unitPriceMinor: sel.unitPriceMinor, addons: sel.addons,
          lineTotalMinor: lineTotal(sel.unitPriceMinor, sel.addons, li.quantity), valid: true,
        });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        issues.push({ code: err.code, message: err.message, cartItemId: li.id });
        lines.push({ ...base, variantId: li.variantId, variantName: null, unitPriceMinor: 0, addons: [], lineTotalMinor: 0, valid: false });
      }
    }

    // Stock is shared across lines of the same dish.
    const wanted = new Map<string, number>();
    for (const l of lines) if (l.valid) wanted.set(l.menuItemId, (wanted.get(l.menuItemId) ?? 0) + l.quantity);
    for (const l of lines) {
      if (l.valid && l.stockQuantity !== null && (wanted.get(l.menuItemId) ?? 0) > l.stockQuantity) {
        issues.push({ code: 'OUT_OF_STOCK', message: `Only ${Math.max(l.stockQuantity, 0)} of ${l.name} left`, cartItemId: l.id });
        l.valid = false;
      }
    }

    const subtotalMinor = lines.filter((l) => l.valid).reduce((s, l) => s + l.lineTotalMinor, 0);
    return { cart, restaurant: cart?.restaurant ?? null, lines, issues, subtotalMinor };
  }

  async view(db: Db, userId: string) {
    const snap = await this.snapshot(db, userId);
    return {
      restaurant: snap.restaurant && { id: snap.restaurant.id, name: snap.restaurant.name, slug: snap.restaurant.slug, logoUrl: snap.restaurant.logoUrl },
      items: snap.lines.map(({ stockQuantity: _s, ...l }) => l),
      subtotalMinor: snap.subtotalMinor,
      couponCode: snap.cart?.couponCode ?? null,
      issues: snap.issues,
    };
  }

  getCart(userId: string) {
    return this.view(this.prisma, userId);
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, userId);
      const cart = await tx.cart.findUniqueOrThrow({ where: { userId }, include: { items: { include: { addons: true } } } });

      const item = await tx.menuItem.findFirst({
        where: { id: dto.menuItemId, deletedAt: null },
        include: { restaurant: { select: { id: true, approvalStatus: true, isPaused: true } }, variants: true, addonGroups: { include: { addons: true } } },
      });
      if (!item || item.restaurant.approvalStatus !== ApprovalStatus.APPROVED) throw new DomainError('ITEM_NOT_FOUND', 'Menu item not found', 404);
      if (item.restaurant.isPaused) throw new DomainError('RESTAURANT_UNAVAILABLE', 'This restaurant is not taking orders right now', 409);

      const addonIds = dto.addonIds ?? [];
      resolveSelection(item, dto.variantId, addonIds); // throws a precise 422 on any invalid choice
      if (item.stockQuantity !== null && dto.quantity > item.stockQuantity) {
        throw new DomainError('OUT_OF_STOCK', `Only ${Math.max(item.stockQuantity, 0)} left`, 422);
      }

      let existing = cart.items;
      let couponCode = cart.couponCode;
      if (existing.length > 0 && cart.restaurantId !== item.restaurantId) {
        if (!dto.replaceCart) {
          throw new DomainError('CART_RESTAURANT_MISMATCH', 'Your cart has items from another restaurant. Start a new cart?', 409, {
            currentRestaurantId: cart.restaurantId,
          });
        }
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        existing = [];
        couponCode = null;
      }
      if (cart.restaurantId !== item.restaurantId) couponCode = null; // coupons are evaluated per restaurant

      const sig = lineSignature(dto.menuItemId, dto.variantId, addonIds, dto.notes);
      const match = existing.find((l) => lineSignature(l.menuItemId, l.variantId, l.addons.map((a) => a.addonId), l.notes) === sig);
      if (match) {
        const quantity = match.quantity + dto.quantity;
        if (quantity > MAX_QTY) throw new DomainError('QUANTITY_LIMIT', `You can order at most ${MAX_QTY} of an item`, 422);
        await tx.cartItem.update({ where: { id: match.id }, data: { quantity } });
      } else {
        if (existing.length >= MAX_LINES) throw new DomainError('CART_FULL', `A cart can hold at most ${MAX_LINES} lines`, 422);
        await tx.cartItem.create({
          data: {
            cartId: cart.id, menuItemId: dto.menuItemId, variantId: dto.variantId ?? null, quantity: dto.quantity,
            notes: dto.notes || null, addons: { create: addonIds.map((addonId) => ({ addonId })) },
          },
        });
      }
      await tx.cart.update({ where: { id: cart.id }, data: { restaurantId: item.restaurantId, couponCode } });
      return this.view(tx, userId);
    });
  }

  async updateItem(userId: string, cartItemId: string, dto: UpdateCartItemDto) {
    const result = await this.prisma.cartItem.updateMany({
      where: { id: cartItemId, cart: { userId } }, // ownership is part of the query itself
      data: { ...(dto.quantity !== undefined && { quantity: dto.quantity }), ...(dto.notes !== undefined && { notes: dto.notes || null }) },
    });
    if (result.count === 0) throw new DomainError('CART_ITEM_NOT_FOUND', 'Cart item not found', 404);
    return this.view(this.prisma, userId);
  }

  async removeItem(userId: string, cartItemId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, userId);
      const removed = await tx.cartItem.deleteMany({ where: { id: cartItemId, cart: { userId } } });
      if (removed.count === 0) throw new DomainError('CART_ITEM_NOT_FOUND', 'Cart item not found', 404);
      const left = await tx.cartItem.count({ where: { cart: { userId } } });
      if (left === 0) await tx.cart.updateMany({ where: { userId }, data: { restaurantId: null, couponCode: null } });
      return this.view(tx, userId);
    });
  }

  async clear(userId: string) {
    await this.prisma.$transaction([
      this.prisma.cartItem.deleteMany({ where: { cart: { userId } } }),
      this.prisma.cart.updateMany({ where: { userId }, data: { restaurantId: null, couponCode: null } }),
    ]);
  }

  /** Only checks that the code exists; full eligibility (dates, limits, minimum spend…) is judged at quote/checkout. */
  async setCoupon(userId: string, rawCode: string) {
    const code = normalizeCouponCode(rawCode);
    const coupon = await this.prisma.coupon.findUnique({ where: { code }, select: { id: true } });
    if (!coupon) throw new DomainError('COUPON_NOT_FOUND', 'Coupon code not found', 404);
    await this.prisma.cart.upsert({ where: { userId }, create: { userId, couponCode: code }, update: { couponCode: code } });
    return this.view(this.prisma, userId);
  }

  async removeCoupon(userId: string) {
    await this.prisma.cart.updateMany({ where: { userId }, data: { couponCode: null } });
    return this.view(this.prisma, userId);
  }

  private async lockCart(tx: Db, userId: string) {
    await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "carts" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
  }
}
