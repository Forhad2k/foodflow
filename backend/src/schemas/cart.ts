import { z } from 'zod';
import { text, uuid } from './common';

export const addCartItemSchema = z
  .object({
    menuItemId: uuid, variantId: uuid.optional(), addonIds: z.array(uuid).max(20).optional(),
    quantity: z.number().int().min(1).max(99), notes: text(0, 200).optional(),
    /** true discards a cart that holds another restaurant's items and starts a new one. */
    replaceCart: z.boolean().optional(),
  })
  .strict();
export const updateCartItemSchema = z.object({ quantity: z.number().int().min(1).max(99).optional(), notes: text(0, 200).optional() }).strict();
export const setCouponSchema = z.object({ code: text(1, 40) }).strict();

export type AddCartItemDto = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemDto = z.infer<typeof updateCartItemSchema>;
export type SetCouponDto = z.infer<typeof setCouponSchema>;
