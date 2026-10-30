/** Shapes of the API responses this app consumes (see backend/docs/API.md). Money is in minor units (paisa). */
export interface Cuisine { id: string; name: string; slug: string }

export interface RestaurantCardData {
  id: string; name: string; slug: string; logoUrl: string | null; coverUrl: string | null;
  cuisines: { name: string; slug: string }[]; priceTier: number; ratingAvg: number; ratingCount: number;
  distanceMeters: number; deliveryFeeMinor: number; minOrderMinor: number; estimatedDeliveryMinutes: { min: number; max: number }; isOpen: boolean;
}
export interface RestaurantList { items: RestaurantCardData[]; page: number; limit: number; total: number; emptyReason?: 'NO_RESTAURANTS_IN_AREA' | 'ALL_CLOSED' | 'FILTERS_TOO_STRICT' }

export interface Variant { id: string; name: string; priceMinor: number; isDefault: boolean; isAvailable: boolean }
export interface Addon { id: string; name: string; priceMinor: number; isAvailable: boolean }
export interface AddonGroup { id: string; name: string; minSelect: number; maxSelect: number; addons: Addon[] }
export interface MenuItemData { id: string; name: string; description: string | null; basePriceMinor: number; isAvailable: boolean; images: { url: string }[]; variants: Variant[]; addonGroups: AddonGroup[]; stockQuantity?: number | null }
export interface Deliverability { deliverable: boolean; distanceMeters?: number; deliveryFeeMinor?: number; minOrderMinor?: number; estimatedDeliveryMinutes?: { min: number; max: number } }
export interface RestaurantDetail {
  id: string; name: string; slug: string; description: string | null; phone: string; logoUrl: string | null; coverUrl: string | null; addressLine: string; city: string;
  avgPrepMinutes: number; priceTier: number; ratingAvg: number; ratingCount: number; minOrderMinor: number; baseDeliveryFeeMinor: number;
  cuisines: { name: string; slug: string }[]; isOpen: boolean; deliverability: Deliverability | null;
  menu: { id: string; name: string; items: MenuItemData[] }[];
}

export interface CartLine {
  id: string; menuItemId: string; name: string; quantity: number; notes: string | null; variantId: string | null; variantName: string | null;
  unitPriceMinor: number; addons: { addonId: string; name: string; priceMinor: number }[]; lineTotalMinor: number; valid: boolean;
}
export interface Issue { code: string; message: string; cartItemId?: string }
export interface Cart { restaurant: { id: string; name: string; slug: string; logoUrl: string | null } | null; items: CartLine[]; subtotalMinor: number; couponCode: string | null; issues: Issue[] }

export interface Address { id: string; label: string; line1: string; line2: string | null; area: string | null; city: string; postalCode: string | null; lat: number; lng: number; instructions: string | null; isDefault: boolean }
export interface Totals { subtotalMinor: number; deliveryFeeMinor: number; serviceFeeMinor: number; discountMinor: number; taxMinor: number; totalMinor: number }
export type PaymentMethod = 'CASH_ON_DELIVERY' | 'ONLINE';
export interface Quote {
  canCheckout: boolean; restaurant: { id: string; name: string }; totals: Totals; issues: Issue[]; paymentMethods: PaymentMethod[];
  coupon: { code: string; valid: boolean; discountMinor: number; reasonCode?: string; reason?: string } | null;
  delivery: { distanceMeters: number; estimatedMinutes: { min: number; max: number } } | null;
  items: { id: string; name: string; variantName: string | null; quantity: number; lineTotalMinor: number; valid: boolean }[];
}

export interface OrderSummary { id: string; orderNumber: string; status: string; restaurantId: string; restaurantName: string; totalMinor: number; paymentMethod: PaymentMethod; placedAt: string; itemCount: number }
export interface OrderView {
  id: string; orderNumber: string; status: string; paymentMethod: PaymentMethod; restaurant: { id: string; name: string }; totals: Totals; couponCode: string | null;
  contactPhone: string; customerNote: string | null; deliveryInstructions: string | null; estimatedDeliveryAt: string | null; cancelReason: string | null; placedAt: string;
  deliveryAddress: { label: string | null; line1: string; line2: string | null; area: string | null; city: string; lat: number; lng: number } | null;
  items: { name: string; variant: string | null; quantity: number; unitPriceMinor: number; lineTotalMinor: number; notes: string | null; addons: { name: string; priceMinor: number }[] }[];
  timeline: { from: string | null; to: string; at: string; reason: string | null }[];
  payments: { method: PaymentMethod; status: string; amountMinor: number; paidAt: string | null }[];
  customerActions: string[];
  payment?: { redirectUrl: string; expiresAt: string };
}
export interface Paged<T> { items: T[]; page: number; limit: number; total: number }

// ── User & Profile ──
export interface UserProfile {
  id: string; email: string; phone: string | null; role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'RIDER' | 'ADMIN';
  emailVerifiedAt: string | null; createdAt: string;
  profile: { fullName: string; avatarUrl: string | null; marketingConsent: boolean };
  riderProfile?: { approvalStatus: string; isOnline: boolean; vehicleType: string };
}

// ── Notifications ──
export interface NotificationItem {
  id: string; type: string; title: string; body: string; data?: Record<string, unknown>; readAt: string | null; createdAt: string;
}
export interface NotificationList {
  items: NotificationItem[]; page: number; limit: number; total: number; unreadCount: number;
}

// ── Realtime Tracking & Chat ──
export interface TrackingLocation {
  orderId?: string; lat: number; lng: number; headingDeg?: number; speedMps?: number;
  recordedAt: string; stale?: boolean; destination?: 'RESTAURANT' | 'CUSTOMER';
  etaMinutes?: number; distanceMeters?: number; etaSource?: string;
}
export interface TrackingSnapshot {
  orderId: string; location: TrackingLocation | null; staleAfterSeconds: number;
}
export interface ChatMessage {
  id: string; orderId: string; senderId: string; senderRole: 'CUSTOMER' | 'RIDER';
  body: string; clientMessageId?: string; createdAt: string; deliveredAt: string | null; readAt: string | null;
}
export interface ChatHistoryResponse {
  messages: ChatMessage[]; hasMore: boolean; unread: number; room: { open: boolean; orderNumber: string };
}

// ── Reviews & Support ──
export interface ReviewItem { id: string; rating: number; comment: string | null; reviewer: string; createdAt: string }
export interface RestaurantReviews { rating: { average: number; count: number }; items: ReviewItem[] }

export interface RefundRecord {
  id: string; orderId: string; amountMinor: number; reason: string; status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'PROCESSED' | 'FAILED';
  adminNote?: string | null; createdAt: string; reviewedAt?: string | null;
}

export type TicketCategory = 'ORDER_ISSUE' | 'MISSING_ITEM' | 'DELIVERY_COMPLAINT' | 'REFUND' | 'PAYMENT' | 'ACCOUNT' | 'DISPUTE' | 'OTHER';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export interface TicketMessage { id: string; senderRole: string; body: string; isInternal: boolean; createdAt: string }
export interface SupportTicket {
  id: string; ticketNumber?: string; category: TicketCategory; subject: string; description?: string;
  status: TicketStatus; priority?: string; orderId?: string | null; resolution?: string | null;
  assigneeId?: string | null; assigneeName?: string | null;
  messages: TicketMessage[]; createdAt: string; updatedAt?: string;
}

// ── Owner & Restaurant Management ──
export interface OperatingHour { dayOfWeek: number; opensAtMin: number; closesAtMin: number }
export interface DeliveryZone {
  id: string; type: 'RADIUS' | 'POLYGON'; name: string; radiusMeters?: number | null;
  polygon?: [number, number][] | null; deliveryFeeMinor?: number | null; minOrderMinor?: number | null; isActive?: boolean;
}
export interface OwnerRestaurant {
  id: string; name: string; slug: string; phone: string; addressLine: string; city: string;
  lat: number; lng: number; approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  isPaused: boolean; readiness: { ready: boolean; missing: string[] }; rejectionReason?: string | null;
  commissionBps?: number | null; cuisines: { id: string; name: string; slug: string }[];
  avgPrepMinutes: number; minOrderMinor: number; baseDeliveryFeeMinor: number;
  logoUrl: string | null; coverUrl: string | null; description: string | null; priceTier: number;
}
export interface RestaurantStats {
  ordersDelivered: number; ordersCancelled: number; ordersInProgress: number;
  grossSalesMinor: number; commissionMinor: number; netSalesMinor: number; ratingAvg: number;
}
export interface OwnerOrder {
  id: string; orderNumber: string; status: string; totalMinor: number; placedAt: string;
  customerFirstName: string; restaurantActions: string[];
  items: { name: string; variantName: string | null; quantity: number; notes: string | null; addons: { name: string; priceMinor: number }[] }[];
}

// ── Rider ──
export interface RiderDoc { id: string; type: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; rejectionReason?: string | null }
export interface RiderProfileData {
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  vehicleType: 'BICYCLE' | 'MOTORCYCLE' | 'CAR' | null; vehiclePlate?: string | null;
  isOnline: boolean; documents: RiderDoc[]; requiredDocuments: string[]; missing: string[]; rejectionReason?: string | null;
}
export interface RiderOffer {
  id: string; orderId: string; restaurantName: string; restaurantCity: string; customerArea: string;
  itemCount: number; pickupDistanceMeters: number; dropoffDistanceMeters: number;
  cashToCollectMinor: number; expiresAt: string;
}
export interface RiderDeliveryView {
  orderId: string; orderNumber: string; status: string; cashToCollectMinor: number;
  restaurant: { name: string; phone?: string; addressLine?: string; lat?: number; lng?: number; city?: string };
  customer: { firstName?: string; area: string; phone?: string; addressLine?: string; instructions?: string; lat?: number; lng?: number };
  itemsCount: number; placedAt: string;
}
export interface RiderEarnings { unpaidEarningsMinor: number; cashToRemitMinor: number; netUnpaidMinor: number; deliveredCount: number }
export interface PayoutRecord { id: string; amountMinor: number; status: string; periodStart: string; periodEnd: string; paidAt?: string | null; reference?: string | null }

// ── Admin ──
export interface AdminRestaurantItem {
  id: string; name: string; phone: string; addressLine: string; city: string;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  isPaused: boolean; readiness: { ready: boolean; missing: string[] }; commissionBps: number | null;
  owner: { id: string; email: string; fullName: string; phone: string | null };
}
export interface AdminRiderItem {
  id: string; fullName: string; email: string; phone: string | null;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  vehicleType: RiderProfileData['vehicleType']; isOnline: boolean;
  documents: Pick<RiderDoc, 'id' | 'type' | 'status'>[]; missing: string[];
}
export interface AdminUserItem {
  id: string; email: string; phone: string | null; role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'RIDER' | 'ADMIN';
  status: string; createdAt: string; profile: { fullName: string } | null;
}
export interface StuckOrder {
  id: string; orderNumber: string; status: string; restaurantName: string; restaurantAddress: string;
  customerArea: string; readyAt?: string; minutesWaiting: number; offersAttempted: number;
}
export interface ChatReportItem {
  id: string; orderNumber: string; orderId: string; reporterRole: string; reportedMessageBody: string;
  reportedSenderRole: string; reason: string; status: 'OPEN' | 'REVIEWED' | 'DISMISSED'; createdAt: string;
}
export interface ServiceArea { id: string; name: string; polygon: [number, number][]; isActive: boolean }
export interface CouponItem {
  id: string; code: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY'; value: number;
  maxDiscountMinor: number | null; minSubtotalMinor: number; startsAt: string; endsAt: string;
  usageLimitTotal: number | null; usageLimitPerUser: number; firstOrderOnly: boolean; isActive: boolean;
  restaurantId: string | null; redemptions: number;
}
export interface AuditLogItem {
  id: string; action: string; actorId: string; actorEmail?: string; entityType: string; entityId: string;
  details?: Record<string, unknown>; ipAddress?: string; createdAt: string;
}
export interface AdminStatsData {
  activeOrders: number; gmvMinor: number; onlineRiders: number; pendingRestaurants: number;
  pendingRiders: number; stuckOrders: number; openTickets: number;
}
export interface SettingItem { key: string; value: unknown; defaultValue: unknown; isCustom: boolean }
