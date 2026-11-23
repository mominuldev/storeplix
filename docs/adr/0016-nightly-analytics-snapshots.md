# ADR 0016 — Platform analytics from nightly snapshot tables

Status: Proposed (Phase 8.2) · Date: 2026-11-23 · Binding detail: PHASE-8-2-CONTRACT §1 (P82-1 – P82-20), §5

## Context
Roadmap 8.2 asks for platform GMV, MRR and churn with "nightly aggregates" as the acceptance criterion. The super-admin
Figma (`15:123`, `39:12705`, `32:5527`, `33:4851`) shows MRR by plan over 12 months, MRR movement (new, expansion,
contraction, churn), cohort retention and per-shop MRR/GMV columns. Constraints:
- Subscriptions are **mutated in place** (PHASE-7 P7-2): trial end, renewals, upgrades and scheduled changes rewrite
  the one current row. Yesterday's plan or status of a shop can't be read back later; only invoices and orders keep
  history.
- RLS (ADR 0012): request paths run as `storeplix_app`; cross-tenant reads happen only on `pgsql_admin` in allowlisted
  directories (`app/Domain/Admin/**` since ADR 0015).
- Bangladesh-only platform; reports must use Dhaka days.

## Decision
1. **Two snapshot tables written once per Dhaka night** by `analytics:aggregate` on `pgsql_admin`:
   `tenant_daily_metrics` (tenant × day: effective plan, interval, subscription and tenant status, MRR, comp flag,
   orders, GMV) and `platform_daily_metrics` (day: sums, counts, plan maps). Every analytics endpoint reads these, never
   live per-tenant aggregates (a few documented "live" fields excepted: first paid date, lifetime paid, trial ends).
2. **Stocks are point-in-time and insert-only; flows are restated.** Plan/status/MRR of day D are captured from current
   state by the first run after D ends and never overwritten (a re-run can't invent history). Orders/GMV are restated
   for 35 days to reflect cancellations, then frozen.
3. **Movement, churn and cohorts are snapshot diffs** (per-tenant MRR at window start − 1 vs window end), with the
   reconciliation identity `new + expansion − contraction − churned = closing − opening` asserted.
4. **History before deploy** is reconstructed once by `analytics:backfill` from paid invoices (stocks, approximate,
   `source = backfill`) and orders (flows, exact).
5. **Isolation:** `tenant_daily_metrics` has `tenant_id` and is therefore a forced-RLS tenant table like every other,
   **and** the app role's privileges on both tables are revoked; only `pgsql_admin` (in `app/Domain/Admin/Analytics`)
   reads or writes them. Hourly catch-up at :20 Dhaka makes the night run self-healing without a queue worker.

## Consequences
+ A dashboard view costs a few thousand indexed rows regardless of order volume; numbers are reproducible and
  hand-checkable from fixtures; MRR movement and retention become possible at all.
+ No new bypass path or connection; the RLS catalogue check covers the new tenant table automatically.
− Numbers lag by up to one day; "today" is not shown (an explicit product choice, PHASE-8-2 §Scope).
− A missed night beyond the 7-day catch-up leaves a gap that only the (approximate) backfill can fill; late snapshots
  are labelled `late`.
− Storage grows by tenants × days (≈ 1.3 M rows/year at 3 500 shops), small for Postgres; partitioning is a Phase 9.5
  concern if ever needed.
- Not chosen: (a) live aggregate queries per request: impossible for MRR history and movement because subscriptions
  mutate in place; (b) an event-sourced `subscription_events` ledger rebuilt into MRR: more precise intra-day movement,
  but a cross-cutting change to every Phase 7 transition for a number staff read once a day; (c) an external analytics
  warehouse/BI tool: new infrastructure and a second copy of tenant PII outside RLS; (d) materialized views refreshed
  nightly: can't keep point-in-time stocks (a refresh recomputes from current state).
