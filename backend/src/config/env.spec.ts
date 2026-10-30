import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  CORS_ORIGINS: 'http://localhost:3000, https://app.example.com',
  APP_URL: 'http://localhost:3000',
};

describe('env validation', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'https://app.example.com']);
    expect(env.COOKIE_SECURE).toBe(false);
  });
  it('rejects a short JWT secret', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });
  it('rejects missing required values', () => {
    expect(() => validateEnv({})).toThrow(/Invalid environment configuration/);
  });
  it('requires secure cookies in production and with SameSite=none', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
    expect(() => validateEnv({ ...base, COOKIE_SAMESITE: 'none' })).toThrow(/COOKIE_SECURE/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).not.toThrow();
  });
  it('requires all Cloudinary credentials together', () => {
    expect(() => validateEnv({ ...base, CLOUDINARY_CLOUD_NAME: 'foodflow' })).toThrow(/CLOUDINARY_CLOUD_NAME/);
    expect(() => validateEnv({
      ...base,
      CLOUDINARY_CLOUD_NAME: 'foodflow',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
    })).not.toThrow();
  });
});
