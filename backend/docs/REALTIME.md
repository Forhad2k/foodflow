# FoodFlow realtime (Socket.IO) reference

One Socket.IO server runs on the same port as the HTTP API (`path: /socket.io`). Transport is WebSocket (polling fallback allowed).
All rules live in `ChatService` / `TrackingService` / `NotificationService`; the gateway (`src/realtime/gateway.ts`) only authenticates, validates and routes.

## Connecting
```js
const socket = io(API_URL, { auth: { token: accessToken } });   // the same access JWT used for REST
```
* Handshake fails with `connect_error: UNAUTHORIZED` unless the token is valid **and its session is live** (not logged out, user active).
* The session is **re-checked on every event**. After a logout/suspension the next event is acknowledged with `UNAUTHORIZED`, the server emits `auth:expired`, then disconnects. Refresh the token and reconnect.
* Each socket may send 100 events / 10 s (`RATE_LIMITED` beyond that). Payloads are strictly validated (unknown fields rejected).

## Acknowledgements
Every client→server event takes an ack callback and gets exactly one reply; handlers never throw to the client.
```js
socket.emit('chat:send', payload, (res) => { /* { ok: true, ...data }  |  { ok: false, error: { code, message, details? } } */ });
```

## Rooms (decided by the server, never by the client)
| Room | Who can be in it | Joined by |
|---|---|---|
| `user:{userId}` | that user only | automatically on connect (notifications) |
| `order:{orderId}:tracking` | order's customer, its **assigned** rider, admins | `tracking:subscribe` after authorization |
| `order:{orderId}:chat` | order's customer + its **current** rider only | `chat:join` after authorization |
Before any broadcast to a tracking/chat room the server evicts sockets of users who are no longer allowed (e.g. a rider replaced mid-delivery), so stale members never receive anything.

## Notifications
| Direction | Event | Payload |
|---|---|---|
| C→S | `notifications:sync` `{}` | ack `{ ok, unreadCount }` (call after (re)connecting; then fetch the list over REST) |
| S→C | `notification` | `{ id, type, title, body, data, createdAt, readAt, unreadCount }` |
Notifications are written **inside the transaction** that causes them and pushed when it commits (Postgres `LISTEN/NOTIFY`): no notification for a rolled-back change, none lost on a crash. Types: `ORDER_UPDATE, ASSIGNMENT, PAYMENT, REFUND, PROMOTION, SUPPORT, SYSTEM`. `data` carries `{ orderId, orderNumber, … }` for deep links; offers carry `{ offerId, expiresAt }`.
Who is told: customer on every progress step, restaurant on new orders / rider assigned / cancellations, rider on offers and cancellations, never the person who did the action.

## Live tracking
| Direction | Event | Payload / notes |
|---|---|---|
| C→S | `tracking:subscribe` `{ orderId }` | customer of the order, its assigned rider, or admin. Ack `{ ok, location: {lat,lng,headingDeg,speedMps,recordedAt,stale,destination,etaMinutes,distanceMeters,etaSource} \| null, staleAfterSeconds }`. Anyone else: `NOT_FOUND`. Not active: `TRACKING_NOT_ACTIVE` |
| C→S | `tracking:unsubscribe` `{ orderId }` | |
| C→S | `rider:location` `{ orderId, lat, lng, accuracyM?, headingDeg?, speedMps? }` | **assigned rider only**, while online with an active delivery. Send every ~4 s (`tracking.updateIntervalSeconds`). Errors: `VALIDATION_FAILED`, `NOT_ONLINE`, `TRACKING_NOT_ACTIVE`, `TOO_FREQUENT` (< half the interval), `IMPLAUSIBLE_LOCATION` (> ~200 km/h jump) |
| S→C | `tracking:location` | `{ orderId, lat, lng, headingDeg, speedMps, recordedAt, destination: RESTAURANT\|CUSTOMER, etaMinutes, distanceMeters, etaSource }` |
| S→C | `tracking:stale` / `tracking:fresh` | `{ orderId, lastUpdateAt }` / `{ orderId }`: no update for `tracking.staleAfterSeconds` (30 s); sent once per episode, `fresh` when updates resume |
| S→C | `tracking:rider_disconnected` | `{ orderId, at }`: the rider's app dropped (UI should show "reconnecting") |
| S→C | `tracking:ended` | `{ orderId, reason: DELIVERED \| CANCELLED \| REASSIGNED \| … }`: delivery finished/cancelled/reassigned. The server removes everyone from the room; **the rider app must stop sending GPS** |
Timestamps are the server's clock. Rider position is kept for `LOCATION_RETENTION_HOURS` (default 24 h) then deleted; going offline erases the stored position. `etaSource: "estimate"` = straight-line × detour at city speed. A road-routing provider (Google/Mapbox) plugs in via `RoutingProvider` (needs an API key); not configured by default.
Restaurants cannot watch rider positions.

## Order chat
Exists only after a rider accepts the delivery. Participants: the order's customer and the **current** rider. Admins, restaurants and other users cannot join (they get `CHAT_NOT_AVAILABLE`, indistinguishable from "no such chat").
| Direction | Event | Payload / notes |
|---|---|---|
| C→S | `chat:join` `{ orderId }` | ack `{ ok, messages[≤50], hasMore, unread, room: { open, orderNumber } }`. A rider sees only messages from the moment they took the delivery; the customer sees the whole thread |
| C→S | `chat:leave` `{ orderId }` | |
| C→S | `chat:send` `{ orderId, body, clientMessageId }` | `clientMessageId` (8-64 chars) makes retries idempotent (`duplicate: true`, no second message). Body is trimmed, control characters removed, 1-500 chars. Ack `{ ok, message, duplicate }` |
| C→S | `chat:read` `{ orderId, upToMessageId? }` | marks the other party's messages read. Ack `{ ok, marked }` |
| S→C | `chat:message` | `{ id, orderId, senderId, senderRole, body, clientMessageId, createdAt, deliveredAt, readAt }` |
| S→C | `chat:delivered` / `chat:read` | `{ messageId, deliveredAt }` / `{ readerId, upToMessageId, readAt }` |
Message status: **sent** (ack) → **delivered** (recipient had the room open) → **read**.
Errors: `CHAT_NOT_AVAILABLE`, `CHAT_CLOSED` (order finished/cancelled or you are no longer the rider), `INVALID_MESSAGE`, `MESSAGE_TOO_LONG`, `RATE_LIMITED` (20 messages/min/user).
**Authorization is re-evaluated on every join, send and read**, never cached from connect time. When an order ends the room closes (read-only); participants can still read for `chat.retentionDays` (30), after which conversations are deleted.
Message bodies are stored and sent as plain text: **escape on render** (React does by default; never use `dangerouslySetInnerHTML`).

## Not included yet
* **Multi-instance Socket.IO**: tracking/chat rooms are per instance. Running several API instances needs the Redis adapter (`@socket.io/redis-adapter`) so that a customer and rider on different instances share rooms. Notifications already work across instances (they travel through Postgres). Until then, run a single realtime instance (or sticky routing by order).
* Email and push channels for notifications (the in-app channel is complete; other channels subscribe to the same `ff_notify` events and need a delivery-claim column before running on several instances).
