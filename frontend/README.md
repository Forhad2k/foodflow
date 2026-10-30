# FoodFlow frontend

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Radix primitives (shadcn-style components) · TanStack Query · react-hook-form + zod · sonner · Socket.IO client (reserved for live tracking/chat).

## Run
```bash
cd frontend
cp .env.example .env.local      # NEXT_PUBLIC_API_URL → the API (default http://localhost:4000)
npm install
npm run dev                     # http://localhost:3000   (start the backend first: see ../backend/README.md)
```
`npm run typecheck` · `npm test` · `npm run build && npm start`.
The API must list this site's origin in `CORS_ORIGINS`. For the refresh cookie to work in production, serve both from the same registrable domain (see `../backend/docs/DEPLOYMENT.md`).

## How it talks to the API
* `src/lib/api.ts` is a framework-free client: bearer token **in memory only**; the refresh token is an httpOnly cookie handled by the browser; a 401 triggers **one** shared refresh and a single retry; every error is an `ApiError` carrying the server's stable `code` (the UI switches on codes, never on message text).
* `src/lib/auth.tsx` signs in silently on load by exchanging the cookie. `useRequireRole` redirects for UX only: the backend enforces every permission.
* Checkout keeps one **Idempotency-Key** per checkout attempt and reuses it on retries, so a double-click or a flaky network cannot create two orders.
* Prices shown in the item dialog are previews; the server prices the cart and the checkout.

## What is built
| Area | Status |
|---|---|
| Sign in / create account (customer, restaurant owner, rider) | ✅ |
| Location: browser geolocation (asked only on a button press, with the reason shown) or Dhaka area quick-picks or a saved address | ✅ |
| Restaurant discovery: search, cuisine filters, sort, empty/error/loading states | ✅ |
| Restaurant page: menu, deliverability, open/closed, item dialog with options and add-ons | ✅ |
| Cart, coupons, checkout (addresses, contact, cash/online from what the API offers), order placement | ✅ |
| Orders list and order page: ticket header, progress timeline, receipt, cancel | ✅ (refreshes every 8 s while active) |
| Live rider tracking, order chat, notifications bell, reviews on the order page | ⏳ next (API and Socket.IO events are finished: `../backend/docs/REALTIME.md`) |
| Restaurant console · Rider app · Admin console | ⏳ placeholders that say so; the APIs are finished |
| Map-pin address picker | ⏳ needs a map provider/key (Leaflet is installed but unused) |
| Bengali localisation | ⏳ fonts are ready; copy is English only |

## Verified, and what is not
Verified here: TypeScript strict, production build (12 routes), 14 unit tests (API client incl. single-flight refresh, formatting, phone normalisation), and the whole customer flow (register → discover → cart → quote → idempotent order → cancel, plus error codes, CORS preflight and role checks) executed through this app's API client against the **real backend and database**.
**Not verified:** anything that needs a real browser (rendering, layout, focus order, screen readers, geolocation prompts, the Radix dialogs in use). No browser was available. See `docs/DESIGN.md`.
