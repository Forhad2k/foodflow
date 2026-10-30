import { z } from 'zod';
import { lat, lng, qLimit, qPage, text, uuid } from './common';

export const clientMessageId = z.string().min(8).max(64).regex(/^[\w-]+$/);
export const orderRef = z.object({ orderId: uuid }).strict();
export const chatSendSocket = z.object({ orderId: uuid, body: z.string().max(2000), clientMessageId }).strict();
export const chatReadSocket = z.object({ orderId: uuid, upToMessageId: uuid.optional() }).strict();
export const riderLocationSocket = z
  .object({ orderId: uuid, lat, lng, accuracyM: z.number().min(0).max(10_000).optional(), headingDeg: z.number().min(0).max(360).optional(), speedMps: z.number().min(0).max(100).optional() })
  .strict();

/** REST fallbacks for chat (same service, same rules as the socket events). */
export const chatSendRest = z.object({ body: z.string().max(2000), clientMessageId: clientMessageId.optional() }).strict();
export const chatHistoryQuery = z.object({ before: z.coerce.date().optional(), limit: qLimit(100) }).strict();
export const chatReadRest = z.object({ upToMessageId: uuid.optional() }).strict();
export const reportMessageSchema = z.object({ reason: text(3, 300) }).strict();
export const notificationsQuery = z.object({ unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), page: qPage(), limit: qLimit(50) }).strict();
export const reviewReportSchema = z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) }).strict();
export const adminReportsQuery = z.object({ status: z.enum(['OPEN', 'REVIEWED', 'DISMISSED']).optional(), page: qPage(), limit: qLimit(100) }).strict();
