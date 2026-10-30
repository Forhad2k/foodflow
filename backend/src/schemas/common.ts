import { z } from 'zod';

export const uuid = z.string().uuid();
export const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be in E.164 format, e.g. +8801712345678');
export const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const lat = z.number().finite().min(-90).max(90);
export const lng = z.number().finite().min(-180).max(180);
export const minor = (max = 100_000_000) => z.number().int().min(0).max(max); // money in minor units
export const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'must be an https URL');

/** Query-string numbers: "" and junk fail instead of silently becoming 0. */
export const qNum = () => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? NaN : v), z.coerce.number());
export const qInt = () => qNum().pipe(z.number().int());
export const qPage = () => qInt().pipe(z.number().min(1)).optional();
export const qLimit = (max: number) => qInt().pipe(z.number().min(1).max(max)).optional();
export const qCsv = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string()));
