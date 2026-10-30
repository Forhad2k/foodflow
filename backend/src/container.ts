import { AddressesService } from './addresses/addresses.service';
import { AdminRestaurantsService } from './admin/admin-restaurants.service';
import { AdminRidersService } from './admin/admin-riders.service';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { CartService } from './cart/cart.service';
import { CheckoutService } from './checkout/checkout.service';
import { rootLogger } from './common/logger';
import type { Env } from './config/env';
import { DiscoveryRepository } from './discovery/discovery.repository';
import { DiscoveryService } from './discovery/discovery.service';
import { DispatchService } from './dispatch/dispatch.service';
import { MailService } from './mail/mail.service';
import { OrderTimeoutService } from './orders/order-timeout.service';
import { OrderTransitionService } from './orders/order-transition.service';
import { OrdersService } from './orders/orders.service';
import type { PrismaService } from './prisma/prisma.service';
import { PaymentService } from './payments/payment.service';
import { PayoutService } from './payments/payout.service';
import { DevPaymentProvider, PaymentProvider } from './payments/provider';
import { RefundService } from './payments/refund.service';
import { CouponService } from './promotions/coupon.service';
import { ReviewService } from './reviews/review.service';
import { SupportService } from './support/support.service';
import { AdminPlatformService } from './admin/admin-platform.service';
import { NotificationFanout } from './notifications/fanout';
import { NotificationService } from './notifications/notification.service';
import { ChatService } from './realtime/chat.service';
import { RealtimeHub } from './realtime/hub';
import { StraightLineRouting, RoutingProvider } from './realtime/routing';
import { TrackingService } from './realtime/tracking.service';
import { OwnerMenuService } from './restaurants/owner-menu.service';
import { OwnerOrdersService } from './restaurants/owner-orders.service';
import { OwnerRestaurantsService } from './restaurants/owner-restaurants.service';
import { RestaurantAccessService } from './restaurants/restaurant-access.service';
import { RidersService } from './riders/riders.service';
import { RiderDocumentStorage } from './riders/document-storage';
import { SettingsService } from './settings/settings.service';
import { UsersService } from './users/users.service';

/**
 * Composition root: the ONE place where services are constructed and wired together (plain constructor injection,
 * no framework). Tests build the same container around a test database or a stubbed Prisma client.
 */
export function createContainer(deps: { prisma: PrismaService; env: Env; routing?: RoutingProvider; paymentProvider?: PaymentProvider | null }) {
  const { prisma, env } = deps;
  rootLogger.level = env.LOG_LEVEL;

  const settings = new SettingsService(prisma);
  const audit = new AuditService(prisma);
  const mail = new MailService(env);
  const hub = new RealtimeHub();
  const notifications = new NotificationService(prisma);
  const transitions = new OrderTransitionService(prisma, notifications);
  const dispatch = new DispatchService(prisma, transitions, settings, audit, env, notifications);
  const discoveryRepo = new DiscoveryRepository();
  const carts = new CartService(prisma);
  const checkout = new CheckoutService(carts, discoveryRepo, settings);
  const access = new RestaurantAccessService(prisma);
  const provider: PaymentProvider | null = deps.paymentProvider !== undefined ? deps.paymentProvider : env.PAYMENT_PROVIDER === 'dev' ? new DevPaymentProvider(env.PAYMENT_WEBHOOK_SECRET!, env.API_URL) : null;
  const payments = new PaymentService(prisma, env, provider, transitions, notifications, audit, settings);
  const riderDocumentStorage = new RiderDocumentStorage(env);

  return {
    prisma, env, settings, audit, mail, transitions, dispatch, carts, checkout, access, hub, notifications,
    chat: new ChatService(prisma, settings, hub, audit),
    tracking: new TrackingService(prisma, settings, deps.routing ?? new StraightLineRouting(async () => (await settings.get())['discovery.assumedSpeedKmh']), env.LOCATION_RETENTION_HOURS),
    fanout: new NotificationFanout(prisma, notifications, hub, env.DATABASE_URL),
    auth: new AuthService(prisma, env, audit, mail),
    users: new UsersService(prisma),
    addresses: new AddressesService(prisma),
    discoveryRepo,
    discovery: new DiscoveryService(prisma, discoveryRepo, settings),
    orders: new OrdersService(prisma, checkout, transitions, notifications, payments),
    payments,
    refunds: new RefundService(prisma, provider, notifications, audit, settings),
    payouts: new PayoutService(prisma, audit),
    reviews: new ReviewService(prisma, settings),
    coupons: new CouponService(prisma, audit),
    support: new SupportService(prisma, notifications, audit),
    adminPlatform: new AdminPlatformService(prisma, audit, settings, notifications, dispatch),
    orderTimeout: new OrderTimeoutService(prisma, transitions, settings, env),
    ownerRestaurants: new OwnerRestaurantsService(prisma, access, audit, settings, env),
    ownerMenu: new OwnerMenuService(prisma, access, env),
    ownerOrders: new OwnerOrdersService(prisma, access, transitions, dispatch),
    adminRestaurants: new AdminRestaurantsService(prisma, audit, settings),
    adminRiders: new AdminRidersService(prisma, audit, riderDocumentStorage),
    riders: new RidersService(prisma, dispatch, transitions, audit, riderDocumentStorage),
  };
}
export type Container = ReturnType<typeof createContainer>;
