import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool.default('false'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  /** Comma-separated list of exact origins allowed by CORS and by the cookie CSRF guard. */
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  /** Public frontend URL, used to build password-reset links. */
  APP_URL: z.string().url(),

  COOKIE_SECURE: bool.default('false'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),

  /** Background jobs (order accept-timeout…). Set false for one-off scripts/tests; safe to run on several instances. */
  JOBS_ENABLED: bool.default('true'),
  /** Optional comma-separated image hosts allowed for menu/restaurant images, e.g. "res.cloudinary.com". Empty = any https host. */
  IMAGE_HOST_ALLOWLIST: z.string().default('').transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  /** Public base URL of this API (payment return/redirect links). */
  API_URL: z.string().url().default('http://localhost:4000'),
  /** 'none' disables online payment (cash only). 'dev' is a SIMULATED gateway for local development; it is refused in production. */
  PAYMENT_PROVIDER: z.enum(['none', 'dev']).default('none'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
  LOCATION_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be "true" in production');
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }
  if (env.PAYMENT_PROVIDER !== 'none' && !env.PAYMENT_WEBHOOK_SECRET) throw new Error('PAYMENT_WEBHOOK_SECRET (>= 32 chars) is required when PAYMENT_PROVIDER is set');
  if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'dev') throw new Error('PAYMENT_PROVIDER=dev is a simulated gateway and must not be used in production');
  const cloudinaryValues = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET];
  if (cloudinaryValues.some(Boolean) && !cloudinaryValues.every(Boolean)) {
    throw new Error('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be configured together');
  }
  return env;
}
