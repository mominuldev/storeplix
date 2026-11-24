# ADR 0023 — Purchasing: suppliers, purchase orders, weighted-average landed cost, supplier balance outside expenses

Status: Accepted (Phase 8.8b; scope and key choices set by the PO (product owner), defaults Q200–Q214 accepted,
2026-11-24) · Date: 2026-11-24 · Binding detail: PHASE-8-8B-CONTRACT §1 (P88B-1 – P88B-18), §3–§9, §12
Builds on: ADR 0001 (shared-database tenancy), 0011 (orders and stock commitment), 0012 (Postgres RLS), 0017 (granular
permissions), 0021 (expenses ledger and profit after expenses).

## Context
Merchants buy stock from wholesale markets (often for cash) and import agents (often on credit — "baki" — or with an
advance). Figma Inventory · Purchase orders (`35:5619`), New PO (`35:6210`), PO detail / Receive (`36:6607`) and
Suppliers (`153:35999`) record suppliers, raise purchase orders, receive goods in one or more deliveries and show what
is owed. Constraints:
- Stock changes only through `InventoryService` (PHASE-4 P4-12: lock order, append-only ledger).
- `product_variants.cost_amount` was a hand-typed number; order lines snapshot it (P5-31) and Profit & loss uses those
  snapshots. Phase 8.7 added an expenses ledger to Profit & loss (ADR 0021).
- One stock pool per store today; multi-location, transfers and stock count are later (8.8c+).
- Purchase prices are cost data: only `costs.view` holders may see cost (P4-5), but staff often receive deliveries.

## Decision
1. **Purchase order lifecycle** `draft → ordered → partially_received → received`, plus `closed` (finish early from
   `ordered`/`partially_received`; remaining quantities stop counting as incoming) and `cancelled` (nothing received).
   Only drafts are deleted. Per-store `PO-{n}` numbers from `StoreCounter`. Optimistic `revision`. No approval step.
2. **Receiving goes through the inventory ledger.** A receipt records per-line received and damaged quantities
   (received + damaged ≤ left; damaged counts as handled, never stocked). In one transaction with the PO row locked,
   the received units go in via `InventoryService::adjust` (reason `received`, reference `purchase_order`), so the
   ledger stays the single stock audit trail. Receipts are idempotent (`Idempotency-Key`) and never deleted; a wrong
   receipt is corrected with an inventory correction plus a manual cost edit.
3. **Weighted-average landed cost.** Transport and supplier discount are spread over lines by line value (remainder to
   the largest line); landed unit cost = unit cost + share ÷ ordered quantity. On each receipt, per variant:
   `new_cost = round_half_up((max(on_hand_before, 0) × old_cost + qty × landed) / (max(on_hand_before, 0) + qty))`,
   or `landed` when the old cost is null or on hand ≤ 0. `on_hand_before` is read under the inventory row lock before
   the adjust. The receipt line keeps `cost_before`, `cost_after`, `landed_unit_cost`. A manual cost edit still
   overrides. Charges changed after a receipt affect later receipts only (no revaluation, Q205).
4. **Purchases are not expenses.** Supplier payments and PO values never write `expenses`, `ExpenseSummary` or
   Profit & loss. Product cost reaches profit only through order-line cost snapshots, so past orders and past
   Profit & loss never change; only future orders snapshot the new cost.
5. **Supplier balance is its own ledger, outside expenses.** `supplier_payments` are records (cash, bKash, Nagad, bank,
   card, other; no payout API). Owed to a supplier = Σ received value of its non-cancelled POs − Σ its payments
   (negative = credit from advances). A PO's payment status compares linked payments with its total; its `due_on` =
   first receipt + the supplier's payment terms; overdue when past due with a balance.
6. **Access.** New sensitive permission `purchasing.manage` (requires `costs.view`; owner + admin). Listing, viewing and
   receiving POs also work with `inventory.adjust`, but then every money and cost field is null and sent costs are
   ignored (cost is still written). New plan feature `purchasing` (Starter, Growth): writes 402, reads allowed.
7. **Documents without a provider.** The PO PDF uses the existing document driver; "Send to supplier" over WhatsApp is a
   client-built `wa.me` link. Supplier invoices are private uploads (purpose `purchase_invoice`, expense-receipt rules).

## Consequences
- Positive: no new provider, dependency or queue; stock and cost changes are explainable (ledger movement + receipt
  line before/after); Profit & loss becomes more accurate going forward without double counting; staff can receive
  without seeing prices.
- Negative: variant cost now moves on receipts, so inventory value at cost and future order snapshots change
  (PHASE-8-8B §6.4); the weighted average cannot attribute cost to specific batches (no FIFO); a mistaken receipt
  needs a manual correction.
- Follow-ups (Q214): approval over an amount, email sending, supplier claims for damaged pieces, returns to supplier,
  FIFO layers, landed-cost revaluation, VAT/Mushak registers, multi-location receiving.

## Alternatives considered
- **FIFO cost layers**: rejected for v1 — needs per-batch stock tracking through orders, returns and adjustments.
- **Last purchase price as cost**: rejected — market prices swing; one cheap lot would understate cost of all stock.
- **Purchases as expenses** (or supplier payments in the expenses ledger): rejected — product cost already reaches
  Profit & loss via order-line snapshots; counting purchases too would double count (PHASE-8-7 §7).
- **Owed = ordered total − payments**: rejected (Q209) — goods not yet received are not owed; advances show as credit.
- **Revaluing stock when transport/discount change after receipt**: rejected (Q205) — would rewrite cost already
  snapshotted into orders.
