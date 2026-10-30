import { Client } from 'pg';
import { buildInsertPolygonZone, buildListZonesQuery, buildPolygonCheckQuery, buildSalesSummaryQuery, MAX_ZONE_AREA_M2, ringToWkt } from '../src/restaurants/zones.sql';
import { buildDeliverableQuery } from '../src/discovery/discovery.sql';

/** Runs the owner-side SQL (polygon zones, sales summary) against real PostGIS. Enable with TEST_DATABASE_URL. */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const DDL = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED','SUSPENDED');
CREATE TYPE "ZoneType" AS ENUM ('RADIUS','POLYGON');
CREATE TABLE restaurants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, lat float8 NOT NULL, lng float8 NOT NULL,
  location geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography) STORED,
  "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED', "isPaused" boolean NOT NULL DEFAULT false,
  "minOrderMinor" int NOT NULL DEFAULT 0, "baseDeliveryFeeMinor" int NOT NULL DEFAULT 5000);
CREATE TABLE service_areas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "isActive" boolean DEFAULT true, polygon geography(Polygon,4326));
CREATE TABLE delivery_zones (id uuid PRIMARY KEY, "restaurantId" uuid NOT NULL, name text, type "ZoneType" NOT NULL, "radiusMeters" int,
  polygon geography(Polygon,4326), "deliveryFeeMinor" int, "minOrderMinor" int, "isActive" boolean NOT NULL DEFAULT true, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "restaurantId" uuid, status text, "subtotalMinor" int, "commissionBps" int, "placedAt" timestamp(3));
`;

d('owner SQL against PostGIS', () => {
  let c: Client;
  let rid: string;
  const run = async (q: { text: string; values: unknown[] }) => (await c.query(q.text, q.values as any[])).rows;
  const square = [[90.40, 23.78], [90.42, 23.78], [90.42, 23.80], [90.40, 23.80], [90.40, 23.78]] as [number, number][];
  const clockwise = [...square].reverse();
  const inside = { lat: 23.79, lng: 90.41 };
  const outside = { lat: 23.70, lng: 90.30 };

  beforeAll(async () => {
    c = new Client({ connectionString: url });
    await c.connect();
    await c.query("SET TIME ZONE 'Asia/Dhaka'; DROP SCHEMA IF EXISTS ff_otest CASCADE; CREATE SCHEMA ff_otest; SET search_path TO ff_otest, public;"); // non-UTC session on purpose
    await c.query(DDL);
    rid = (await c.query(`INSERT INTO restaurants (name, lat, lng) VALUES ('R', 23.75, 90.38) RETURNING id`)).rows[0].id;
  });
  afterAll(async () => {
    await c.query('DROP SCHEMA IF EXISTS ff_otest CASCADE');
    await c.end();
  });

  it('validates polygons: valid ring passes, bow-tie is flagged, area is measured geodesically', async () => {
    const ok = (await run(buildPolygonCheckQuery(ringToWkt(square))))[0];
    expect(ok.valid).toBe(true);
    expect(ok.area).toBeGreaterThan(4e6); // ~2.0 km × 2.4 km
    expect(ok.area).toBeLessThan(6e6);
    const bowtie = (await run(buildPolygonCheckQuery(ringToWkt([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]))))[0];
    expect(bowtie.valid).toBe(false);
    expect(bowtie.reason).toMatch(/self-intersection/i);
    const huge = (await run(buildPolygonCheckQuery(ringToWkt([[80, 10], [100, 10], [100, 30], [80, 30], [80, 10]]))))[0];
    expect(huge.area).toBeGreaterThan(MAX_ZONE_AREA_M2); // would be rejected by the service
  });

  it('winding order cannot turn a zone into "the whole planet": clockwise and counter-clockwise rings behave the same', async () => {
    for (const ring of [square, clockwise]) {
      const [{ id }] = await run(buildInsertPolygonZone({ restaurantId: rid, name: 'Z', wkt: ringToWkt(ring), deliveryFeeMinor: 4000, minOrderMinor: null }));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const hit = await run(buildDeliverableQuery(rid, inside.lat, inside.lng));
      const miss = await run(buildDeliverableQuery(rid, outside.lat, outside.lng));
      expect(hit).toHaveLength(1);
      expect(hit[0].deliveryFeeMinor).toBe(4000);
      expect(miss).toHaveLength(0);
      await c.query('DELETE FROM delivery_zones');
    }
  });

  it('lists zones with polygons as GeoJSON and radius zones without', async () => {
    await run(buildInsertPolygonZone({ restaurantId: rid, name: 'Poly', wkt: ringToWkt(square), deliveryFeeMinor: null, minOrderMinor: 10000 }));
    await c.query(`INSERT INTO delivery_zones (id, "restaurantId", name, type, "radiusMeters") VALUES (gen_random_uuid(), $1, 'Radius', 'RADIUS', 3000)`, [rid]);
    const zones = await run(buildListZonesQuery(rid));
    expect(zones.map((z) => z.name)).toEqual(['Poly', 'Radius']);
    expect(zones[0].type).toBe('POLYGON');
    expect(zones[0].polygon.type).toBe('Polygon');
    expect(zones[0].polygon.coordinates[0]).toHaveLength(5);
    expect(zones[0].deliveryFeeMinor).toBeNull();
    expect(zones[0].minOrderMinor).toBe(10000);
    expect(zones[1].polygon).toBeNull();
    expect(await run(buildListZonesQuery('99999999-9999-9999-9999-999999999999'))).toHaveLength(0);
  });

  it('summarises sales: delivered only for revenue, snapshot commission, date range, restaurant isolation', async () => {
    const other = (await c.query(`INSERT INTO restaurants (name, lat, lng) VALUES ('Other', 23.7, 90.3) RETURNING id`)).rows[0].id;
    const ins = (r: string, status: string, sub: number, bps: number, at: string) =>
      c.query(`INSERT INTO orders ("restaurantId", status, "subtotalMinor", "commissionBps", "placedAt") VALUES ($1,$2,$3,$4,$5)`, [r, status, sub, bps, at]);
    await ins(rid, 'DELIVERED', 100000, 1500, '2026-10-05T10:00:00Z'); // commission 15000
    await ins(rid, 'DELIVERED', 33333, 1000, '2026-10-06T10:00:00Z'); // 3333.3 → 3333
    await ins(rid, 'DELIVERED', 50000, 1500, '2026-09-01T10:00:00Z'); // outside range
    await ins(rid, 'CANCELLED', 99999, 1500, '2026-10-07T10:00:00Z');
    await ins(rid, 'REJECTED_BY_RESTAURANT', 1000, 1500, '2026-10-07T11:00:00Z');
    await ins(rid, 'PREPARING', 20000, 1500, '2026-10-08T10:00:00Z');
    await ins(rid, 'PAYMENT_FAILED', 20000, 1500, '2026-10-08T11:00:00Z'); // counted nowhere
    await ins(other, 'DELIVERED', 777777, 1500, '2026-10-05T10:00:00Z');
    const [s] = await run(buildSalesSummaryQuery(rid, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z')));
    expect(s).toEqual({ deliveredCount: 2, cancelledCount: 2, inProgressCount: 1, grossMinor: 133333, commissionMinor: 18333 });
    const [empty] = await run(buildSalesSummaryQuery(rid, new Date('2027-01-01T00:00:00Z'), new Date('2027-02-01T00:00:00Z')));
    expect(empty).toEqual({ deliveredCount: 0, cancelledCount: 0, inProgressCount: 0, grossMinor: 0, commissionMinor: 0 });
  });
});
