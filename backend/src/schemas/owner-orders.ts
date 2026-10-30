import { OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { qLimit, qPage, text } from './common';

export const listOwnerOrdersSchema = z.object({ scope: z.enum(['active', 'history']).optional(), status: z.nativeEnum(OrderStatus).optional(), page: qPage(), limit: qLimit(50) }).strict();
export const acceptOrderSchema = z.object({ prepMinutes: z.number().int().min(5).max(180).optional() }).strict();
export const orderReasonSchema = z.object({ reason: text(3, 200) }).strict();

export type ListOwnerOrdersDto = z.infer<typeof listOwnerOrdersSchema>;
export type AcceptOrderDto = z.infer<typeof acceptOrderSchema>;
export type OrderReasonDto = z.infer<typeof orderReasonSchema>;
