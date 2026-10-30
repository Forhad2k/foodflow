import { ApprovalStatus } from '@prisma/client';
import { z } from 'zod';
import { qLimit, qPage, text, uuid } from './common';

const list = { status: z.nativeEnum(ApprovalStatus).optional(), q: z.string().trim().max(80).optional(), page: qPage(), limit: qLimit(100) };
export const adminListRestaurantsSchema = z.object(list).strict();
export const adminListRidersSchema = z.object(list).strict();
export const reasonSchema = z.object({ reason: text(3, 300) }).strict();
/** null → use the platform default. 1500 = 15%. */
export const setCommissionSchema = z.object({ commissionBps: z.number().int().min(0).max(5000).nullable().optional() }).strict();
export const reviewDocumentSchema = z.object({ approve: z.boolean(), reason: text(3, 300).optional() }).strict();
export const assignRiderSchema = z.object({ riderId: uuid, replace: z.boolean().optional() }).strict();

export type AdminListRestaurantsDto = z.infer<typeof adminListRestaurantsSchema>;
export type AdminListRidersDto = z.infer<typeof adminListRidersSchema>;
export type ReasonDto = z.infer<typeof reasonSchema>;
export type SetCommissionDto = z.infer<typeof setCommissionSchema>;
export type ReviewDocumentDto = z.infer<typeof reviewDocumentSchema>;
export type AssignRiderDto = z.infer<typeof assignRiderSchema>;
