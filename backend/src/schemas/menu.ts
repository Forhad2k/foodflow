import { z } from 'zod';
import { minor, text, uuid } from './common';

const PRICE = 10_000_000;
export const categorySchema = z.object({ name: text(1, 80), sortOrder: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }).strict();
export const updateCategorySchema = categorySchema.partial();

const stock = z.number().int().min(0).max(100_000).nullable().optional(); // null/omitted = unlimited
const images = z.array(z.string().max(500)).max(8);
export const createItemSchema = z
  .object({ categoryId: uuid, name: text(1, 120), description: text(0, 500).optional(), basePriceMinor: minor(PRICE), isAvailable: z.boolean().optional(), stockQuantity: stock, sortOrder: z.number().int().min(0).max(10_000).optional(), imageUrls: images.optional() })
  .strict();
export const updateItemSchema = z
  .object({ categoryId: uuid, name: text(1, 120), description: text(0, 500), basePriceMinor: minor(PRICE), sortOrder: z.number().int().min(0).max(10_000), imageUrls: images })
  .partial()
  .strict();
/** Quick toggle used mid-service ("86 the dish") and for stock counts. */
export const itemAvailabilitySchema = z.object({ isAvailable: z.boolean().optional(), stockQuantity: stock }).strict();

export const syncVariantsSchema = z
  .object({
    variants: z.array(z.object({ id: uuid.optional(), name: text(1, 60), priceMinor: minor(PRICE), isDefault: z.boolean().optional(), isAvailable: z.boolean().optional() }).strict()).max(12),
  })
  .strict();
const addon = z.object({ id: uuid.optional(), name: text(1, 60), priceMinor: minor(PRICE), isAvailable: z.boolean().optional() }).strict();
export const syncAddonGroupsSchema = z
  .object({ groups: z.array(z.object({ id: uuid.optional(), name: text(1, 60), minSelect: z.number().int().min(0).max(30), maxSelect: z.number().int().min(1).max(30), addons: z.array(addon).max(30) }).strict()).max(10) })
  .strict();

export type CategoryDto = z.infer<typeof categorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
export type CreateItemDto = z.infer<typeof createItemSchema>;
export type UpdateItemDto = z.infer<typeof updateItemSchema>;
export type ItemAvailabilityDto = z.infer<typeof itemAvailabilitySchema>;
export type SyncVariantsDto = z.infer<typeof syncVariantsSchema>;
export type SyncAddonGroupsDto = z.infer<typeof syncAddonGroupsSchema>;
