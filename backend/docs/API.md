# FoodFlow API: Phase 2 contracts

Base URL: `/api/v1` (health endpoints are at `/health/*`). Requests are validated by strict zod schemas: unknown fields → `400 VALIDATION_FAILED` with `details: ["field: message", …]`.
All errors: `{ "error": { "code": string, "message": string, "details"?: any, "requestId": string } }`.

## Auth

### `POST /auth/register` (public, 5/min)
```json
{ "email": "rahim@example.com", "password": "min-10-chars", "fullName": "Rahim Uddin", "phone": "+8801712345678", "role": "CUSTOMER" }
```
`role` ∈ `CUSTOMER | RESTAURANT_OWNER | RIDER` (never `ADMIN`). `phone` optional, E.164.
**201** `{ "user": { "id", "email", "role", "fullName" }, "accessToken": "…", "expiresIn": 900 }` + `Set-Cookie: ff_rt=…; HttpOnly; Path=/api/v1/auth`
Errors: `400 VALIDATION_FAILED`, `409 Conflict` (email/phone taken).
Riders are created `PENDING`; they cannot take deliveries until an admin approves them.

### `POST /auth/login` (public, 10/min)
Body `{ "email", "password" }` → **200** same shape as register.
Errors: `401` invalid credentials · `403` account suspended · `429 ACCOUNT_LOCKED` (5 failures → 15 min).

### `POST /auth/refresh` (cookie + CSRF header, 30/min)
Headers: `X-Requested-With: FoodFlow`, cookie `ff_rt` (send with `credentials: "include"`). Rotates the cookie.
**200** `{ user, accessToken, expiresIn }` · **401** invalid/expired/reused (cookie cleared).

### `POST /auth/logout` (cookie + CSRF header) → **204**, revokes the session, clears the cookie.

### `POST /auth/forgot-password` (public, 3/min) → **202** always the same body, whether or not the email exists.
### `POST /auth/reset-password` (public, 5/min)
`{ "token": "…", "password": "new-password" }` → **204**. Token is single-use and expires in 30 min. All sessions are revoked.
Error `400 INVALID_RESET_TOKEN`.

## Users
### `GET /users/me` (Bearer) → `{ id, email, phone, role, emailVerifiedAt, createdAt, profile, riderProfile? }`
### `PATCH /users/me` (Bearer) `{ fullName?, avatarUrl? (https), marketingConsent? }`

## Health
`GET /health/live` → `{ "status": "ok" }` · `GET /health/ready` → checks the database (503 when down).

---
# Phase 3: discovery, addresses, cart, checkout, customer orders

Money is always **integer minor units** (paisa; ৳320.00 = `32000`). The server calculates every price, fee and total.
Customer-only routes need `Authorization: Bearer …` with role `CUSTOMER` (anonymous → 401, other roles → 403).

## Discovery (public)
### `GET /cuisines` → `[{ id, name, slug }]`
### `GET /restaurants?lat&lng[&q&cuisine&priceTier&minRating&maxDeliveryFee&maxEtaMinutes&sort&page&limit]`
`lat`,`lng` required. `cuisine` = comma-separated slugs, `priceTier` = comma-separated 1-4, `sort` ∈ `recommended|distance|rating|delivery_time|delivery_fee`, `limit` ≤ 50.
Returns only restaurants that are approved, not paused, **open now**, and whose **active delivery zone covers that point** (and lie inside an active service area, if the admin defined any).
```json
{ "items": [{ "id", "name", "slug", "logoUrl", "coverUrl", "cuisines": [{"name","slug"}], "priceTier", "ratingAvg", "ratingCount",
   "distanceMeters", "deliveryFeeMinor", "minOrderMinor", "estimatedDeliveryMinutes": {"min","max"}, "isOpen": true }],
  "page": 1, "limit": 20, "total": 7, "emptyReason": "NO_RESTAURANTS_IN_AREA | ALL_CLOSED | FILTERS_TOO_STRICT (only when total = 0)" }
```
Ranking = configurable weighted blend of distance, ETA, rating and search relevance (`platform_settings`: `discovery.rankingWeights`).
### `GET /restaurants/:idOrSlug[?lat&lng]` → details + full menu (categories → items → images, variants, add-on groups) + `isOpen` + `deliverability` (when a location is given: `deliverable`, fee, minimum order, ETA). Sold-out items show `isAvailable: false`; exact stock is never exposed.

## Addresses (customer, max 10)
`GET /addresses` · `POST /addresses` · `PATCH /addresses/:id` · `DELETE /addresses/:id` (soft delete; past orders keep their snapshot).
Body: `{ label, line1, line2?, area?, city, postalCode?, lat, lng, instructions?, isDefault? }`. The first address becomes the default. Another customer's address id → `404`.

## Cart (customer; one restaurant per cart)
`GET /cart` · `POST /cart/items` · `PATCH /cart/items/:id` · `DELETE /cart/items/:id` · `DELETE /cart` · `PUT /cart/coupon {code}` · `DELETE /cart/coupon`
`POST /cart/items` body `{ menuItemId, variantId?, addonIds?, quantity (1-99), notes?, replaceCart? }`: **no prices accepted** (unknown fields → 400).
Adding from a second restaurant → `409 CART_RESTAURANT_MISMATCH` unless `replaceCart: true`. Identical lines merge.
Cart responses re-price every line from the live menu and list `issues` (item removed, option sold out, add-on gone, not enough stock).
Choice errors are precise `422`s: `VARIANT_REQUIRED`, `VARIANT_INVALID`, `VARIANT_UNAVAILABLE`, `ADDON_GROUP_MIN`, `ADDON_GROUP_MAX`, `ADDON_UNAVAILABLE`, `ADDON_INVALID`, `ITEM_UNAVAILABLE`, `OUT_OF_STOCK`.

## Checkout
### `POST /checkout/quote` `{ addressId, couponCode? }` → 200
Read-only preview of exactly what an order placed now would cost.
```json
{ "canCheckout": false, "restaurant": {"id","name"}, "items": [...],
  "totals": { "subtotalMinor", "deliveryFeeMinor", "serviceFeeMinor", "discountMinor", "taxMinor", "totalMinor" },
  "coupon": { "code", "valid", "discountMinor", "reasonCode?", "reason?" }, "delivery": { "distanceMeters", "estimatedMinutes": {"min","max"} },
  "issues": [{ "code", "message", "cartItemId?" }], "paymentMethods": ["CASH_ON_DELIVERY"] }
```
Issue codes: `RESTAURANT_UNAVAILABLE`, `RESTAURANT_CLOSED`, `ADDRESS_NOT_DELIVERABLE`, `MIN_ORDER_NOT_MET`, `OUT_OF_STOCK`, item/option codes above, `COUPON_NOT_FOUND|INACTIVE|NOT_STARTED|EXPIRED|WRONG_RESTAURANT|MIN_SPEND|USAGE_LIMIT|USER_LIMIT|FIRST_ORDER_ONLY`.

### `POST /orders` (header `Idempotency-Key: 8-100 chars [A-Za-z0-9_-]`)
Body `{ addressId, paymentMethod: "CASH_ON_DELIVERY", contactPhone? (E.164; falls back to profile phone), deliveryInstructions?, customerNote?, couponCode? }`.
* **201** order created · **200** same key replayed → the original order (no duplicate is created).
* `409 CHECKOUT_BLOCKED` with `details.issues` (anything from the quote list) · `422 PAYMENT_METHOD_UNAVAILABLE` for `ONLINE` (Phase 7) · `422 CONTACT_PHONE_REQUIRED` · `400 IDEMPOTENCY_KEY_REQUIRED`.
Everything is re-validated and re-priced inside one transaction; stock is reserved; the order stores immutable snapshots of item names, options, prices and the delivery address.

### `GET /orders?page&limit&status` · `GET /orders/:id` (also the receipt)
`GET /orders/:id` → `{ id, orderNumber, status, totals, items[snapshot], deliveryAddress, timeline[], payments[], customerActions[] , … }`. Not your order → `404`.
`customerActions` lists what the customer may do next (e.g. `["CANCELLED"]`), so the UI needs no copy of the rules.
### `POST /orders/:id/cancel` `{ reason? }` → the updated order
Allowed while `PLACED` (reason optional) or `RESTAURANT_ACCEPTED` (reason required); afterwards `409 INVALID_ORDER_TRANSITION`/`403 FORBIDDEN_ORDER_TRANSITION`. Cancelling returns reserved stock, frees the coupon use and cancels the pending cash payment.

---
# Phase 4: restaurant owner & admin approval

Owner routes need role `RESTAURANT_OWNER`; admin routes need `ADMIN` (anything else → 403). A restaurant that is not yours is always `404`.
Money in minor units; times in minutes after local midnight (Asia/Dhaka).

## Restaurant lifecycle
`PENDING → APPROVED` (admin) · `PENDING → REJECTED` (admin, reason shown to owner) · `REJECTED → PENDING` (owner `resubmit`) · `APPROVED ⇄ SUSPENDED` (admin, reason).
Only `APPROVED` restaurants appear in discovery. **Approval is refused (`422 RESTAURANT_NOT_READY`, `details.missing[]`) until the restaurant has a cuisine, an active delivery zone, opening hours and an available menu item.**

## Owner: restaurant (`/owner/restaurants`)
| Route | Notes |
|---|---|
| `GET /` · `POST /` | list mine · register `{ name, phone(E.164), addressLine, city, lat, lng, cuisineIds[1-5], description?, avgPrepMinutes?, minOrderMinor?, baseDeliveryFeeMinor?, priceTier?, logoUrl?, coverUrl? }` → created `PENDING`. Max 5 per owner. Cannot set commission/approval (unknown field → 400). |
| `GET /:id` · `PATCH /:id` | details + `readiness { ready, missing[] }` · edit (slug never changes) |
| `PATCH /:id/availability {isPaused}` | pause/resume taking orders; accepted orders are unaffected |
| `POST /:id/resubmit` | `REJECTED → PENDING` |
| `PUT /:id/hours {hours:[{dayOfWeek 0-6, opensAtMin, closesAtMin}]}` | replaces the weekly schedule. `closesAtMin` up to 1800 (06:00 next day). ≤4 periods/day, no overlaps → `422 INVALID_HOURS` |
| `GET/POST /:id/zones` · `PATCH/DELETE /:id/zones/:zoneId` | `RADIUS {radiusMeters 200-30000}` or `POLYGON {polygon: [[lng,lat],…] closed ring}`, optional `deliveryFeeMinor`, `minOrderMinor`. Polygons are validated by PostGIS (self-intersection → `INVALID_POLYGON`, > 5,000 km² → `ZONE_TOO_LARGE`) and normalised so winding order cannot invert them. Max 10 zones. Polygon zones are redrawn, not edited. |
| `GET /:id/stats?from&to` | delivered/cancelled/in-progress counts, gross food sales, commission (rate snapshotted on each order), net, rating. Default last 30 days, max 1 year. Payout schedule: Phase 7. |

## Owner: menu (`/owner/restaurants/:rid/menu`)
`GET /` full menu incl. unavailable items and exact stock.
`POST|PATCH|DELETE /categories[/:id]` (an empty category is deleted; one with only retired items is hidden; one with live items → `409 CATEGORY_NOT_EMPTY`).
`POST /items`, `PATCH /items/:id`, `DELETE /items/:id` (soft delete: old receipts and carts stay consistent), `PATCH /items/:id/availability {isAvailable?, stockQuantity? (null = unlimited)}`.
`PUT /items/:id/variants {variants:[{id?,name,priceMinor,isDefault?,isAvailable?}]}` and `PUT /items/:id/addon-groups {groups:[{id?,name,minSelect,maxSelect,addons:[{id?,name,priceMinor,isAvailable?}]}]}` are **declarative**: send the complete desired list; entries with an `id` are updated in place, without an `id` created, omitted ones removed.
Images: `imageUrls[]` (https only, ≤8, optionally restricted to `IMAGE_HOST_ALLOWLIST`). Direct upload (signed Cloudinary/S3 URLs) is not built yet.

## Owner: orders (`/owner/restaurants/:rid/orders`)
`GET /?scope=active|history&status&page&limit` kitchen queue (oldest first) or history · `GET /:id` kitchen view (items, add-ons, notes, customer **first name only**; no phone/address).
Each order includes `restaurantActions[]`, the transitions currently allowed.
`POST /:id/accept {prepMinutes?}` · `POST /:id/reject {reason}` · `POST /:id/preparing` · `POST /:id/ready` · `POST /:id/cancel {reason}` → updated order.
Invalid moves → `409 INVALID_ORDER_TRANSITION` / `403 FORBIDDEN_ORDER_TRANSITION`. An order nobody answers within `order.restaurantAcceptTimeoutSeconds` (default 180 s) is rejected automatically.

## Admin (`/admin/restaurants`)
`GET /?status&q&page&limit` → `{items:[...], page, limit, total}` (search matches restaurant name, city, or owner email; rows include owner, readiness, and commission) · `GET /:id` (owner, readiness, effective commission) · `POST /:id/approve|reject|suspend|reinstate` (`reject`/`suspend` need `{reason}`) · `PATCH /:id/commission {commissionBps: 0-5000 | null}`.
Every action runs in one transaction with its **audit-log row** (`restaurant.approve`, `…reject`, `…suspend`, `…reinstate`, `…set_commission`, including from/to and reason).


---
# Phase 5: riders, dispatch & delivery

Rider routes need role `RIDER`. A rider can only ever see and act on **their own** offers and deliveries (anything else is `404`).

## Onboarding & verification (`/rider`)
| Route | Notes |
|---|---|
| `GET /me` | approval status, vehicle, documents (with rejection reasons), `requiredDocuments[]`, `missing[]` |
| `PUT /vehicle {vehicleType: BICYCLE\|MOTORCYCLE\|CAR, vehiclePlate?}` | only while `PENDING`/`REJECTED` |
| `POST /documents/upload-signature` | returns short-lived, rider-scoped Cloudinary image-upload parameters; requires all three Cloudinary environment variables |
| `PUT /documents {type, storageKey}` | `type` ∈ `NATIONAL_ID, SELFIE, DRIVING_LICENSE, VEHICLE_REGISTRATION, OTHER`. `storageKey` must identify an authenticated Cloudinary image under `riders/<your id>/`; the API verifies it exists before saving. Re-uploading a type replaces it and puts it back in review. The rider UI accepts JPEG, PNG, or WebP images up to 10 MB. |
| `POST /resubmit` | `REJECTED → PENDING` |
Required documents: ID + selfie for bicycles; plus licence + registration for motorcycles and cars.

## Availability
`PUT /status {isOnline, lat?, lng?}` · going online needs approval (`403 RIDER_NOT_APPROVED`) and a position (`422 LOCATION_REQUIRED`). Going offline is refused during a delivery (`409 HAS_ACTIVE_DELIVERY`), cancels pending offers, and **erases the stored position**.
`POST /presence {lat, lng}` · heartbeat while idle (≤ 40/min). Impossible jumps (> ~200 km/h) → `422 IMPLAUSIBLE_LOCATION`. Idle riders silent for 10 minutes are set offline automatically. (Live tracking during a delivery streams over Socket.IO in Phase 6.)

## Offers & dispatch
Dispatch starts when the restaurant accepts an order. One rider at a time is offered the delivery (45 s to answer, configurable). Eligible = approved, active, online, position < 2 min old, within 4 km of the restaurant, below capacity (1 delivery by default), and not already asked about this order. Ranking: distance (60 %) · current workload (25 %) · acceptance history (15 %).
* `GET /offers` → coarse view only: restaurant name/city, customer *area*, item count, pickup/drop-off distances, cash to collect. No exact addresses, phone numbers or customer name.
* `POST /offers/:id/accept` → the delivery view. Idempotent (a double-tap is safe). Errors: `409 OFFER_EXPIRED | OFFER_NOT_AVAILABLE | RIDER_AT_CAPACITY`, `403 RIDER_NOT_APPROVED`.
* `POST /offers/:id/reject {reason?}` → 204; the next rider is offered immediately.
Accepting opens the order's private chat room for exactly {customer, rider}. If the food is already `READY_FOR_PICKUP` the order moves to `RIDER_ASSIGNED`; otherwise it moves there automatically the moment the restaurant marks it ready.

## Deliveries
`GET /deliveries/active` · `GET /deliveries/:orderId` · `GET /deliveries/history` (outcome only, no customer contact data).
`POST /deliveries/:orderId/pickup` · `/on-the-way` · `/delivered` · `/failed {reason}` → the delivery view. The state machine enforces the sequence (`409 INVALID_ORDER_TRANSITION`). Delivering a cash order marks the payment collected.
`POST /deliveries/:orderId/release {reason}` → 204. Drop an accepted delivery before pickup; the order returns to dispatch (`409 CANNOT_RELEASE` once you have the food: report a failed delivery instead).

**What a rider sees, by stage**
| Stage | Restaurant | Customer |
|---|---|---|
| Offer (before accepting) | name, city | area only |
| Accepted → before pickup | exact address, phone, map position | first name, area |
| Picked up / on the way | same | + exact address, instructions, phone |
| Delivered / failed / cancelled | none | none |

## Admin (`/admin`)
`GET /riders?status&q` · `GET /riders/:id` (documents, missing items; never coordinates) · `GET /riders/:id/documents/:docId/url` (five-minute private preview URL) · `POST /riders/:id/documents/:docId/review {approve, reason?}` · `POST /riders/:id/approve | reject | suspend | reinstate` (approval needs vehicle + every required document approved → `422 RIDER_NOT_READY`; suspending cancels pending offers and takes the rider offline).
`GET /dispatch/stuck` · orders cooking/ready with no rider (`OFFERS_EXHAUSTED` or `NO_RIDER_AVAILABLE` after 5 min).
`POST /dispatch/orders/:id/redispatch` → starts a fresh offer round · `POST /dispatch/orders/:id/assign {riderId, replace?}` → admin picks the rider (`409 ORDER_ALREADY_ASSIGNED` unless `replace`).
All audited. Orders are never auto-cancelled for lack of a rider: a human decides.


---
# Phase 6: notifications, tracking & chat (REST side)
The live stream is Socket.IO: see `REALTIME.md`. REST covers page loads, history and fallbacks. All routes need a Bearer token.

## Notifications (any role, own notifications only)
`GET /notifications?unread=true&page&limit` → `{ items:[{id,type,title,body,data,readAt,createdAt}], page, limit, total, unreadCount }`
`GET /notifications/unread-count` → `{ unreadCount }` · `POST /notifications/:id/read` → `{ unreadCount }` (someone else's id → 404) · `POST /notifications/read-all`

## Tracking snapshot
`GET /orders/:id/tracking` (customer) · `GET /rider/deliveries/:orderId/tracking` (assigned rider) · `GET /admin/orders/:id/tracking` (admin)
→ `{ orderId, location: {lat,lng,headingDeg,speedMps,recordedAt,stale,destination,etaMinutes,distanceMeters,etaSource} | null, staleAfterSeconds }`. Others → `404`; not active → `409 TRACKING_NOT_ACTIVE`.

## Order chat (REST fallback with identical rules)
Customer: `/orders/:id/chat/…` · Rider: `/rider/deliveries/:orderId/chat/…`
* `GET …/messages?before=<iso>&limit` → `{ messages[], hasMore, unread, room:{open,orderNumber} }`
* `POST …/messages {body, clientMessageId?}` → **201** message (**200** when `clientMessageId` repeats)
* `POST …/read {upToMessageId?}` → `{ marked }`
* `POST …/messages/:messageId/report {reason}` → 201 `{ id }` · reporting your own message → 404 · twice → `409 ALREADY_REPORTED`
Not a participant / chat not open / expired → `404 CHAT_NOT_AVAILABLE`; finished order → `409 CHAT_CLOSED`; `429 RATE_LIMITED`; `422 INVALID_MESSAGE | MESSAGE_TOO_LONG`.

## Admin moderation
`GET /admin/chat-reports?status=OPEN|REVIEWED|DISMISSED` (reported message text + order number only: admins cannot browse conversations) · `POST /admin/chat-reports/:id/review {status: REVIEWED|DISMISSED}` (audited).


---
# Phase 7: payments, refunds, earnings, reviews, promotions, support, administration

## Online payments
Enabled by `PAYMENT_PROVIDER` (default `none` = cash only; `dev` = a **simulated** gateway for local development, refused in production). `POST /checkout/quote` lists `paymentMethods` and only includes `ONLINE` when a gateway is configured.

**Flow**
1. `POST /orders` with `paymentMethod: "ONLINE"` → **201**, order `PENDING_PAYMENT` and `payment: { redirectUrl, expiresAt }`. Stock and the coupon are reserved; the restaurant sees nothing yet. Send the customer to `redirectUrl`.
2. The gateway calls `POST /payments/webhook` (public, raw body, signed). The server verifies the signature, then **asks the gateway for the payment's real status** and compares the amount: only then is the order `PLACED` (restaurant and customer notified). A browser redirect, a callback body, or anything a client sends is never believed on its own.
3. The frontend just polls/refreshes `GET /orders/:id` (or listens for the `notification`) after the customer returns.
Outcomes: paid → `PLACED` · declined/abandoned → `PAYMENT_FAILED` (stock + coupon released) · wrong amount → `PAYMENT_FAILED` + audit `payment.amount_mismatch` · not completed in `payments.pendingTimeoutMinutes` (30) → `CANCELLED`.
**Guarantees:** callbacks are idempotent (`(provider, eventId)` unique; row locks; one `SUCCESSFUL` payment per order enforced by an index), lost callbacks are recovered by a reconciliation sweep that queries the gateway, and money that arrives after an order ended is refunded automatically. No card data is ever stored; payment references are opaque (`ffpay_…`).
**Development simulator** (only when `PAYMENT_PROVIDER=dev`): `POST /dev/payments/:ref/simulate {outcome: "PAID"|"FAILED", amountMinor?}` plays the gateway so a frontend can complete a payment.
**Going to production:** implement `PaymentProvider` (`src/payments/provider.ts`) for a real gateway (SSLCommerz, bKash, Nagad, Stripe…): `initialize`, `redirectUrl`, `verifyWebhook`, `fetchStatus`, `refund` (idempotent on the refund id), then wire it in `container.ts`. Nothing else changes. **No real gateway adapter ships in this repo**: it needs merchant credentials.

## Refunds
* **Automatic:** a paid online order that is cancelled, rejected or fails delivery is refunded in full, created in the same transaction as the status change and paid out by a sweep (idempotent at the gateway).
* **Customer request** (delivered, paid orders; within `refunds.windowDays` = 7): `POST /orders/:id/refund-requests {amountMinor?, reason}` → 201 · `GET /orders/:id/refunds`. Errors: `409 NOT_REFUNDABLE | REFUND_WINDOW_CLOSED | REFUND_ALREADY_REQUESTED | ALREADY_REFUNDED`, `422 INVALID_REFUND_AMOUNT` (`details.maxMinor`).
* **Admin:** `GET /admin/refunds?status` · `POST /admin/refunds/:id/review {approve, note?, amountMinor?}` (declining needs a note; approving may reduce the amount; gateway refunds are paid immediately) · `POST /admin/refunds/:id/mark-processed {reference}` (cash orders: record the manual payment). Lifecycle `REQUESTED → APPROVED|REJECTED → PROCESSED|FAILED`; partial refunds add up and can never exceed what was paid. A fully refunded payment becomes `REFUNDED`.

## Money: earnings, payouts, reconciliation
* On `DELIVERED` (same transaction): **restaurant earning** = food subtotal − commission (rate snapshotted on the order, default 15 %) − any discount from the restaurant's *own* coupon; **rider earning** = `rider.deliveryFeeShareBps` (80 %) of the delivery fee, plus the **cash collected** on cash orders. Platform-wide coupons are platform-funded.
* `POST /admin/payouts/generate {periodStart, periodEnd}` (period must end in the past) bundles unpaid earnings into one payout per payee; nothing is ever bundled twice. Rider payout = earnings − cash collected: **negative means the rider owes the platform**. `POST /admin/payouts/:id/mark-paid {reference}` · `GET /admin/payouts?status&role`.
* Payees: `GET /owner/restaurants/:id/earnings` · `GET /owner/payouts` · `GET /rider/earnings` (`unpaidEarningsMinor`, `cashToRemitMinor`, `netUnpaidMinor`) · `GET /rider/payouts`.
* `GET /admin/reconciliation?from&to` → `{ ok, issues[], summary }`. Issues: `DELIVERED_WITHOUT_EARNING`, `PAYMENT_AMOUNT_MISMATCH`, `PAID_ORDER_ENDED_WITHOUT_REFUND`, `REFUNDS_EXCEED_PAYMENT`, `PAID_BUT_STILL_PENDING_PAYMENT`, `DELIVERED_COD_PAYMENT_NOT_COLLECTED`. Summary: GMV, food, delivery and service fees, discounts, commission, rider earnings, platform net.
* *Not automated:* clawing back earnings when a delivered order is refunded later (the platform bears it unless an admin adjusts a payout).

## Reviews
`POST /orders/:id/review {restaurantRating 1-5, riderRating?, comment?}` → 201. Verified purchase by construction: the customer of a `DELIVERED` order, once (`409 ALREADY_REVIEWED`), within `reviews.windowDays` (14). Restaurant and rider averages update atomically.
Public: `GET /restaurants/:idOrSlug/reviews?page&limit` → `{ rating:{average,count}, items:[{rating,comment,createdAt,reviewer:"Nusrat J."}] }` (never a full name). Owner: `GET /owner/restaurants/:id/reviews`.

## Promotions
* Owner (own restaurant only; restaurant-funded; ≤ 50 % off, needs a max discount and a total limit; ≤ 20 active): `GET|POST /owner/restaurants/:id/coupons`, `PATCH …/coupons/:couponId`.
* Admin (platform-wide or for any restaurant): `GET|POST /admin/coupons` (`restaurantId?`), `PATCH /admin/coupons/:id`. A used coupon is frozen except dates, limits and the active flag; coupons are deactivated, never deleted.
* `POST /admin/promotions/broadcast {title, body, role?, limit?}` → notification (`PROMOTION`) to **users who opted in** (`marketingConsent`) only.
Coupon rules (dates, minimum spend, total/per-user limits, first-order, restaurant scope) are enforced at checkout under a row lock.

## Support, order issues and disputes
Any signed-in role: `POST /support/tickets {category, subject, description, orderId?}` (categories `ORDER_ISSUE, MISSING_ITEM, DELIVERY_COMPLAINT, REFUND, PAYMENT, ACCOUNT, DISPUTE, OTHER`; `orderId` must be an order you are part of; 5/hour) · `GET /support/tickets` · `GET /support/tickets/:id` · `POST /support/tickets/:id/messages` · `POST /support/tickets/:id/close`. Someone else's ticket is `404`; internal admin notes are never returned.
Admin: `GET /admin/support/tickets?status&category&assigneeId&unassigned&open` · `GET /admin/support/tickets/:id` · `POST …/messages {body, isInternal?}` (a public reply notifies the requester) · `POST …/assign {assigneeId|null}` (admins only) · `POST …/status {status, resolution?}` (`RESOLVED` needs a resolution).

## Administration
* Users: `GET /admin/users?role&status&q&page&limit` → `{items:[...], page, limit, total}` · `GET /admin/users/:id` · `POST /admin/users/:id/status {status: ACTIVE|SUSPENDED, reason?}`: suspending ends every session immediately, takes riders offline; admins and yourself cannot be suspended through the API.
* `GET /admin/stats` operational snapshot (orders by status, GMV, riders online, and a "needs attention" block). `GET /admin/audit-logs?action&actorId&entityType&entityId&from&to`.
* Settings: `GET /admin/settings` (value, default, customised) · `PUT /admin/settings {key, value}`: every key has a validated range (commission, fees, tax, radii, timeouts, tracking/chat limits, rider share, windows…); changes are audited with before/after and reach other instances within 30 s.
* Service areas: `GET|POST /admin/service-areas {name, polygon}` · `POST …/:id/active {isActive}` · `DELETE …/:id`. Once any area is active, addresses outside every active area see no restaurants.
