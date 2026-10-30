-- FoodFlow: PostGIS generated columns, spatial indexes, partial unique indexes and CHECK constraints.
-- Prisma cannot express these. Apply ONCE, right after the first `prisma migrate dev --name init`,
-- by pasting this file into the end of the generated migration.sql (so it ships with the migration history).
-- Table/column names match prisma/schema.prisma (@@map names, camelCase columns).

-- 1) Geography columns GENERATED from plain lat/lng (app code only ever writes lat/lng).
ALTER TABLE "restaurants" DROP COLUMN "location";
ALTER TABLE "restaurants" ADD COLUMN "location" geography(Point,4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng","lat"),4326)::geography) STORED;

ALTER TABLE "rider_profiles" DROP COLUMN "location";
ALTER TABLE "rider_profiles" ADD COLUMN "location" geography(Point,4326)
  GENERATED ALWAYS AS (
    CASE WHEN "lastLat" IS NULL OR "lastLng" IS NULL THEN NULL
         ELSE ST_SetSRID(ST_MakePoint("lastLng","lastLat"),4326)::geography END
  ) STORED;

-- 2) GiST indexes (re-create: dropping/re-adding the column removed the Prisma-generated ones).
CREATE INDEX IF NOT EXISTS "restaurants_location_idx"    ON "restaurants"    USING GIST ("location");
CREATE INDEX IF NOT EXISTS "rider_profiles_location_idx" ON "rider_profiles" USING GIST ("location");
-- delivery_zones.polygon and service_areas.polygon are plain columns; their GiST indexes come from Prisma.

-- 3) Concurrency / integrity guarantees
-- At most one live (offered or accepted) assignment per order → two riders can never both hold a delivery.
CREATE UNIQUE INDEX "delivery_assignments_one_live_per_order"
  ON "delivery_assignments" ("orderId") WHERE "status" IN ('OFFERED','ACCEPTED');
-- At most one SUCCESSFUL payment per order → duplicate callbacks cannot double-credit.
CREATE UNIQUE INDEX "payments_one_successful_per_order"
  ON "payments" ("orderId") WHERE "status" = 'SUCCESSFUL';

-- 4) CHECK constraints
ALTER TABLE "addresses"   ADD CONSTRAINT "addresses_lat_lng_chk"   CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_lat_lng_chk" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_commission_chk" CHECK ("commissionBps" IS NULL OR "commissionBps" BETWEEN 0 AND 10000);
ALTER TABLE "operating_hours" ADD CONSTRAINT "operating_hours_chk" CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "opensAtMin" >= 0 AND "closesAtMin" > "opensAtMin");
ALTER TABLE "menu_items"  ADD CONSTRAINT "menu_items_price_chk"  CHECK ("basePriceMinor" >= 0 AND ("stockQuantity" IS NULL OR "stockQuantity" >= 0));
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_price_chk" CHECK ("priceMinor" >= 0);
ALTER TABLE "addons"      ADD CONSTRAINT "addons_price_chk"      CHECK ("priceMinor" >= 0);
ALTER TABLE "cart_items"  ADD CONSTRAINT "cart_items_qty_chk"    CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "orders"      ADD CONSTRAINT "orders_amounts_chk"    CHECK (
  "subtotalMinor" >= 0 AND "deliveryFeeMinor" >= 0 AND "serviceFeeMinor" >= 0 AND "discountMinor" >= 0 AND "taxMinor" >= 0
  AND "totalMinor" = "subtotalMinor" + "deliveryFeeMinor" + "serviceFeeMinor" + "taxMinor" - "discountMinor"
  AND "totalMinor" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_chk"       CHECK ("quantity" > 0 AND "unitPriceMinor" >= 0 AND "lineTotalMinor" >= 0);
ALTER TABLE "payments"    ADD CONSTRAINT "payments_amount_chk"   CHECK ("amountMinor" >= 0);
ALTER TABLE "refunds"     ADD CONSTRAINT "refunds_amount_chk"    CHECK ("amountMinor" > 0);
ALTER TABLE "reviews"     ADD CONSTRAINT "reviews_rating_chk"    CHECK ("restaurantRating" BETWEEN 1 AND 5 AND ("riderRating" IS NULL OR "riderRating" BETWEEN 1 AND 5));
ALTER TABLE "coupons"     ADD CONSTRAINT "coupons_value_chk"     CHECK ("value" >= 0 AND ("type" <> 'PERCENTAGE' OR "value" <= 100) AND "endsAt" > "startsAt");
ALTER TABLE "rider_location_updates" ADD CONSTRAINT "rider_loc_chk" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);
ALTER TABLE "rider_profiles" ADD CONSTRAINT "rider_capacity_chk"  CHECK ("maxActiveDeliveries" >= 1);
