import { createHash, randomBytes } from 'crypto';

/** 256-bit URL-safe opaque token. Only its sha256 is ever persisted. */
export const generateOpaqueToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
