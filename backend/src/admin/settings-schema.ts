import { z } from 'zod';
import { DEFAULT_SETTINGS, SettingKey } from '../settings/settings.defaults';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Every admin-editable platform setting, with the range it may take. A typo or an absurd value is refused, never stored. */
export const SETTING_SCHEMAS: Record<SettingKey, z.ZodTypeAny> = {
  'commission.defaultBps': int(0, 5000),
  'fees.serviceFeeMinor': int(0, 100_000),
  'fees.taxBps': int(0, 3000),
  'discovery.maxRadiusMeters': int(1000, 50_000),
  'discovery.rankingWeights': z.object({ distance: z.number().min(0).max(10), eta: z.number().min(0).max(10), rating: z.number().min(0).max(10), relevance: z.number().min(0).max(10) }).strict().refine((w) => w.distance + w.eta + w.rating + w.relevance > 0, 'At least one weight must be positive'),
  'discovery.assumedSpeedKmh': int(5, 80),
  'dispatch.offerTimeoutSeconds': int(10, 300),
  'dispatch.maxRiderDistanceMeters': int(500, 20_000),
  'dispatch.maxOfferAttempts': int(1, 20),
  'dispatch.riderFreshnessSeconds': int(15, 900),
  'dispatch.presenceTimeoutSeconds': int(60, 7200),
  'dispatch.noRiderEscalationSeconds': int(30, 3600),
  'tracking.updateIntervalSeconds': int(1, 60),
  'tracking.staleAfterSeconds': int(5, 600),
  'order.restaurantAcceptTimeoutSeconds': int(30, 1800),
  'rider.deliveryFeeShareBps': int(0, 10_000),
  'reviews.windowDays': int(1, 90),
  'refunds.windowDays': int(1, 60),
  'payments.pendingTimeoutMinutes': int(5, 180),
  'chat.maxMessageLength': int(50, 2000),
  'chat.messagesPerMinute': int(1, 120),
  'chat.retentionDays': int(1, 365),
};

export const isSettingKey = (k: string): k is SettingKey => k in DEFAULT_SETTINGS;
