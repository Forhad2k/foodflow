import { z } from 'zod';
import { httpsUrl, lat, lng, minor, phone, text, uuid } from './common';

const base = {
  name: text(2, 100), description: text(0, 1000).optional(), phone, addressLine: text(3, 200), city: text(2, 100), lat, lng,
  avgPrepMinutes: z.number().int().min(5).max(120).optional(), minOrderMinor: minor().optional(), baseDeliveryFeeMinor: minor().optional(),
  priceTier: z.number().int().min(1).max(4).optional(), cuisineIds: z.array(uuid).min(1).max(5), logoUrl: httpsUrl.optional(), coverUrl: httpsUrl.optional(),
};

/** commissionBps / approvalStatus / ownerId are deliberately absent: strict() rejects them, only admins can touch them. */
export const createRestaurantSchema = z.object(base).strict();
export const updateRestaurantSchema = z.object(base).partial().strict();
export const setAvailabilitySchema = z.object({ isPaused: z.boolean() }).strict();

export const setHoursSchema = z
  .object({
    hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), opensAtMin: z.number().int().min(0).max(1439), closesAtMin: z.number().int().min(1).max(1800) }).strict()).max(28),
  })
  .strict();

const zoneCommon = { name: text(1, 60), deliveryFeeMinor: minor().optional(), minOrderMinor: minor().optional() };
export const createZoneSchema = z.discriminatedUnion('type', [
  z.object({ ...zoneCommon, type: z.literal('RADIUS'), radiusMeters: z.number().int().min(200).max(30_000) }).strict(),
  z.object({ ...zoneCommon, type: z.literal('POLYGON'), polygon: z.array(z.tuple([z.number(), z.number()])).min(4).max(200) }).strict(),
]);
export const updateZoneSchema = z
  .object({ name: text(1, 60).optional(), radiusMeters: z.number().int().min(200).max(30_000).optional(), deliveryFeeMinor: minor().nullable().optional(), minOrderMinor: minor().nullable().optional(), isActive: z.boolean().optional() })
  .strict();
export const statsQuerySchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).strict();

export type CreateRestaurantDto = z.infer<typeof createRestaurantSchema>;
export type UpdateRestaurantDto = z.infer<typeof updateRestaurantSchema>;
export type SetAvailabilityDto = z.infer<typeof setAvailabilitySchema>;
export type SetHoursDto = z.infer<typeof setHoursSchema>;
export type CreateZoneDto = z.infer<typeof createZoneSchema>;
export type UpdateZoneDto = z.infer<typeof updateZoneSchema>;
export type StatsQueryDto = z.infer<typeof statsQuerySchema>;
