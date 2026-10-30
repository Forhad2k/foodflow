import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { schemaToSql } from './schema-to-sql';

/**
 * Integration harness: a REAL Prisma client against a REAL PostgreSQL/PostGIS, in a throw-away schema.
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db   (required; the database must have PostGIS available)
 *   FF_WASM_CLIENT=/abs/path/to/node_modules/.ff-wasm-client      (optional; see scripts/make-wasm-test-client.sh)
 * The schema is built from prisma/schema.prisma + prisma/sql/001_postgis_and_constraints.sql, so the production
 * constraints (partial unique indexes, CHECKs, generated geography columns) are exercised for real.
 */
export const IT_URL = process.env.TEST_DATABASE_URL;
export const SCHEMA = 'ff_it';
export const describeIt = IT_URL ? describe : describe.skip;

export interface TestEnv {
  prisma: PrismaService;
  pool: Pool;
  close: () => Promise<void>;
}

export async function setupDatabase(): Promise<TestEnv> {
  const admin = new Pool({ connectionString: IT_URL, max: 1 });
  await admin.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  const conn = await admin.connect();
  try {
    await conn.query(`SET search_path TO ${SCHEMA}, public`);
    await conn.query(schemaToSql().replace('CREATE EXTENSION IF NOT EXISTS postgis;', ''));
    await conn.query(readFileSync(join(__dirname, '../../prisma/sql/001_postgis_and_constraints.sql'), 'utf8'));
  } finally {
    conn.release();
    await admin.end();
  }

  const wasm = process.env.FF_WASM_CLIENT;
  let prisma: any;
  let pool: Pool;
  if (wasm) {
    const { PrismaClient } = require(join(wasm, 'wasm.js'));
    const { PrismaPg } = require('@prisma/adapter-pg');
    pool = new Pool({ connectionString: IT_URL, max: 12, options: `-c search_path=${SCHEMA},public -c timezone=Asia/Dhaka` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: SCHEMA }) });
  } else {
    const { PrismaClient } = require('@prisma/client');
    const url = new URL(IT_URL!);
    url.searchParams.set('schema', SCHEMA);
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    pool = new Pool({ connectionString: IT_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
  }
  return {
    prisma: prisma as PrismaService,
    pool,
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
      const cleanup = new Pool({ connectionString: IT_URL, max: 1 });
      await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await cleanup.end();
    },
  };
}

export const testEnv = validateEnv({
  DATABASE_URL: IT_URL ?? 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'integration-secret-integration-secret-123',
  CORS_ORIGINS: 'http://localhost:3000', APP_URL: 'http://localhost:3000', LOG_LEVEL: 'silent', JOBS_ENABLED: 'false', NODE_ENV: 'test',
});

/** The real composition root (every service wired as in production), around the test database. */
export const buildServices = (prisma: PrismaService, env = testEnv) => createContainer({ prisma, env });

/** Same environment with the SIMULATED payment gateway switched on. */
export const onlineEnv = validateEnv({ ...Object.fromEntries(Object.entries({ DATABASE_URL: IT_URL ?? 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'integration-secret-integration-secret-123', CORS_ORIGINS: 'http://localhost:3000', APP_URL: 'http://localhost:3000', LOG_LEVEL: 'silent', JOBS_ENABLED: 'false', NODE_ENV: 'test' })), PAYMENT_PROVIDER: 'dev', PAYMENT_WEBHOOK_SECRET: 'webhook-secret-webhook-secret-123456' });

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export const factories = (prisma: PrismaService) => ({
  async user(role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'RIDER' | 'ADMIN', o: { phone?: string; name?: string } = {}) {
    const id = uniq();
    return prisma.user.create({
      data: {
        email: `${role.toLowerCase()}-${id}@test.local`, role, phone: o.phone ?? `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        profile: { create: { fullName: o.name ?? `Test ${role} ${id}` } },
        ...(role === 'RIDER' && { riderProfile: { create: {} } }),
      },
    });
  },

  async address(userId: string, lat = 23.7937, lng = 90.4066) {
    return prisma.address.create({ data: { userId, label: 'Home', line1: 'House 1, Road 2', city: 'Dhaka', lat, lng, isDefault: true } });
  },

  /** A live (APPROVED, open 24/7, 4 km radius zone) restaurant with one category and the given items. */
  async restaurant(ownerId: string, o: { lat?: number; lng?: number; minOrderMinor?: number; baseFee?: number; items?: { name: string; price: number; stock?: number | null; variants?: [string, number][] }[]; approval?: 'APPROVED' | 'PENDING' } = {}) {
    const r = await prisma.restaurant.create({
      data: {
        ownerId, name: `Resto ${uniq()}`, slug: `resto-${uniq()}`, phone: '+8801700000009', addressLine: 'Gulshan 2', city: 'Dhaka',
        lat: o.lat ?? 23.7925, lng: o.lng ?? 90.4078, approvalStatus: o.approval ?? 'APPROVED', minOrderMinor: o.minOrderMinor ?? 0, baseDeliveryFeeMinor: o.baseFee ?? 5000,
        zones: { create: [{ name: 'Local', type: 'RADIUS', radiusMeters: 4000 }] },
        hours: { create: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, opensAtMin: 0, closesAtMin: 1440 })) },
      },
    });
    const category = await prisma.menuCategory.create({ data: { restaurantId: r.id, name: 'Mains' } });
    const items = [];
    for (const it of o.items ?? [{ name: 'Burger', price: 30000 }]) {
      items.push(await prisma.menuItem.create({
        data: {
          restaurantId: r.id, categoryId: category.id, name: it.name, basePriceMinor: it.price, stockQuantity: it.stock ?? null,
          ...(it.variants && { variants: { create: it.variants.map(([name, priceMinor], i) => ({ name, priceMinor, isDefault: i === 0 })) } }),
        },
        include: { variants: true },
      }));
    }
    return { restaurant: r, items };
  },

  async coupon(o: { code: string; type?: 'FIXED_AMOUNT' | 'PERCENTAGE' | 'FREE_DELIVERY'; value?: number; usageLimitTotal?: number | null; usageLimitPerUser?: number; firstOrderOnly?: boolean }) {
    return prisma.coupon.create({
      data: {
        code: o.code, type: o.type ?? 'FIXED_AMOUNT', value: o.value ?? 5000, usageLimitTotal: o.usageLimitTotal ?? null, usageLimitPerUser: o.usageLimitPerUser ?? 1,
        firstOrderOnly: o.firstOrderOnly ?? false, startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000),
      },
    });
  },
});
