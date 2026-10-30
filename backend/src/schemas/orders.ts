import { OrderStatus, PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { phone, qLimit, qPage, text, uuid } from './common';

export const quoteSchema = z.object({ addressId: uuid, couponCode: text(1, 40).optional() }).strict();

export const placeOrderSchema = z
  .object({
    addressId: uuid, paymentMethod: z.nativeEnum(PaymentMethod), contactPhone: phone.optional(),
    deliveryInstructions: text(0, 300).optional(), customerNote: text(0, 300).optional(), couponCode: text(1, 40).optional(),
  })
  .strict();
export const cancelOrderSchema = z.object({ reason: text(3, 200).optional() }).strict();
export const listOrdersSchema = z.object({ page: qPage(), limit: qLimit(50), status: z.nativeEnum(OrderStatus).optional() }).strict();

export type QuoteDto = z.infer<typeof quoteSchema>;
export type PlaceOrderDto = z.infer<typeof placeOrderSchema>;
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;
export type ListOrdersDto = z.infer<typeof listOrdersSchema>;
