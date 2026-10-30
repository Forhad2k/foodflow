import { ApprovalStatus, AssignmentStatus, OrderStatus, PaymentMethod, Prisma, Role } from '@prisma/client';
import { DomainError } from '../common/errors/domain-error';
import { haversineMeters, isPlausibleMove } from '../common/geo/distance';
import { AuditService } from '../audit/audit.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { OrderTransitionService } from '../orders/order-transition.service';
import { PrismaService } from '../prisma/prisma.service';
import { applyApprovalAction } from '../restaurants/approval';
import { PresenceDto, RiderHistoryDto, SetStatusDto, SubmitDocumentDto, UpdateVehicleDto } from '../schemas/riders';
import { deliveryVisibility, isOwnStorageKey, missingForRiderApproval, requiredDocuments } from './rider-rules';
import { RiderDocumentStorage } from './document-storage';

const deliveryInclude = {
  order: {
    select: {
      id: true, orderNumber: true, status: true, paymentMethod: true, totalMinor: true, restaurantName: true, deliveryInstructions: true, contactPhone: true,
      restaurant: { select: { name: true, phone: true, addressLine: true, city: true, lat: true, lng: true } },
      deliveryAddress: true,
      customer: { select: { profile: { select: { fullName: true } } } },
      _count: { select: { items: true } },
    },
  },
} satisfies Prisma.DeliveryAssignmentInclude;
type AssignmentWithOrder = Prisma.DeliveryAssignmentGetPayload<{ include: typeof deliveryInclude }>;
export class RidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: DispatchService,
    private readonly transitions: OrderTransitionService,
    private readonly audit: AuditService,
    private readonly documentStorage: RiderDocumentStorage,
  ) {}

  // ───────────── profile & verification ─────────────
  async me(userId: string) {
    const rider = await this.prisma.riderProfile.findUniqueOrThrow({
      where: { userId },
      include: { documents: { select: { id: true, type: true, status: true, rejectionReason: true, createdAt: true } } },
    });
    return {
      approvalStatus: rider.approvalStatus, rejectionReason: rider.rejectionReason, vehicleType: rider.vehicleType, vehiclePlate: rider.vehiclePlate,
      isOnline: rider.isOnline, maxActiveDeliveries: rider.maxActiveDeliveries, rating: { average: rider.ratingAvg, count: rider.ratingCount },
      documents: rider.documents,
      requiredDocuments: requiredDocuments(rider.vehicleType),
      missing: missingForRiderApproval(rider.vehicleType, rider.documents),
    };
  }

  async updateVehicle(userId: string, dto: UpdateVehicleDto) {
    const r = await this.prisma.riderProfile.findUniqueOrThrow({ where: { userId }, select: { approvalStatus: true } });
    if (r.approvalStatus === ApprovalStatus.APPROVED || r.approvalStatus === ApprovalStatus.SUSPENDED) {
      throw new DomainError('VEHICLE_LOCKED', 'Contact support to change the vehicle on an approved account', 409);
    }
    await this.prisma.riderProfile.update({ where: { userId }, data: { vehicleType: dto.vehicleType, vehiclePlate: dto.vehiclePlate ?? null } });
    return this.me(userId);
  }

  async submitDocument(userId: string, dto: SubmitDocumentDto) {
    if (!isOwnStorageKey(userId, dto.storageKey)) throw new DomainError('INVALID_STORAGE_KEY', 'Document must be stored under your own folder', 422);
    const r = await this.prisma.riderProfile.findUniqueOrThrow({ where: { userId }, select: { approvalStatus: true } });
    if (r.approvalStatus !== ApprovalStatus.PENDING && r.approvalStatus !== ApprovalStatus.REJECTED) {
      throw new DomainError('DOCUMENTS_LOCKED', 'Documents cannot be changed on an approved or suspended account', 409);
    }
    await this.documentStorage.verifyUploadedImage(userId, dto.storageKey);
    await this.prisma.riderVerificationDocument.upsert({
      where: { riderId_type: { riderId: userId, type: dto.type } },
      create: { riderId: userId, type: dto.type, storageKey: dto.storageKey },
      update: { storageKey: dto.storageKey, status: ApprovalStatus.PENDING, rejectionReason: null, reviewedById: null, reviewedAt: null },
    });
    return this.me(userId);
  }

  async createDocumentUploadSignature(userId: string) {
    const rider = await this.prisma.riderProfile.findUniqueOrThrow({ where: { userId }, select: { approvalStatus: true } });
    if (rider.approvalStatus !== ApprovalStatus.PENDING && rider.approvalStatus !== ApprovalStatus.REJECTED) {
      throw new DomainError('DOCUMENTS_LOCKED', 'Documents cannot be changed on an approved or suspended account', 409);
    }
    return this.documentStorage.createUploadSignature(userId);
  }

  async resubmit(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.riderProfile.findUniqueOrThrow({ where: { userId }, select: { approvalStatus: true } });
      const to = applyApprovalAction(r.approvalStatus, 'resubmit');
      await tx.riderProfile.update({ where: { userId }, data: { approvalStatus: to, rejectionReason: null } });
    });
    return this.me(userId);
  }

  // ───────────── availability & location ─────────────
  async setStatus(userId: string, dto: SetStatusDto) {
    const rider = await this.prisma.riderProfile.findUniqueOrThrow({ where: { userId }, select: { approvalStatus: true } });
    if (dto.isOnline) {
      if (rider.approvalStatus !== ApprovalStatus.APPROVED) throw new DomainError('RIDER_NOT_APPROVED', 'You can go online once an admin has approved your account', 403);
      if (dto.lat === undefined || dto.lng === undefined) throw new DomainError('LOCATION_REQUIRED', 'Your current location is required to go online', 422);
      await this.prisma.riderProfile.update({ where: { userId }, data: { isOnline: true, lastLat: dto.lat, lastLng: dto.lng, lastLocationAt: new Date() } });
      return { isOnline: true };
    }
    await this.prisma.$transaction(async (tx) => {
      const busy = await tx.deliveryAssignment.count({ where: { riderId: userId, status: AssignmentStatus.ACCEPTED } });
      if (busy > 0) throw new DomainError('HAS_ACTIVE_DELIVERY', 'Finish or release your active delivery before going offline', 409);
      await tx.deliveryAssignment.updateMany({ where: { riderId: userId, status: AssignmentStatus.OFFERED }, data: { status: AssignmentStatus.CANCELLED, respondedAt: new Date(), rejectReason: 'Rider went offline' } });
      // Going offline erases the stored position (no precise location is kept for off-duty riders).
      await tx.riderProfile.update({ where: { userId }, data: { isOnline: false, lastLat: null, lastLng: null, lastLocationAt: null } });
    });
    return { isOnline: false };
  }

  /** Idle position heartbeat (REST). During an active delivery the rider app streams over Socket.IO instead (Phase 6). */
  async presence(userId: string, dto: PresenceDto) {
    const r = await this.prisma.riderProfile.findUniqueOrThrow({ where: { userId }, select: { isOnline: true, lastLat: true, lastLng: true, lastLocationAt: true } });
    if (!r.isOnline) throw new DomainError('NOT_ONLINE', 'Go online first', 409);
    const now = new Date();
    const prev = r.lastLat !== null && r.lastLng !== null && r.lastLocationAt ? { lat: r.lastLat, lng: r.lastLng, at: r.lastLocationAt } : null;
    if (!isPlausibleMove(prev, { lat: dto.lat, lng: dto.lng, at: now })) throw new DomainError('IMPLAUSIBLE_LOCATION', 'Location jumped implausibly far. Check your GPS.', 422);
    await this.prisma.riderProfile.update({ where: { userId }, data: { lastLat: dto.lat, lastLng: dto.lng, lastLocationAt: now } });
    return { ok: true };
  }

  // ───────────── offers ─────────────
  /** Pre-acceptance view: coarse only. No exact addresses, no phone numbers, no customer name. */
  async offers(userId: string) {
    const rider = await this.prisma.riderProfile.findUnique({ where: { userId }, select: { lastLat: true, lastLng: true } });
    const rows = await this.prisma.deliveryAssignment.findMany({
      where: { riderId: userId, status: AssignmentStatus.OFFERED, expiresAt: { gt: new Date() } },
      orderBy: { offeredAt: 'asc' },
      include: deliveryInclude,
    });
    return rows.map((a) => {
      const o = a.order;
      const addr = o.deliveryAddress;
      return {
        offerId: a.id, expiresAt: a.expiresAt, orderNumber: o.orderNumber, itemCount: o._count.items,
        restaurant: { name: o.restaurant.name, city: o.restaurant.city },
        customerArea: addr ? (addr.area ?? addr.city) : null,
        pickupDistanceMeters: rider?.lastLat != null && rider.lastLng != null ? Math.round(haversineMeters(rider.lastLat, rider.lastLng, o.restaurant.lat, o.restaurant.lng)) : null,
        dropoffDistanceMeters: addr ? Math.round(haversineMeters(o.restaurant.lat, o.restaurant.lng, addr.lat, addr.lng)) : null,
        cashToCollectMinor: o.paymentMethod === PaymentMethod.CASH_ON_DELIVERY ? o.totalMinor : 0,
      };
    });
  }

  accept(userId: string, offerId: string) {
    return this.dispatch.acceptOffer(userId, offerId).then(async ({ orderId }) => this.deliveryByOrder(userId, orderId));
  }
  reject(userId: string, offerId: string, reason?: string) {
    return this.dispatch.rejectOffer(userId, offerId, reason);
  }

  // ───────────── deliveries ─────────────
  async activeDeliveries(userId: string) {
    const rows = await this.prisma.deliveryAssignment.findMany({
      where: { riderId: userId, status: AssignmentStatus.ACCEPTED },
      orderBy: { respondedAt: 'asc' },
      include: deliveryInclude,
    });
    return rows.map((a) => toDeliveryView(a));
  }

  async deliveryByOrder(userId: string, orderId: string) {
    const a = await this.prisma.deliveryAssignment.findFirst({ where: { orderId, riderId: userId, status: AssignmentStatus.ACCEPTED }, include: deliveryInclude });
    if (!a) throw new DomainError('DELIVERY_NOT_FOUND', 'Delivery not found', 404);
    return toDeliveryView(a);
  }

  /** pickup / on-the-way / delivered / failed. The state machine enforces order and actor; the assignment enforces "your delivery". */
  async step(userId: string, orderId: string, to: OrderStatus, reason?: string) {
    const mine = await this.prisma.deliveryAssignment.findFirst({ where: { orderId, riderId: userId, status: AssignmentStatus.ACCEPTED }, select: { id: true } });
    if (!mine) throw new DomainError('DELIVERY_NOT_FOUND', 'Delivery not found', 404);
    await this.transitions.transition({ orderId, to, actor: { role: Role.RIDER, userId }, reason });
    const a = await this.prisma.deliveryAssignment.findFirst({ where: { orderId, riderId: userId }, orderBy: { offeredAt: 'desc' }, include: deliveryInclude });
    return toDeliveryView(a!);
  }

  release(userId: string, orderId: string, reason: string) {
    return this.dispatch.releaseDelivery(userId, orderId, reason);
  }

  /** Finished work only, with no customer contact data. Earnings arrive with the payments module (Phase 7). */
  async history(userId: string, q: RiderHistoryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.DeliveryAssignmentWhereInput = { riderId: userId, status: { in: [AssignmentStatus.COMPLETED, AssignmentStatus.FAILED] } };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.deliveryAssignment.count({ where }),
      this.prisma.deliveryAssignment.findMany({
        where, orderBy: [{ respondedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, status: true, respondedAt: true, order: { select: { orderNumber: true, restaurantName: true, deliveryAddress: { select: { area: true, city: true } } } } },
      }),
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, outcome: r.status, finishedAt: r.respondedAt, orderNumber: r.order.orderNumber, restaurantName: r.order.restaurantName, area: r.order.deliveryAddress?.area ?? r.order.deliveryAddress?.city ?? null })),
      page, limit, total,
    };
  }
}

/** Applies least-privilege disclosure (see rider-rules.ts). */
export function toDeliveryView(a: AssignmentWithOrder) {
  const o = a.order;
  const v = deliveryVisibility(o.status);
  const addr = o.deliveryAddress;
  return {
    orderId: o.id, orderNumber: o.orderNumber, status: o.status, itemCount: o._count.items,
    cashToCollectMinor: o.paymentMethod === PaymentMethod.CASH_ON_DELIVERY && o.status !== OrderStatus.DELIVERED ? o.totalMinor : 0,
    restaurant: v.restaurantExact
      ? { name: o.restaurant.name, phone: o.restaurant.phone, addressLine: o.restaurant.addressLine, city: o.restaurant.city, lat: o.restaurant.lat, lng: o.restaurant.lng }
      : { name: o.restaurant.name },
    customer: {
      ...(v.customerFirstName && { firstName: o.customer.profile?.fullName.split(' ')[0] ?? 'Customer' }),
      area: addr ? (addr.area ?? addr.city) : null,
      ...(v.customerAddress && addr && { address: { line1: addr.line1, line2: addr.line2, area: addr.area, city: addr.city, lat: addr.lat, lng: addr.lng }, instructions: o.deliveryInstructions }),
      ...(v.customerPhone && { phone: o.contactPhone }),
    },
  };
}
