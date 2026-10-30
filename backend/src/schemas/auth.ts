import { Role } from '@prisma/client';
import { z } from 'zod';
import { phone, text } from './common';

/** Roles that may self-register. ADMIN accounts are created only by seed/ops, never through the API. */
export const SELF_REGISTER_ROLES = [Role.CUSTOMER, Role.RESTAURANT_OWNER, Role.RIDER] as const;

const email = z.string().trim().toLowerCase().email().max(254);
const newPassword = z.string().min(10, 'password must be at least 10 characters').max(128);

export const registerSchema = z.object({ email, password: newPassword, fullName: text(2, 100), phone: phone.optional(), role: z.enum(SELF_REGISTER_ROLES) }).strict();
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const forgotPasswordSchema = z.object({ email }).strict();
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: newPassword }).strict();

export type RegisterDto = z.infer<typeof registerSchema>;
