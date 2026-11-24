# ADR 0020 — Automations engine and checkout recovery

Status: Accepted (Phase 8.6; defaults Q152–Q166 accepted 2026-11-24) · Date: 2026-11-24 · Binding detail:
PHASE-8-6-CONTRACT §1 (P86-1 – P86-23), §3–§9, §11.1, §12
Builds on: ADR 0001 (shared-database tenancy), 0006 (cart and checkout), 0012 (Postgres RLS), 0017 (granular
permissions), 0018 (outbound webhooks: the `WebhookEvents::emit` points), 0019 (campaigns, consent and suppression).

## Context
Figma Automations (`140:30335`: list `140:30336`, recipe editor `141:30622`) and Abandoned cart recovery (`71:20614`)
show "when X happens, do Y" rules for a COD-heavy Bangladeshi shop: win back unfinished checkouts by SMS, thank buyers
after delivery, tag repeat buyers as VIP, flag returners, email the team on low stock. Roadmap task 8.6 has one
acceptance criterion: **trigger → action runs logged**. Constraints:
- A shopper must never be double-messaged by a duplicated event, a retried job or two workers (the 8.5 at-most-once
  rule, P85-11), and every customer message must respect the 8.5 opt-out, eligibility, quiet-hours and allowance rules.
- Domain code already emits post-commit events in one place (`WebhookEvents::emit`, Phase 8.4) for orders, shipments,
  returns and stock; a second event bus would duplicate it.
- Before 8.6 nothing records a shopper who leaves the checkout: the cart has no contact, and an online-payment order
  that times out is system-cancelled (P5B-21).
- No merchant-written code or webhooks may run as actions (CLAUDE.md rule 7); a free-form builder is also hard to test
  and easy to misconfigure into a spam cannon.
- Cart tokens are bearer secrets (ADR 0006); a link in an SMS can be forwarded, scanned by previewers or opened on
  another device.

## Decision
1. **A fixed recipe catalogue, not a builder.** Five code-defined recipes (`checkout_recovery`, `thank_you`, `vip_tag`,
   `return_flag`, `low_stock`), at most one automation per recipe per store (`UNIQUE(store_id, recipe)`). Each recipe
   owns its trigger, dedupe key, allowed conditions, fixed step order and a JSON schema for `settings` (unknown keys →
   422). Merchants edit parameters, messages and the recipe's allowed conditions only.
2. **Triggers reuse the 8.4 emit points.** `WebhookEvents::emit` calls `AutomationTriggers::handle(...)` inside its
   after-commit closure, before the endpoint/plan filter, so automations fire whether or not webhooks are configured.
   Two extra sources: the `automations:detect-abandoned` scheduler (carts) and a one-line hook in
   `OrderService::systemCancel` for `payment_timeout` (unfinished online orders). Order-created events drive exit and
   attribution.
3. **Exactly one run per trigger occurrence.** `automation_runs` is inserted with `UNIQUE(automation_id, dedupe_key)`
   and `ON CONFLICT DO NOTHING` (`order:{id}`, `customer:{id}`, `return:{id}`, `inventory:{id}:{day}`,
   `checkout:{phone}:{day}`). Every evaluation is logged, including "conditions not met"; the only occurrence without a
   run is "not in plan".
4. **Steps are at-most-once.** A step row (`UNIQUE(run_id, step_index)`) is written `sending` before the provider call,
   then `done`/`failed`; `sending` older than 15 min becomes `unknown` and is never retried. Non-message actions commit
   with their step row. Waits and quiet hours park the run in `waiting` with `resume_at`; `automations:resume-due` moves
   it back by conditional UPDATE and every resumed step re-checks automation state, plan and exit conditions.
5. **Automation messages are marketing messages.** They go through the 8.5 renderer and `CampaignMessenger`: P85-3
   eligibility, suppression re-checked at send time, opt-out link with a fresh per-step code (sha256 only), shop prefix
   and footer, ≤ 3 SMS parts, quiet hours 21:00–09:00, shared monthly allowances, plus a cross-automation frequency cap
   of 2 messages per address per 24 h. The unsubscribe endpoint resolves codes from campaign recipients, then automation
   steps, then test codes.
6. **Narrow consent exception for checkout recovery.** A checkout contact typed on a page that discloses reminders may
   receive only the recovery flow's ≤ 2 messages inside its exit window, without prior consent or order; suppression
   and the opt-out link still apply.
7. **Checkout contact lives on the cart.** `PUT /storefront/cart/contact` stores phone (+ optional name/email) on the
   cart on field blur, is never echoed by any endpoint, and is deleted with the cart by the existing prune.
8. **Cart-restore links clone, never reveal.** `{cart_link}` = `/r/{code}` on the store host, 10 base62 per run, sha256
   stored. Opening it creates a **new** cart with a fresh token from the run's cart (re-priced, step coupon applied when
   active); the original cart and token are untouched. Invalid / stopped / expired → one identical 404.
9. **Attribution without tracking.** An order by the run's phone after its first sent message and inside the window
   creates one `automation_conversions` row (unique per order), credited to the last sent step. Overview revenue counts
   each order once across campaign and automation conversions.
10. **Plan, permission, execution.** `sms_automation` (Starter, Growth) is enforced at create/enable/trigger/step time;
    a downgrade pauses without deleting. `marketing.manage` covers automations (label "Coupons, campaigns &
    automations"); names need `customers.view`, addresses are always masked. Own queue `automations`, `TenantAware`
    jobs, ≤ 240 s, `tries = 1` for message steps. Config changes are audited (`automation.*`, actor type `automation`
    for system-made changes); per-action effects live in the run log (90 days), not `audit_logs`.

## Consequences
- The run log is the audit trail and the AC: every occurrence has one run with an outcome and one step row per executed
  action; tests S127–S140 pin opt-out, consent scope, idempotency, isolation, permissions, links, limits and dry-run
  purity.
- Adding a recipe is a code change (recipe class + schema + UI tile), not data; hidden Figma recipes (risky-order hold,
  auto-book courier, COD close, reviews, order-received SMS, cancel unpaid advance) wait for their modules.
- `WebhookEvents` becomes a shared fan-out point: a slow or failing automation lookup must not break webhook emission
  (it only dispatches jobs).
- Shoppers now leave a phone on the cart before ordering; the storefront shows a notice under the phone field, and the
  data lives no longer than the cart.
- Link scanners opening `/r/{code}` create orphan carts; they are pruned by `carts:prune`, and the limiter caps abuse.
- Automations and campaigns share one allowance; a busy automation can use up the month's campaign budget (shown as
  "Marketing SMS/emails" in Plan & billing).
- One more worker (`queue-automations`) and four scheduled commands to operate (RUNBOOK).

## Alternatives considered
- **Free-form flow builder** (Figma "Add a step", drag handles): flexible, but untestable combinations, no safe
  defaults and an easy route to spam; deferred (Q152).
- **A separate event bus / outbox for automations**: cleaner separation, but duplicates the 8.4 emit points and their
  after-commit guarantees.
- **Per-automation consent rules or a separate automation allowance**: more knobs, two consent models and two budgets
  to explain (Q157).
- **Reusing the original cart token in the link**: simpler restore, but a forwarded SMS would hand over a live cart
  (address, phone) — cloning avoids takeover.
- **Click-tracked short links for attribution**: better signal, but a redirector, tracking storage and privacy notice;
  phone-match attribution is deterministic and needs none (Q160).
- **Retrying failed message steps**: better delivery, but double messages when the provider accepted the first call.
