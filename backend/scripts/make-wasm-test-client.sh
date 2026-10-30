#!/bin/sh
# OPTIONAL. Builds a Prisma client that runs on Prisma's WASM query engine through the `pg` driver adapter, into
# node_modules/.ff-wasm-client. Integration tests use it when FF_WASM_CLIENT is set, which is handy where Prisma's native
# engine cannot be downloaded (sandboxes, locked-down CI). Normal setups just use the regular client: leave FF_WASM_CLIENT unset.
set -e
cd "$(dirname "$0")/.."
rm -rf .tmp-wasm && mkdir -p .tmp-wasm
sed -e 's|provider        = "prisma-client-js"|provider        = "prisma-client-js"\n  output          = "../node_modules/.ff-wasm-client"|' \
    -e 's|previewFeatures = \["postgresqlExtensions"\]|previewFeatures = ["postgresqlExtensions", "driverAdapters"]|' \
    prisma/schema.prisma > .tmp-wasm/schema.prisma
npx prisma generate --schema .tmp-wasm/schema.prisma
node scripts/patch-wasm-loader.js
rm -rf .tmp-wasm
echo "WASM test client ready: export FF_WASM_CLIENT=$(pwd)/node_modules/.ff-wasm-client"
