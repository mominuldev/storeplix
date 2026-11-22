# ADR 0006 — Cart and checkout

Status: Accepted · Date: 2026-11-21

## Context
BD commerce is COD-heavy, mobile-first, guest checkout common, fake orders frequent.

## Decision
- **Cart** is server-side (`carts`, `cart_items`), identified by an opaque random token in httpOnly cookie `sp_cart`
  (per host); DB stores `sha256(token)`. Carts hold variant ids + quantities only; prices always recomputed. Logged-in
  customers' carts merge on login. Expire after 30 days inactivity.
- **Checkout** is a single `POST /api/v1/storefront/checkout` with required `Idempotency-Key`: in one DB transaction
  re-price, validate coupon & shipping, reserve stock (atomic conditional UPDATE), create order (`pending_payment` for
  online, `pending` for COD), snapshot items/addresses. Online payment then initiated (ADR 0007). Reservation released by
  job after 30 min if unpaid.
- Guest checkout on by default (phone required, email optional); customers deduplicated by phone within tenant.
- Tax: store-level rate in basis points, inclusive or exclusive. Shipping: method rules (inside/outside Dhaka, free-over).
- Abuse: per-IP/phone checkout rate limit, Turnstile on anomaly, fake-order guard (Phase 8).

## Consequences
+ Tamper-proof totals, no oversell, safe retries on flaky mobile networks.
− Server round-trips for every cart change (acceptable; cart endpoints are no-store and fast).

## Alternatives
- Client-side (localStorage) cart: cheap but prices/stock stale and no abandoned-cart recovery.
- Multi-step checkout API: more endpoints and partial states; single-shot with idempotency is simpler.

## Amendment 2026-11-22 — Phase 5a (PHASE-5-CONTRACT P5-2–P5-4, P5-14, P5-15, P5-23, P5-29)
- Guest checkout only in 5a (Q14 default); no cart merge until shopper accounts exist.
- The API returns the cart token once (`meta.cart_token`); the storefront server keeps it in the httpOnly host-only
  `sp_cart` cookie and forwards `X-Cart-Token`. Cart mutations go through Next.js Server Actions only.
- Carts do **not** reserve stock; stock is committed at order placement (ADR 0011). The 30-minute release applies
  only to unpaid online orders (5b, Q35).
- Checkout also requires `expected_total_amount`; a recomputed total that differs → 409 `checkout_changed`.
- Shipping uses zones of districts/thanas with one charge each and a guaranteed fallback zone (P5-7), not method
  rules; tax is 0 until VAT settings ship (5b).
- Shoppers reach their order via a 24-hour confirmation token (cookie `sp_order`) or by order number + phone.
