/** Defaults for admin-configurable platform behaviour. Money in minor units (paisa). Rows in platform_settings override these. */
export const DEFAULT_SETTINGS = {
  'commission.defaultBps': 1500, // 15%
  'fees.serviceFeeMinor': 1000, // ৳10
  'fees.taxBps': 0,
  'discovery.maxRadiusMeters': 8000,
  'discovery.rankingWeights': { distance: 0.35, eta: 0.3, rating: 0.25, relevance: 0.1 },
  'discovery.assumedSpeedKmh': 18,
  'dispatch.offerTimeoutSeconds': 45,
  'dispatch.maxRiderDistanceMeters': 4000,
  'dispatch.maxOfferAttempts': 5,
  'dispatch.riderFreshnessSeconds': 120, // a rider's position older than this is not trusted for offers
  'dispatch.presenceTimeoutSeconds': 600, // idle riders silent this long are set offline
  'dispatch.noRiderEscalationSeconds': 300, // unassigned this long after acceptance → flagged for admin
  'tracking.updateIntervalSeconds': 4,
  'tracking.staleAfterSeconds': 30,
  'order.restaurantAcceptTimeoutSeconds': 180,
  'rider.deliveryFeeShareBps': 8000, // rider earns 80% of the delivery fee; the platform keeps the rest
  'reviews.windowDays': 14,
  'refunds.windowDays': 7,
  'payments.pendingTimeoutMinutes': 30,
  'chat.maxMessageLength': 500,
  'chat.messagesPerMinute': 20,
  'chat.retentionDays': 30, // finished conversations stay readable (read-only) this long
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof DEFAULT_SETTINGS)[K] extends number ? number : (typeof DEFAULT_SETTINGS)[K] };
