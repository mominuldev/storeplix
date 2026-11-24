# ADR 0021 — Expenses ledger, profit after expenses and private receipts

Status: Accepted (Phase 8.7; defaults Q167–Q182 accepted, Q183 currency lock chosen by the PO, 2026-11-24) · Date:
2026-11-24 · Binding detail: PHASE-8-7-CONTRACT §1 (P87-1 – P87-18), §4–§8, §12
Builds on: ADR 0001 (shared-database tenancy), 0009 (bulk data / private files and signed downloads), 0012 (Postgres
RLS), 0017 (granular permissions); amends the PHASE-7 §6.4 profit definition (Q86).

## Context
Figma Reports · Expenses (`144:41613`) lets a merchant record what they spend outside the order flow — ads, packaging,
salaries, rent and bills, courier charges not on an invoice — with a receipt photo, and shows "Profit after expenses".
Phase 7's Profit & loss already designed an "Ad spend" line but returned `null` until expenses existed (Q86).
Constraints:
- Profit & loss is the merchant's "real profit"; changing what it subtracts changes historical numbers, so every
  changed number must be explainable and the old figure recoverable.
- Receipts are financial documents (amounts, sometimes names, phone photos with GPS). The media library is served from
  the public CDN and its generic `/media` routes are open to every role.
- Orders count in the P&L by delivery date (Q86); expenses have no delivery, only the day they were paid.
- The store currency was documented as locked once orders exist (PHASE-2 §3) but never enforced, and reports apply no
  currency filter; adding a second money source makes a later currency switch worse.
- Staff often pay for packaging in cash, but `costs.view` would also reveal cost prices and profit.

## Decision
1. **Ledger with six code-defined categories** (`ads`, `packaging`, `salaries`, `rent_bills`, `courier`, `other`)
   stored as a CHECKed varchar on `expenses`; no category table until custom categories are needed (Q182). `paid_from`
   is a label (cash, bank, card, bKash, Nagad, other). Amounts are positive minor units in the store currency.
2. **Cash-date basis in Profit & loss.** An expense counts on its `spent_on` store-local date — in summary, previous,
   daily and weekly rows — without spreading. `ads` fills `ad_spend_amount`, the other five a new
   `other_expenses_amount`; `total_cost_amount`, `net_profit_amount`, margin and per-order profit are **after**
   expenses, and `profit_before_expenses_amount` keeps the Phase 7 figure. No period locking: a back-dated expense
   changes that past range, and every write is audited with old/new values.
3. **Monthly repeat by copying the latest occurrence.** `expense_recurrences` holds only the day of month, the next
   date and a status. The hourly generator (cross-tenant discovery, per-tenant work) copies the series' latest
   occurrence onto each due date, idempotent by `UNIQUE(recurrence_id, spent_on)`. Editing the latest month carries
   forward; there is no hidden template.
4. **Receipts in the media domain, but private and outside the library.** Purpose `expense_receipt` on the private
   disk under the tenant prefix; images re-encoded by `ProcessMedia` (EXIF/GPS stripped, no variants), PDFs kept as
   uploaded. `MediaPurpose::libraryCases()` excludes the purpose from every generic `/media` path (list, upload, show,
   delete, presenter URLs). Viewing goes through a 5-minute signed URL (tenant from the signature, `ownsPath()` and
   private-disk checks) served with `nosniff`, a sandbox CSP and `attachment` for PDFs. Impersonating platform staff
   cannot mint receipt links.
5. **New permission `expenses.manage`** (sensitive, owner + admin by default, grantable). The Expenses page's
   profit tile additionally needs `reports.view`, `costs.view` and plan `profit_reports`; the ledger itself has no plan
   gate.
6. **Store currency lock.** Once a store has an order or an expense, changing `region.currency` → 409
   `currency_locked`; `StoreSettings.region.currency_locked` exposes the state. With the lock, reports keep summing
   orders and expenses without a currency filter.
7. **Report cache keyed by an expenses token.** Each expense write stores a fresh ULID token after commit; the profit
   report's 120 s cache key includes it, so a write is visible on the next request.

## Consequences
- Positive: P&L shows real profit with the Figma "Ad spend" line filled; a store without expenses sees identical
  numbers (only `ad_spend_amount` 0 instead of null); receipts never reach the CDN or the media picker.
- Negative: daily rows can show losses on rent or salary days; back-dated entries change closed months (audited, not
  locked); the `courier` category can double-count fees already on courier invoices (mitigated by UI copy only);
  `ProfitSummary.ad_spend_amount` changed from nullable to integer (clients must drop the null branch).
- Follow-ups (Q182): custom categories and budgets, ad-account spend import, receipt OCR, accrual/spreading,
  "Paid from" balances, supplier bills (8.8), gateway fee import, per-store receipt binding if multi-store ships.

## Alternatives considered
- **Ads-only in P&L** (leave salaries/rent out): rejected — Figma's Expenses tile defines profit after all costs.
- **Accrual/spreading** of rent and salaries: rejected for 8.7 — needs a period per expense and changes every daily
  figure.
- **Public media with unguessable URLs**: rejected — CDN URLs leak through logs and referrers and cannot expire.
- **Reusing `costs.view`** for expenses: rejected — would expose cost prices to anyone entering a packaging bill.
- **Filtering reports by currency** instead of locking: rejected by the PO — silently drops rows; the lock prevents
  mixed currencies at the source.
