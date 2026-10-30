import { CouponType, PayoutStatus, RefundStatus, Role, TicketCategory, TicketStatus, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { lat, lng, minor, qLimit, qPage, text, uuid } from './common';

const page = { page: qPage(), limit: qLimit(100) };
const date = z.coerce.date();

// ── refunds, payouts ──
export const refundRequestSchema = z.object({ amountMinor: z.number().int().min(1).optional(), reason: text(3, 500) }).strict();
export const refundReviewSchema = z.object({ approve: z.boolean(), note: text(3, 500).optional(), amountMinor: z.number().int().min(1).optional() }).strict();
export const markProcessedSchema = z.object({ reference: text(3, 120) }).strict();
export const refundsQuery = z.object({ status: z.nativeEnum(RefundStatus).optional(), ...page }).strict();
export const payoutGenerateSchema = z.object({ periodStart: date, periodEnd: date }).strict();
export const markPaidSchema = z.object({ reference: text(3, 120) }).strict();
export const payoutsQuery = z.object({ status: z.nativeEnum(PayoutStatus).optional(), role: z.nativeEnum(Role).optional(), ...page }).strict();
export const reconcileQuery = z.object({ from: date, to: date }).strict();
export const earningsQuery = z.object({ ...page }).strict();
export const devSimulateSchema = z.object({ outcome: z.enum(['PAID', 'FAILED']), amountMinor: z.number().int().min(0).optional() }).strict();

// ── reviews ──
export const reviewSchema = z.object({ restaurantRating: z.number().int().min(1).max(5), riderRating: z.number().int().min(1).max(5).optional(), comment: text(0, 1000).optional() }).strict();
export const reviewsQuery = z.object({ ...page }).strict();

// ── coupons ──
const couponBase = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, 'Use 3-30 letters, digits, - or _'),
  type: z.nativeEnum(CouponType), value: z.number().int().min(0).max(100_000_000), maxDiscountMinor: minor().nullable().optional(), minSubtotalMinor: minor().optional(),
  startsAt: date, endsAt: date, usageLimitTotal: z.number().int().min(1).max(1_000_000).nullable().optional(), usageLimitPerUser: z.number().int().min(1).max(100).optional(),
  firstOrderOnly: z.boolean().optional(), isActive: z.boolean().optional(),
};
export const couponCreateSchema = z.object(couponBase).strict();
export const couponUpdateSchema = z.object(couponBase).partial().strict();
export const adminCouponCreateSchema = z.object({ ...couponBase, restaurantId: uuid.optional() }).strict();
export const couponsQuery = z.object({ ...page }).strict();

// ── support ──
export const ticketCreateSchema = z.object({ category: z.nativeEnum(TicketCategory), subject: text(3, 150), description: text(10, 4000), orderId: uuid.optional() }).strict();
export const ticketReplySchema = z.object({ body: text(1, 4000) }).strict();
export const ticketsQuery = z.object({ status: z.nativeEnum(TicketStatus).optional(), ...page }).strict();
export const adminTicketsQuery = z.object({ status: z.nativeEnum(TicketStatus).optional(), category: z.nativeEnum(TicketCategory).optional(), assigneeId: uuid.optional(), unassigned: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), open: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), ...page }).strict();
export const adminReplySchema = z.object({ body: text(1, 4000), isInternal: z.boolean().optional() }).strict();
export const assignSchema = z.object({ assigneeId: uuid.nullable() }).strict();
export const ticketStatusSchema = z.object({ status: z.nativeEnum(TicketStatus), resolution: text(3, 2000).optional() }).strict();

// ── admin platform ──
export const adminUsersQuery = z.object({ role: z.nativeEnum(Role).optional(), status: z.nativeEnum(UserStatus).optional(), q: z.string().trim().max(80).optional(), ...page }).strict();
export const userStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: text(3, 300).optional() }).strict();
export const auditQuery = z.object({ action: z.string().max(60).optional(), actorId: uuid.optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(80).optional(), from: date.optional(), to: date.optional(), ...page }).strict();
export const settingSchema = z.object({ key: z.string().min(3).max(60), value: z.unknown() }).strict();
export const serviceAreaSchema = z.object({ name: text(2, 80), polygon: z.array(z.tuple([lng, lat])).min(4).max(300) }).strict();
export const activeSchema = z.object({ isActive: z.boolean() }).strict();
export const promoBroadcastSchema = z.object({ title: text(3, 80), body: text(3, 300), role: z.nativeEnum(Role).optional(), limit: z.number().int().min(1).max(5000).optional() }).strict();
