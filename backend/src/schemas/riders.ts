import { DocumentType, VehicleType } from '@prisma/client';
import { z } from 'zod';
import { lat, lng, qLimit, qPage, text } from './common';

export const updateVehicleSchema = z.object({ vehicleType: z.nativeEnum(VehicleType), vehiclePlate: text(0, 20).optional() }).strict();
/** Object key of an uploaded file; must sit under riders/<your id>/ (checked in the service). */
export const submitDocumentSchema = z.object({ type: z.nativeEnum(DocumentType), storageKey: z.string().max(200).regex(/^riders\//) }).strict();
/** lat/lng are required when going online (the service enforces it, with a precise error). */
export const setStatusSchema = z.object({ isOnline: z.boolean(), lat: lat.optional(), lng: lng.optional() }).strict();
export const presenceSchema = z.object({ lat, lng }).strict();
export const rejectOfferSchema = z.object({ reason: text(0, 200).optional() }).strict();
export const reasonBodySchema = z.object({ reason: text(3, 200) }).strict();
export const riderHistorySchema = z.object({ page: qPage(), limit: qLimit(50) }).strict();

export type UpdateVehicleDto = z.infer<typeof updateVehicleSchema>;
export type SubmitDocumentDto = z.infer<typeof submitDocumentSchema>;
export type SetStatusDto = z.infer<typeof setStatusSchema>;
export type PresenceDto = z.infer<typeof presenceSchema>;
export type RiderHistoryDto = z.infer<typeof riderHistorySchema>;
