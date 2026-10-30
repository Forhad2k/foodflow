import { z } from 'zod';
import { lat, lng, text } from './common';

export const createAddressSchema = z
  .object({
    label: text(1, 40), line1: text(3, 200), line2: text(0, 200).optional(), area: text(0, 100).optional(), city: text(2, 100),
    postalCode: text(0, 20).optional(), lat, lng, instructions: text(0, 300).optional(), isDefault: z.boolean().optional(),
  })
  .strict();
export const updateAddressSchema = createAddressSchema.partial();

export type CreateAddressDto = z.infer<typeof createAddressSchema>;
export type UpdateAddressDto = z.infer<typeof updateAddressSchema>;
