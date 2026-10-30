#!/bin/sh
# One-time helper: creates the INITIAL Prisma migration and appends prisma/sql/001_postgis_and_constraints.sql to it
# (PostGIS generated columns, spatial indexes, partial unique indexes, CHECK constraints: things Prisma cannot express),
# then applies it. Commit the resulting prisma/migrations/ folder; afterwards only `prisma migrate deploy` is needed.
#   Usage:  DATABASE_URL=postgresql://... ./scripts/create-init-migration.sh
set -e
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL first}"

if ls -d prisma/migrations/*_init >/dev/null 2>&1; then
  echo "An init migration already exists: nothing to create. Apply it with: npx prisma migrate deploy"
  exit 0
fi

npx prisma migrate dev --name init --create-only --skip-seed
DIR=$(ls -d prisma/migrations/*_init | head -1)
if grep -q "FoodFlow: PostGIS generated columns" "$DIR/migration.sql"; then
  echo "PostGIS/constraint SQL already appended to $DIR"
else
  printf '\n\n' >> "$DIR/migration.sql"
  cat prisma/sql/001_postgis_and_constraints.sql >> "$DIR/migration.sql"
  echo "Appended prisma/sql/001_postgis_and_constraints.sql to $DIR/migration.sql"
fi
npx prisma migrate deploy
echo "Done. Commit prisma/migrations/."
