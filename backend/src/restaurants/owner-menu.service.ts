import { Prisma } from '@prisma/client';
import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CategoryDto, CreateItemDto, ItemAvailabilityDto, SyncAddonGroupsDto, SyncVariantsDto, UpdateCategoryDto, UpdateItemDto } from '../schemas/menu';
import { assertImageUrls } from './image-urls';
import { RestaurantAccessService } from './restaurant-access.service';

const MAX_ITEMS = 500;
const MAX_CATEGORIES = 40;
const dup = (names: string[]) => new Set(names.map((n) => n.trim().toLowerCase())).size !== names.length;
const bad = (code: string, message: string) => new DomainError(code, message, 422);
export class OwnerMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly config: Env,
  ) {}

  private get hosts() {
    return this.config.IMAGE_HOST_ALLOWLIST;
  }

  /** Owner's full view: includes unavailable items and exact stock (customers never see these). */
  async getMenu(ownerId: string, restaurantId: string) {
    await this.access.assertOwner(ownerId, restaurantId);
    return this.prisma.menuCategory.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
            variants: true,
            addonGroups: { include: { addons: true } },
          },
        },
      },
    });
  }

  // ───────── categories ─────────
  async createCategory(ownerId: string, restaurantId: string, dto: CategoryDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    if ((await this.prisma.menuCategory.count({ where: { restaurantId } })) >= MAX_CATEGORIES) throw bad('CATEGORY_LIMIT', `At most ${MAX_CATEGORIES} categories`);
    return this.prisma.menuCategory.create({ data: { ...dto, restaurantId } });
  }

  async updateCategory(ownerId: string, restaurantId: string, id: string, dto: UpdateCategoryDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    await this.assertCategory(this.prisma, restaurantId, id, 404);
    return this.prisma.menuCategory.update({ where: { id }, data: dto });
  }

  /** Hard-deletes an empty category; one holding only retired items is hidden instead (history keeps pointing at it). */
  async deleteCategory(ownerId: string, restaurantId: string, id: string) {
    await this.access.assertOwner(ownerId, restaurantId);
    await this.assertCategory(this.prisma, restaurantId, id, 404);
    const [live, all] = await Promise.all([
      this.prisma.menuItem.count({ where: { categoryId: id, deletedAt: null } }),
      this.prisma.menuItem.count({ where: { categoryId: id } }),
    ]);
    if (live > 0) throw new DomainError('CATEGORY_NOT_EMPTY', 'Move or delete the items in this category first', 409);
    if (all === 0) {
      await this.prisma.menuCategory.delete({ where: { id } });
      return { deleted: true };
    }
    await this.prisma.menuCategory.update({ where: { id }, data: { isActive: false } });
    return { deleted: false, deactivated: true };
  }

  // ───────── items ─────────
  async createItem(ownerId: string, restaurantId: string, dto: CreateItemDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    assertImageUrls(dto.imageUrls ?? [], this.hosts);
    const { imageUrls, ...fields } = dto;
    return this.prisma.$transaction(async (tx) => {
      await this.assertCategory(tx, restaurantId, dto.categoryId, 422);
      if ((await tx.menuItem.count({ where: { restaurantId, deletedAt: null } })) >= MAX_ITEMS) throw bad('ITEM_LIMIT', `At most ${MAX_ITEMS} menu items`);
      return tx.menuItem.create({
        data: { ...fields, restaurantId, stockQuantity: dto.stockQuantity ?? null, images: { create: (imageUrls ?? []).map((url, sortOrder) => ({ url, sortOrder })) } },
        select: { id: true },
      });
    });
  }

  async updateItem(ownerId: string, restaurantId: string, itemId: string, dto: UpdateItemDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    if (dto.imageUrls) assertImageUrls(dto.imageUrls, this.hosts);
    const { imageUrls, ...fields } = dto;
    await this.prisma.$transaction(async (tx) => {
      await this.assertItem(tx, restaurantId, itemId);
      if (dto.categoryId) await this.assertCategory(tx, restaurantId, dto.categoryId, 422);
      if (imageUrls) {
        await tx.menuItemImage.deleteMany({ where: { menuItemId: itemId } });
        await tx.menuItemImage.createMany({ data: imageUrls.map((url, sortOrder) => ({ menuItemId: itemId, url, sortOrder })) });
      }
      if (Object.keys(fields).length) await tx.menuItem.update({ where: { id: itemId }, data: fields });
    });
    return { id: itemId };
  }

  async setAvailability(ownerId: string, restaurantId: string, itemId: string, dto: ItemAvailabilityDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    await this.assertItem(this.prisma, restaurantId, itemId);
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: { ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }), ...(dto.stockQuantity !== undefined && { stockQuantity: dto.stockQuantity }) },
      select: { id: true, isAvailable: true, stockQuantity: true },
    });
  }

  /** Soft delete: old orders keep their snapshot, carts holding it are flagged by the cart validator. */
  async deleteItem(ownerId: string, restaurantId: string, itemId: string) {
    await this.access.assertOwner(ownerId, restaurantId);
    await this.assertItem(this.prisma, restaurantId, itemId);
    await this.prisma.menuItem.update({ where: { id: itemId }, data: { deletedAt: new Date(), isAvailable: false } });
  }

  // ───────── variants & add-ons (declarative sync) ─────────
  async syncVariants(ownerId: string, restaurantId: string, itemId: string, dto: SyncVariantsDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    const input = dto.variants;
    if (dup(input.map((v) => v.name))) throw bad('DUPLICATE_VARIANT', 'Option names must be unique');
    if (input.filter((v) => v.isDefault).length > 1) throw bad('MULTIPLE_DEFAULTS', 'Only one option can be the default');
    if (input.length && !input.some((v) => v.isDefault)) input[0].isDefault = true;

    return this.prisma.$transaction(async (tx) => {
      await this.assertItem(tx, restaurantId, itemId);
      const existing = await tx.itemVariant.findMany({ where: { menuItemId: itemId }, select: { id: true } });
      const existingIds = new Set(existing.map((e) => e.id));
      for (const v of input) if (v.id && !existingIds.has(v.id)) throw bad('UNKNOWN_VARIANT', 'Variant does not belong to this item');

      const keep = new Set(input.filter((v) => v.id).map((v) => v.id!));
      await tx.itemVariant.deleteMany({ where: { menuItemId: itemId, id: { notIn: [...keep] } } });
      for (const v of input) {
        const data = { name: v.name, priceMinor: v.priceMinor, isDefault: v.isDefault ?? false, isAvailable: v.isAvailable ?? true };
        if (v.id) await tx.itemVariant.update({ where: { id: v.id }, data });
        else await tx.itemVariant.create({ data: { ...data, menuItemId: itemId } });
      }
      return tx.itemVariant.findMany({ where: { menuItemId: itemId }, orderBy: { priceMinor: 'asc' } });
    });
  }

  async syncAddonGroups(ownerId: string, restaurantId: string, itemId: string, dto: SyncAddonGroupsDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    if (dup(dto.groups.map((g) => g.name))) throw bad('DUPLICATE_GROUP', 'Add-on group names must be unique');
    for (const g of dto.groups) {
      if (g.minSelect > g.maxSelect) throw bad('INVALID_GROUP_LIMITS', `"${g.name}": minimum cannot exceed maximum`);
      if (g.addons.length < g.minSelect) throw bad('INVALID_GROUP_LIMITS', `"${g.name}" needs at least ${g.minSelect} add-ons to satisfy its minimum`);
      if (g.addons.length === 0) throw bad('EMPTY_GROUP', `"${g.name}" has no add-ons`);
      if (dup(g.addons.map((a) => a.name))) throw bad('DUPLICATE_ADDON', `"${g.name}": add-on names must be unique`);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertItem(tx, restaurantId, itemId);
      const existing = await tx.addonGroup.findMany({ where: { menuItemId: itemId }, include: { addons: { select: { id: true } } } });
      const groupAddons = new Map(existing.map((g) => [g.id, new Set(g.addons.map((a) => a.id))]));
      for (const g of dto.groups) {
        if (g.id && !groupAddons.has(g.id)) throw bad('UNKNOWN_GROUP', 'Add-on group does not belong to this item');
        for (const a of g.addons) if (a.id && (!g.id || !groupAddons.get(g.id)!.has(a.id))) throw bad('UNKNOWN_ADDON', 'Add-on does not belong to this group');
      }
      const keepGroups = dto.groups.filter((g) => g.id).map((g) => g.id!);
      await tx.addonGroup.deleteMany({ where: { menuItemId: itemId, id: { notIn: keepGroups } } }); // cascades to their add-ons

      for (const g of dto.groups) {
        const groupData = { name: g.name, minSelect: g.minSelect, maxSelect: Math.min(g.maxSelect, g.addons.length) };
        let groupId = g.id;
        if (groupId) await tx.addonGroup.update({ where: { id: groupId }, data: groupData });
        else groupId = (await tx.addonGroup.create({ data: { ...groupData, menuItemId: itemId }, select: { id: true } })).id;

        await tx.addon.deleteMany({ where: { groupId, id: { notIn: g.addons.filter((a) => a.id).map((a) => a.id!) } } });
        for (const a of g.addons) {
          const data = { name: a.name, priceMinor: a.priceMinor, isAvailable: a.isAvailable ?? true };
          if (a.id) await tx.addon.update({ where: { id: a.id }, data });
          else await tx.addon.create({ data: { ...data, groupId } });
        }
      }
      return tx.addonGroup.findMany({ where: { menuItemId: itemId }, include: { addons: true }, orderBy: { name: 'asc' } });
    });
  }

  // ───────── helpers ─────────
  private async assertCategory(db: Db, restaurantId: string, id: string, status: 404 | 422) {
    const c = await db.menuCategory.findFirst({ where: { id, restaurantId }, select: { id: true } });
    if (!c) throw new DomainError('CATEGORY_NOT_FOUND', 'Category not found in this restaurant', status);
  }
  private async assertItem(db: Db, restaurantId: string, id: string) {
    const i = await db.menuItem.findFirst({ where: { id, restaurantId, deletedAt: null }, select: { id: true } });
    if (!i) throw new DomainError('ITEM_NOT_FOUND', 'Menu item not found', 404);
  }
}
export type { Prisma };
