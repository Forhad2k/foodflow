import { Client } from 'pg';
import { buildCandidatesQuery, buildDeliverableQuery } from '../src/discovery/discovery.sql';

/**
 * Runs the real discovery SQL against a real PostGIS. Enable with:
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test
 * It creates a throw-away schema containing ONLY the tables/columns the queries touch, mirroring
 * prisma/schema.prisma + prisma/sql/001_postgis_and_constraints.sql, and drops it afterwards.
 */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const DDL = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED','SUSPENDED');
CREATE TYPE "ZoneType" AS ENUM ('RADIUS','POLYGON');
CREATE TABLE cuisine_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, slug text UNIQUE);
CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE,
  lat float8 NOT NULL, lng float8 NOT NULL,
  location geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography) STORED,
  "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED', "isPaused" boolean NOT NULL DEFAULT false,
  "minOrderMinor" int NOT NULL DEFAULT 0, "baseDeliveryFeeMinor" int NOT NULL DEFAULT 5000,
  "priceTier" int NOT NULL DEFAULT 2, "ratingAvg" float8 NOT NULL DEFAULT 0, "ratingCount" int NOT NULL DEFAULT 0);
CREATE INDEX ON restaurants USING GIST (location);
CREATE TABLE restaurant_cuisines ("restaurantId" uuid, "cuisineId" uuid);
CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "restaurantId" uuid NOT NULL, name text, type "ZoneType" NOT NULL,
  "radiusMeters" int, polygon geography(Polygon,4326), "deliveryFeeMinor" int, "minOrderMinor" int, "isActive" boolean NOT NULL DEFAULT true);
CREATE TABLE service_areas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, "isActive" boolean NOT NULL DEFAULT true, polygon geography(Polygon,4326));
CREATE TABLE menu_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "restaurantId" uuid, name text, "isAvailable" boolean DEFAULT true, "deletedAt" timestamptz);
`;

d('discovery SQL against PostGIS', () => {
  let c: Client;
  const ids: Record<string, string> = {};
  const gulshan = { lat: 23.7925, lng: 90.4078 };

  const insertRestaurant = async (key: string, name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => {
    const cols = { name, lat, lng, slug: key, ...extra };
    const keys = Object.keys(cols);
    const res = await c.query(
      `INSERT INTO restaurants (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(cols),
    );
    ids[key] = res.rows[0].id;
  };
  const zone = (key: string, type: 'RADIUS' | 'POLYGON', o: { radius?: number; wkt?: string; fee?: number | null; min?: number | null; active?: boolean } = {}) =>
    c.query(
      `INSERT INTO delivery_zones ("restaurantId", type, "radiusMeters", polygon, "deliveryFeeMinor", "minOrderMinor", "isActive")
       VALUES ($1, $2, $3, ${o.wkt ? `ST_GeogFromText('${o.wkt}')` : 'NULL'}, $4, $5, $6)`,
      [ids[key], type, o.radius ?? null, o.fee ?? null, o.min ?? null, o.active ?? true],
    );
  const run = async (sql: { text: string; values: unknown[] }) => (await c.query(sql.text, sql.values as any[])).rows;
  const params = (o: Partial<Parameters<typeof buildCandidatesQuery>[0]> = {}) => ({ ...gulshan, maxRadiusMeters: 8000, limit: 50, ...o });

  beforeAll(async () => {
    c = new Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS ff_sqltest CASCADE; CREATE SCHEMA ff_sqltest; SET search_path TO ff_sqltest, public;');
    await c.query(DDL);

    await insertRestaurant('near', 'Kacchi Bhai', 23.7937, 90.4066, { ratingAvg: 4.5, ratingCount: 20, priceTier: 2 });
    await insertRestaurant('mid', 'Pizza Hub', 23.7600, 90.3900, { priceTier: 3 });
    await insertRestaurant('far', 'Far Away Grill', 23.9000, 90.5000); // ~16 km
    await insertRestaurant('paused', 'Paused Cafe', 23.7930, 90.4070, { isPaused: true });
    await insertRestaurant('pending', 'Pending Diner', 23.7930, 90.4070, { approvalStatus: 'PENDING' });
    await insertRestaurant('nozone', 'No Zone Burger', 23.7930, 90.4070);
    await insertRestaurant('poly', 'Polygon Place', 23.7500, 90.3800, { baseDeliveryFeeMinor: 9000 });
    await insertRestaurant('tiny', 'Tiny Radius', 23.7940, 90.4080);
    await zone('near', 'RADIUS', { radius: 3000 });
    await zone('mid', 'RADIUS', { radius: 8000, fee: 7000, min: 20000 });
    await zone('far', 'RADIUS', { radius: 30000 });
    await zone('paused', 'RADIUS', { radius: 3000 });
    await zone('pending', 'RADIUS', { radius: 3000 });
    // polygon covering a box around Gulshan only (not around the restaurant itself)
    await zone('poly', 'POLYGON', { wkt: 'POLYGON((90.40 23.78, 90.42 23.78, 90.42 23.80, 90.40 23.80, 90.40 23.78))', fee: 4000 });
    await zone('tiny', 'RADIUS', { radius: 50 }); // 50 m only
    await zone('near', 'RADIUS', { radius: 3000, active: false, fee: 1 }); // inactive duplicate must be ignored
    await c.query(`INSERT INTO menu_items ("restaurantId", name) VALUES ($1,'Beef Tehari'),($1,'Borhani')`, [ids.near]);
    await c.query(`INSERT INTO menu_items ("restaurantId", name, "isAvailable") VALUES ($1,'Hidden Burger', false)`, [ids.nozone]);
    await c.query(`INSERT INTO cuisine_types (name, slug) VALUES ('Biryani','biryani')`);
    await c.query(`INSERT INTO restaurant_cuisines SELECT $1, id FROM cuisine_types WHERE slug='biryani'`, [ids.near]);
  });

  afterAll(async () => {
    await c.query('DROP SCHEMA IF EXISTS ff_sqltest CASCADE');
    await c.end();
  });

  const names = (rows: any[]) => rows.map((r) => r.id);

  it('returns only approved, unpaused restaurants whose ACTIVE zone covers the address, nearest first', async () => {
    const rows = await run(buildCandidatesQuery(params()));
    const got = names(rows);
    expect(got).toContain(ids.near);
    expect(got).toContain(ids.mid);
    expect(got).toContain(ids.poly); // covered by polygon even though its pin is ~5 km away
    expect(got).not.toContain(ids.paused);
    expect(got).not.toContain(ids.pending);
    expect(got).not.toContain(ids.nozone); // no zone → never offered, even though it is next door
    expect(got).not.toContain(ids.far); // outside max radius
    expect(got[0]).toBe(ids.near);
    expect(rows.map((r) => r.distanceMeters)).toEqual([...rows.map((r) => r.distanceMeters)].sort((a, b) => a - b));
  });

  it('proximity alone does not imply delivery: a nearby restaurant with a too-small zone is excluded', async () => {
    expect(names(await run(buildCandidatesQuery(params({ lat: 23.7960, lng: 90.4110 }))))).not.toContain(ids.tiny);
    expect(names(await run(buildCandidatesQuery(params({ lat: 23.7941, lng: 90.4081 }))))).toContain(ids.tiny);
  });

  it('applies zone fee/min-order overrides, falling back to the restaurant defaults', async () => {
    const rows = await run(buildCandidatesQuery(params()));
    const by = (k: string) => rows.find((r) => r.id === ids[k]);
    expect(by('near').deliveryFeeMinor).toBe(5000); // restaurant base (active zone has no override; inactive zone ignored)
    expect(by('mid').deliveryFeeMinor).toBe(7000);
    expect(by('mid').minOrderMinor).toBe(20000);
    expect(by('poly').deliveryFeeMinor).toBe(4000);
  });

  it('searches restaurant names and available dishes, escaping wildcards', async () => {
    const dish = await run(buildCandidatesQuery(params({ q: 'tehari' })));
    expect(names(dish)).toEqual([ids.near]);
    expect(dish[0]).toMatchObject({ nameMatch: false, dishMatch: true });
    expect(names(await run(buildCandidatesQuery(params({ q: 'pizza' }))))).toEqual([ids.mid]);
    expect(await run(buildCandidatesQuery(params({ q: '%' })))).toHaveLength(0); // literal %, not "match all"
    expect(await run(buildCandidatesQuery(params({ q: "x'; DROP TABLE restaurants;--" })))).toHaveLength(0);
  });

  it('filters by cuisine, price tier and rating', async () => {
    expect(names(await run(buildCandidatesQuery(params({ cuisineSlugs: ['biryani'] }))))).toEqual([ids.near]);
    expect(names(await run(buildCandidatesQuery(params({ priceTiers: [3] }))))).toEqual([ids.mid]);
    const rated = names(await run(buildCandidatesQuery(params({ minRating: 4 }))));
    expect(rated).toContain(ids.near);
    expect(rated).toContain(ids.mid); // unrated restaurants are not filtered out by a rating floor
  });

  it('honours the admin service area when any is defined', async () => {
    await c.query(`INSERT INTO service_areas (name, polygon) VALUES ('Gulshan only', ST_GeogFromText('POLYGON((90.39 23.77, 90.43 23.77, 90.43 23.81, 90.39 23.81, 90.39 23.77))'))`);
    expect(names(await run(buildCandidatesQuery(params())))).toContain(ids.near);
    // an address outside every active service area gets nothing at all
    expect(await run(buildCandidatesQuery(params({ lat: 23.7000, lng: 90.3500 })))).toHaveLength(0);
    await c.query(`UPDATE service_areas SET "isActive" = false`);
    expect(names(await run(buildCandidatesQuery(params({ lat: 23.7600, lng: 90.3900 }))))).toContain(ids.mid);
  });

  it('single-restaurant deliverability (checkout re-validation) matches the listing', async () => {
    const ok = await run(buildDeliverableQuery(ids.near, gulshan.lat, gulshan.lng));
    expect(ok).toHaveLength(1);
    expect(ok[0].deliveryFeeMinor).toBe(5000);
    expect(await run(buildDeliverableQuery(ids.paused, gulshan.lat, gulshan.lng))).toHaveLength(0);
    expect(await run(buildDeliverableQuery(ids.nozone, gulshan.lat, gulshan.lng))).toHaveLength(0);
    expect(await run(buildDeliverableQuery(ids.near, 24.5, 91.5))).toHaveLength(0); // far outside the zone
  });
});
