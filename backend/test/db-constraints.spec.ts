import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * Executes prisma/sql/001_postgis_and_constraints.sql for real and proves the guarantees the application relies on.
 * Enable with TEST_DATABASE_URL (needs PostGIS). Uses a throw-away schema with stub tables holding the columns the
 * SQL touches (as Prisma's init migration would create them), then drops it.
 */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const STUBS = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE restaurants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lat float8 NOT NULL, lng float8 NOT NULL, location geography(Point,4326), "commissionBps" int);
CREATE TABLE rider_profiles ("userId" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "lastLat" float8, "lastLng" float8, location geography(Point,4326), "maxActiveDeliveries" int NOT NULL DEFAULT 1);
CREATE TABLE delivery_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "orderId" uuid NOT NULL, "riderId" uuid NOT NULL, status text NOT NULL);
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "orderId" uuid NOT NULL, status text NOT NULL, "amountMinor" int NOT NULL);
CREATE TABLE addresses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lat float8 NOT NULL, lng float8 NOT NULL);
CREATE TABLE operating_hours (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "dayOfWeek" int, "opensAtMin" int, "closesAtMin" int);
CREATE TABLE menu_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "basePriceMinor" int, "stockQuantity" int);
CREATE TABLE item_variants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "priceMinor" int);
CREATE TABLE addons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "priceMinor" int);
CREATE TABLE cart_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quantity int);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "subtotalMinor" int, "deliveryFeeMinor" int, "serviceFeeMinor" int, "discountMinor" int, "taxMinor" int, "totalMinor" int);
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quantity int, "unitPriceMinor" int, "lineTotalMinor" int);
CREATE TABLE refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "amountMinor" int);
CREATE TABLE reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "restaurantRating" int, "riderRating" int);
CREATE TABLE coupons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, value int, "startsAt" timestamptz, "endsAt" timestamptz);
CREATE TABLE rider_location_updates (id bigserial PRIMARY KEY, lat float8, lng float8);
`;

d('001_postgis_and_constraints.sql', () => {
  let c: Client;
  const rejects = async (sql: string, values: unknown[] = []) => {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, values as any[]);
      await c.query('ROLLBACK TO SAVEPOINT s');
      return false;
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return true;
    }
  };

  beforeAll(async () => {
    c = new Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS ff_ctest CASCADE; CREATE SCHEMA ff_ctest; SET search_path TO ff_ctest, public;');
    await c.query(STUBS);
    await c.query(readFileSync(join(__dirname, '../prisma/sql/001_postgis_and_constraints.sql'), 'utf8')); // the real file
    await c.query('BEGIN');
  });
  afterAll(async () => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.query('DROP SCHEMA IF EXISTS ff_ctest CASCADE');
    await c.end();
  });

  it('generates geography columns from lat/lng (and null for riders without a position)', async () => {
    await c.query('INSERT INTO restaurants (lat, lng) VALUES (23.79, 90.40)');
    const r = await c.query('SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM restaurants');
    expect(r.rows[0]).toEqual({ lat: 23.79, lng: 90.4 });
    await c.query('INSERT INTO rider_profiles ("lastLat","lastLng") VALUES (23.7, 90.3), (NULL, NULL)');
    const riders = await c.query('SELECT location IS NULL AS none FROM rider_profiles ORDER BY "lastLat" NULLS LAST');
    expect(riders.rows.map((x) => x.none)).toEqual([false, true]);
    expect(await rejects('UPDATE restaurants SET location = ST_GeogFromText(\'POINT(0 0)\')')).toBe(true); // generated: not writable
  });

  it('two riders can never hold the same live delivery; history of finished attempts is unlimited', async () => {
    const order = '11111111-1111-1111-1111-111111111111';
    const rider = () => c.query('SELECT gen_random_uuid() AS id').then((r) => r.rows[0].id);
    await c.query(`INSERT INTO delivery_assignments ("orderId","riderId",status) VALUES ($1,$2,'OFFERED')`, [order, await rider()]);
    expect(await rejects(`INSERT INTO delivery_assignments ("orderId","riderId",status) VALUES ($1,$2,'ACCEPTED')`, [order, await rider()])).toBe(true);
    expect(await rejects(`INSERT INTO delivery_assignments ("orderId","riderId",status) VALUES ($1,$2,'OFFERED')`, [order, await rider()])).toBe(true);
    // earlier attempts that ended do not block a new offer
    await c.query(`UPDATE delivery_assignments SET status='REJECTED' WHERE "orderId"=$1`, [order]);
    await c.query(`INSERT INTO delivery_assignments ("orderId","riderId",status) VALUES ($1,$2,'OFFERED')`, [order, await rider()]);
    await c.query(`INSERT INTO delivery_assignments ("orderId","riderId",status) VALUES ($1,$2,'EXPIRED'),($1,$2,'EXPIRED')`, [order, await rider()]);
  });

  it('only one SUCCESSFUL payment per order (duplicate callbacks cannot double-credit)', async () => {
    const order = '22222222-2222-2222-2222-222222222222';
    await c.query(`INSERT INTO payments ("orderId",status,"amountMinor") VALUES ($1,'SUCCESSFUL',100)`, [order]);
    expect(await rejects(`INSERT INTO payments ("orderId",status,"amountMinor") VALUES ($1,'SUCCESSFUL',100)`, [order])).toBe(true);
    await c.query(`INSERT INTO payments ("orderId",status,"amountMinor") VALUES ($1,'FAILED',100),($1,'FAILED',100),($1,'REFUNDED',100)`, [order]);
  });

  it('rejects orders whose total does not add up, and negative money', async () => {
    const ins = (sub: number, del: number, svc: number, disc: number, tax: number, total: number) =>
      c.query(`INSERT INTO orders ("subtotalMinor","deliveryFeeMinor","serviceFeeMinor","discountMinor","taxMinor","totalMinor") VALUES ($1,$2,$3,$4,$5,$6)`, [sub, del, svc, disc, tax, total]);
    await ins(100000, 6000, 1000, 10000, 4500, 101500); // 100000+6000+1000+4500-10000
    expect(await rejects(`INSERT INTO orders ("subtotalMinor","deliveryFeeMinor","serviceFeeMinor","discountMinor","taxMinor","totalMinor") VALUES (100000,6000,1000,10000,4500,1)`)).toBe(true);
    expect(await rejects(`INSERT INTO orders ("subtotalMinor","deliveryFeeMinor","serviceFeeMinor","discountMinor","taxMinor","totalMinor") VALUES (-1,0,0,0,0,-1)`)).toBe(true);
    expect(await rejects(`INSERT INTO orders ("subtotalMinor","deliveryFeeMinor","serviceFeeMinor","discountMinor","taxMinor","totalMinor") VALUES (100,0,0,500,0,-400)`)).toBe(true); // discount beyond total
  });

  it('keeps stock, coordinates, ratings, quantities and coupon values sane', async () => {
    expect(await rejects('INSERT INTO menu_items ("basePriceMinor","stockQuantity") VALUES (100,-1)')).toBe(true);
    expect(await rejects('INSERT INTO addresses (lat,lng) VALUES (91,0)')).toBe(true);
    expect(await rejects('INSERT INTO addresses (lat,lng) VALUES (0,181)')).toBe(true);
    expect(await rejects('INSERT INTO reviews ("restaurantRating","riderRating") VALUES (6,5)')).toBe(true);
    expect(await rejects('INSERT INTO reviews ("restaurantRating","riderRating") VALUES (5,0)')).toBe(true);
    await c.query('INSERT INTO reviews ("restaurantRating","riderRating") VALUES (5,NULL)');
    expect(await rejects('INSERT INTO cart_items (quantity) VALUES (0)')).toBe(true);
    expect(await rejects('INSERT INTO cart_items (quantity) VALUES (100)')).toBe(true);
    expect(await rejects(`INSERT INTO coupons (type,value,"startsAt","endsAt") VALUES ('PERCENTAGE',150,now(),now()+interval '1 day')`)).toBe(true);
    expect(await rejects(`INSERT INTO coupons (type,value,"startsAt","endsAt") VALUES ('FIXED_AMOUNT',100,now(),now())`)).toBe(true);
    expect(await rejects('INSERT INTO refunds ("amountMinor") VALUES (0)')).toBe(true);
    expect(await rejects('INSERT INTO operating_hours ("dayOfWeek","opensAtMin","closesAtMin") VALUES (7,0,100)')).toBe(true);
    await c.query('INSERT INTO operating_hours ("dayOfWeek","opensAtMin","closesAtMin") VALUES (1,1080,1560)'); // after-midnight close is allowed
    expect(await rejects('INSERT INTO rider_profiles ("maxActiveDeliveries") VALUES (0)')).toBe(true);
  });
});
