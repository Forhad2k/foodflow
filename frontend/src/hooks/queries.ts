import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isActiveStatus } from '@/lib/format';
import type {
  Address, AdminRestaurantItem, AdminRiderItem, AdminStatsData, AdminUserItem, AuditLogItem, Cart, ChatHistoryResponse,
  ChatReportItem, CouponItem, Cuisine, DeliveryZone, NotificationList, OrderSummary, OrderView,
  OwnerOrder, OwnerRestaurant, Paged, PayoutRecord, RestaurantDetail, RestaurantList, RestaurantReviews,
  RestaurantStats, RiderDeliveryView, RiderEarnings, RiderOffer, RiderProfileData, ServiceArea, SettingItem,
  StuckOrder, SupportTicket, TrackingSnapshot, UserProfile,
} from '@/lib/types';
import { useAuth } from '@/lib/auth';

// ── Public & Customer Discovery ──
export const useCuisines = () => useQuery({ queryKey: ['cuisines'], queryFn: () => api.get<Cuisine[]>('/cuisines'), staleTime: 10 * 60_000 });

export interface RestaurantFilters {
  lat: number; lng: number; q?: string; cuisine?: string[]; priceTier?: number[];
  minRating?: number; maxDeliveryFee?: number; maxEtaMinutes?: number; sort?: string; page?: number; limit?: number;
}

export const useRestaurants = (f: RestaurantFilters | null) =>
  useQuery({
    queryKey: ['restaurants', f],
    enabled: !!f,
    queryFn: ({ signal }) =>
      api.get<RestaurantList>('/restaurants', {
        lat: f!.lat,
        lng: f!.lng,
        q: f!.q,
        cuisine: f!.cuisine,
        priceTier: f!.priceTier,
        minRating: f!.minRating,
        maxDeliveryFee: f!.maxDeliveryFee,
        maxEtaMinutes: f!.maxEtaMinutes,
        sort: f!.sort ?? 'recommended',
        page: f!.page ?? 1,
        limit: f!.limit ?? 30,
      }, signal),
    placeholderData: (prev) => prev,
  });

export const useRestaurant = (slug: string, loc: { lat: number; lng: number } | null) =>
  useQuery({ queryKey: ['restaurant', slug, loc], queryFn: ({ signal }) => api.get<RestaurantDetail>(`/restaurants/${slug}`, loc ?? undefined, signal) });

export const useRestaurantReviews = (ref: string, page = 1) =>
  useQuery({ queryKey: ['restaurant-reviews', ref, page], queryFn: () => api.get<RestaurantReviews>(`/restaurants/${ref}/reviews`, { page, limit: 10 }), enabled: !!ref });

// ── Customer Core ──
const useIsCustomer = () => { const { user } = useAuth(); return user?.role === 'CUSTOMER'; };

export const useProfile = () => {
  const { status } = useAuth();
  return useQuery({ queryKey: ['profile'], enabled: status === 'authenticated', queryFn: () => api.get<UserProfile>('/users/me') });
};

export const useCart = () => { const on = useIsCustomer(); return useQuery({ queryKey: ['cart'], enabled: on, queryFn: () => api.get<Cart>('/cart') }); };
export const useAddresses = () => { const on = useIsCustomer(); return useQuery({ queryKey: ['addresses'], enabled: on, queryFn: () => api.get<Address[]>('/addresses') }); };
export const useOrders = (page = 1) => { const on = useIsCustomer(); return useQuery({ queryKey: ['orders', page], enabled: on, queryFn: () => api.get<Paged<OrderSummary>>('/orders', { page, limit: 20 }) }); };

export const useOrder = (id: string) =>
  useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderView>(`/orders/${id}`),
    refetchInterval: (q) => (q.state.data && isActiveStatus(q.state.data.status) ? 8000 : false),
  });

export const useOrderTracking = (id: string, enabled = true) =>
  useQuery({
    queryKey: ['order-tracking', id],
    queryFn: () => api.get<TrackingSnapshot>(`/orders/${id}/tracking`),
    enabled: enabled && !!id,
    retry: false,
  });

export const useOrderChatMessages = (orderId: string, enabled = true) =>
  useQuery({
    queryKey: ['order-chat', orderId],
    queryFn: () => api.get<ChatHistoryResponse>(`/orders/${orderId}/chat/messages`),
    enabled: enabled && !!orderId,
  });

export const useNotifications = (page = 1) => {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['notifications', page],
    enabled: status === 'authenticated',
    queryFn: () => api.get<NotificationList>('/notifications', { page, limit: 20 }),
  });
};

export const useUnreadNotificationCount = () => {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['notifications-unread-count'],
    enabled: status === 'authenticated',
    queryFn: () => api.get<{ unreadCount: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
  });
};

export const useSupportTickets = () => {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['support-tickets'],
    enabled: status === 'authenticated',
    queryFn: () => api.get<SupportTicket[]>('/support/tickets'),
  });
};

export const useSupportTicket = (id: string) => {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['support-ticket', id],
    enabled: status === 'authenticated' && !!id,
    queryFn: () => api.get<SupportTicket>(`/support/tickets/${id}`),
  });
};

// ── Owner ──
const useIsOwner = () => { const { user } = useAuth(); return user?.role === 'RESTAURANT_OWNER'; };

export const useOwnerRestaurants = () => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-restaurants'], enabled: on, queryFn: () => api.get<OwnerRestaurant[]>('/owner/restaurants') });
};

export const useOwnerRestaurant = (id: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-restaurant', id], enabled: on && !!id, queryFn: () => api.get<OwnerRestaurant>(`/owner/restaurants/${id}`) });
};

export const useOwnerMenu = (restaurantId: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-menu', restaurantId], enabled: on && !!restaurantId, queryFn: () => api.get<{ categories: { id: string; name: string; items: any[] }[] }>(`/owner/restaurants/${restaurantId}/menu`) });
};

export const useOwnerOrders = (restaurantId: string, scope: 'active' | 'history' = 'active', status?: string) => {
  const on = useIsOwner();
  return useQuery({
    queryKey: ['owner-orders', restaurantId, scope, status],
    enabled: on && !!restaurantId,
    queryFn: () => api.get<OwnerOrder[]>(`/owner/restaurants/${restaurantId}/orders`, { scope, status }),
    refetchInterval: scope === 'active' ? 10_000 : false,
  });
};

export const useOwnerStats = (restaurantId: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-stats', restaurantId], enabled: on && !!restaurantId, queryFn: () => api.get<RestaurantStats>(`/owner/restaurants/${restaurantId}/stats`) });
};

export const useOwnerZones = (restaurantId: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-zones', restaurantId], enabled: on && !!restaurantId, queryFn: () => api.get<DeliveryZone[]>(`/owner/restaurants/${restaurantId}/zones`) });
};

export const useOwnerCoupons = (restaurantId: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-coupons', restaurantId], enabled: on && !!restaurantId, queryFn: () => api.get<Paged<CouponItem>>(`/owner/restaurants/${restaurantId}/coupons`) });
};

export const useOwnerEarnings = (restaurantId: string) => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-earnings', restaurantId], enabled: on && !!restaurantId, queryFn: () => api.get<any>(`/owner/restaurants/${restaurantId}/earnings`) });
};

export const useOwnerPayouts = () => {
  const on = useIsOwner();
  return useQuery({ queryKey: ['owner-payouts'], enabled: on, queryFn: () => api.get<PayoutRecord[]>('/owner/payouts') });
};

// ── Rider ──
const useIsRider = () => { const { user } = useAuth(); return user?.role === 'RIDER'; };

export const useRiderMe = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-me'], enabled: on, queryFn: () => api.get<RiderProfileData>('/rider/me') });
};

export const useRiderOffers = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-offers'], enabled: on, queryFn: () => api.get<RiderOffer[]>('/rider/offers'), refetchInterval: 5000 });
};

export const useRiderDeliveriesActive = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-deliveries-active'], enabled: on, queryFn: () => api.get<RiderDeliveryView[]>('/rider/deliveries/active'), refetchInterval: 8000 });
};

export const useRiderDeliveriesHistory = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-deliveries-history'], enabled: on, queryFn: () => api.get<any[]>('/rider/deliveries/history') });
};

export const useRiderEarnings = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-earnings'], enabled: on, queryFn: () => api.get<RiderEarnings>('/rider/earnings') });
};

export const useRiderPayouts = () => {
  const on = useIsRider();
  return useQuery({ queryKey: ['rider-payouts'], enabled: on, queryFn: () => api.get<PayoutRecord[]>('/rider/payouts') });
};

// ── Admin ──
const useIsAdmin = () => { const { user } = useAuth(); return user?.role === 'ADMIN'; };

export const useAdminStats = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-stats'], enabled: on, queryFn: () => api.get<AdminStatsData>('/admin/stats'), refetchInterval: 15_000 });
};

export const useAdminRestaurants = (status?: string, q?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-restaurants', status, q], enabled: on, queryFn: () => api.get<Paged<AdminRestaurantItem>>('/admin/restaurants', { status, q }) });
};

export const useAdminRiders = (status?: string, q?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-riders', status, q], enabled: on, queryFn: () => api.get<Paged<AdminRiderItem>>('/admin/riders', { status, q }) });
};

export const useAdminStuckOrders = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-stuck-orders'], enabled: on, queryFn: () => api.get<StuckOrder[]>('/admin/dispatch/stuck'), refetchInterval: 10_000 });
};

export const useAdminUsers = (role?: string, status?: string, q?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-users', role, status, q], enabled: on, queryFn: () => api.get<Paged<AdminUserItem>>('/admin/users', { role, status, q }) });
};

export const useAdminSettings = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-settings'], enabled: on, queryFn: () => api.get<SettingItem[]>('/admin/settings') });
};

export const useAdminServiceAreas = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-service-areas'], enabled: on, queryFn: () => api.get<ServiceArea[]>('/admin/service-areas') });
};

export const useAdminCoupons = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-coupons'], enabled: on, queryFn: () => api.get<CouponItem[]>('/admin/coupons') });
};

export const useAdminRefunds = (status?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-refunds', status], enabled: on, queryFn: () => api.get<any[]>('/admin/refunds', { status }) });
};

export const useAdminPayouts = () => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-payouts'], enabled: on, queryFn: () => api.get<any[]>('/admin/payouts') });
};

export const useAdminTickets = (status?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-tickets', status], enabled: on, queryFn: () => api.get<SupportTicket[]>('/admin/support/tickets', { status }) });
};

export const useAdminChatReports = (status?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-chat-reports', status], enabled: on, queryFn: () => api.get<ChatReportItem[]>('/admin/chat-reports', { status }) });
};

export const useAdminAuditLogs = (action?: string) => {
  const on = useIsAdmin();
  return useQuery({ queryKey: ['admin-audit-logs', action], enabled: on, queryFn: () => api.get<AuditLogItem[]>('/admin/audit-logs', { action, limit: 50 }) });
};
