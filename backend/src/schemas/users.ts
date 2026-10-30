import { z } from 'zod';
import { httpsUrl, text } from './common';

export const updateProfileSchema = z.object({ fullName: text(2, 100).optional(), avatarUrl: httpsUrl.optional(), marketingConsent: z.boolean().optional() }).strict();
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
