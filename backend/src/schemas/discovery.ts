import { z } from 'zod';
import { lat, lng, qCsv, qInt, qLimit, qNum, qPage } from './common';

const loc = { lat: qNum().pipe(lat), lng: qNum().pipe(lng) };

export const listRestaurantsSchema = z
  .object({
    ...loc,
    q: z.string().trim().max(80).optional(),
    cuisine: qCsv.optional(), // comma-separated slugs
    priceTier: z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => Number(s.trim())) : v), z.array(z.number().int().min(1).max(4))).optional(),
    minRating: qNum().pipe(z.number().min(0).max(5)).optional(),
    maxDeliveryFee: qInt().pipe(z.number().min(0)).optional(), // minor units
    maxEtaMinutes: qInt().pipe(z.number().min(5).max(180)).optional(),
    sort: z.enum(['recommended', 'distance', 'rating', 'delivery_time', 'delivery_fee']).optional(),
    page: qPage(),
    limit: qLimit(50),
  })
  .strict();
export const restaurantDetailQuerySchema = z.object({ lat: qNum().pipe(lat).optional(), lng: qNum().pipe(lng).optional() }).strict();

export type ListRestaurantsDto = z.infer<typeof listRestaurantsSchema>;
export type RestaurantDetailQueryDto = z.infer<typeof restaurantDetailQuerySchema>;
