# Phase 8.3 contract: Custom roles & permissions (binding for API, WEB, QA)

Status: **Accepted, 2026-11-23 (PO accepted the proposed defaults for Q113–Q125)**. Branch `feat/phase-8-3-roles`
(from `main` @ 4b69482, Phases 8.1 and 8.2 merged). Roadmap task **8.3** "Custom roles & permissions (Figma 89:26676)";
AC: **"Granular permissions enforced"**. Tasks 8.4–8.9 are **not** in this contract.

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1/8-2 contracts and docs/api/API-CONVENTIONS.md
still applies (envelope, snake_case, ULIDs, cookie sessions, `BelongsToTenant`, RLS, FeatureGate, audit log). Where this
file changes an earlier rule it says **"amends …"**. Machine-readable spec: `docs/api/openapi.yaml` **v1.11.0**
(2026-11-23), **v1.11.1** (2026-11-24: security fixes SEC-M1/M2/L3/L4, amends §3.2, §4, §6). ADRs: **0017** (new: tenant roles and granular permissions; supersedes the role matrix of 0005), 0005
(merchant auth), 0012 (RLS), 0008 (plans). Product defaults: OPEN-QUESTIONS **Q113–Q125**.

### Scope

One build cycle, one QA gate (`docs/reviews/phase-8-3-qa.md`). No external provider.

| Area | Owner | Ships |
|---|---|---|
| **Permission catalogue** | API | 22 grantable code-defined keys + owner-only `billing.manage` (§2) replacing the 13 coarse `Permission` cases; every merchant route mapped (§3) |
| **Roles model** | API | `roles`, `role_permissions`; three seeded **system roles** per tenant (owner / admin "Manager" / staff); `tenant_users.role_id`, `staff_invitations.role_id` (§5) |
| **Roles API** | API | `GET /permissions`, `GET|POST /roles`, `GET|PATCH|DELETE /roles/{role}`; staff invite / role change accept `role_id` (§6) |
| **Enforcement** | API | `perm:` route middleware on every tenant route + conditional in-code checks; non-delegation rules (§4); `TenantMembership.permissions` on `/auth/me` |
| **Staff & roles UI** | WEB | Staff page roles card + editable matrix (`60:15365`), role detail / new role (`90:26913`), invite modal role list (`90:26879`), member role change; every page/button gated on `permissions` (§7) |
| **Plan gate** | API / WEB | Custom roles need `custom_roles` (Growth); system roles on every plan (Q113) |

**Out of scope** (hide, never fake; Q rows in §1.1): warehouse access per role (Q119), per-person permission overrides in
the invite modal (Q120), seeded "Order staff"/"Packer" roles and invite-by-phone/SMS (Q121), "Change price on an order"
and "Delete orders" rows (Q115, no such features), ownership transfer (Q123), super-admin role editing (Q124); and,
unchanged from earlier phases, the Staff page "Online now", "Actions today", "Staff sign-in security" card and "Add seats".

### Conventions in this file
- Roles: **O** owner, **A** admin (UI label "Manager"), **S** staff, **C** a custom role. "Actor" = the signed-in member.
- `P(x)` = the resolved permission set of a member, role or actor. Keys are lowercase `group.verb` strings.
- **Base** = allowed to every member of the tenant, no key needed.

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>` or
  commit. Touch only owned files (§11).
- New dependencies: **none**.
- Never `migrate:fresh` the local dev DB; use Pest or a scratch DB. RLS items run on Postgres with `TENANCY_RLS=true`.
- **No behaviour change for existing tenants:** after migration every O/A/S member gets exactly today's answers on
  every route (parity test, §10). Any intended difference is listed in §3.3.

---

## 0. Summary and goals
1. A Growth merchant creates roles like "Order staff" or "Packer" from a fixed catalogue of permissions and assigns them
   to members and invitations; the API enforces each key on every route.
2. Owner / Manager / Staff remain as non-editable system roles with exactly today's powers; owner is unique and always
   has every permission.
3. Nobody can grant, assign or remove more than they hold; nobody edits their own role.
4. The SPA reads `permissions: string[]` from the membership and hides/disables what the member can't do; the API stays
   the source of truth.

---

## 1. Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| P83-1 | **Permissions are code constants** (`App\Domain\Tenancy\Authorization\Permission`, string-backed enum, §2). Roles store keys; unknown keys in the DB are ignored on read and rejected on write. | Keys guard code paths; a key without code is meaningless. Same model as DATABASE-DESIGN §6 sketch and `PlatformPermission`. |
| P83-2 | **System roles are rows, their permissions are code.** Each tenant has `roles` rows with `key` `owner`/`admin`/`staff`, `is_system = true`; `SystemRole::permissions()` defines them (§2.2). `role_permissions` holds rows for **custom** roles only. | Rows give every member a `role_id` FK; code-defined system sets pick up future keys automatically and can't drift per tenant. |
| P83-3 | **`tenant_users.role` stays** as a denormalised kind `owner`/`admin`/`staff`/`custom` kept equal to `roles.key ?? 'custom'` in the same transaction as `role_id`. | Owner uniqueness (partial unique), owner e-mail lookups, seat counter and 8.1 admin views keep working unchanged. |
| P83-4 | **Enforcement = `perm:` route middleware + conditional checks.** Every route behind the `tenant` middleware carries exactly one `perm:<key>[|<key>…]` (any-of) or `perm:base`; it runs after `tenant`/`store` so foreign ids still 404. Value-dependent rules (paid cancel, COD override, bulk delete, branding media, profit report, others' notes) stay in code and call `TenantContext::allows()`. Policies keep `inCurrentTenant` and call the new keys. | A route-coverage test can prove no route is unguarded (§10). |
| P83-5 | **Resolution:** `ResolveTenant` loads the membership joined to its role (`id`, `key`, `revision`); the set is `SystemRole::permissions()` or the role's `role_permissions` cached via `TenantCache` key `roles:{role_id}:r{revision}:permissions` (TTL 1 h). `TenantContext::set($tenant, $role, $permissions)`; `role()` returns the kind; new `permissions(): PermissionSet`, `allows(Permission)`, `allowsAny(Permission ...)`. Impersonation → owner set (still read-only, P8-10). | Revision in the key makes updates visible on the next request without a cache flush; tenant-prefixed by the helper (rule 3). |
| P83-6 | **Effect of a change:** a role edit, reassignment or member role change applies from the member's **next request**. No token or session revocation, no e-mail. The SPA refetches `/auth/me` on window focus and after any 403. | Same as today's role change; revocation would log out a cashier mid-shift for a toggle. |
| P83-7 | **Non-delegation** (§4): an actor can only grant, assign, edit, delete, remove or invite with permissions ⊆ `P(actor)`; never edits its own role or changes its own membership; owner role never assignable; system roles never editable. | Prevents escalation through roles or members (S91–S95). |
| P83-8 | **Plan gate:** creating/editing custom roles and assigning one need `custom_roles` (Growth) → 402 `feature_not_in_plan` with `details.upgrade_plan`. After a downgrade custom roles stay assigned **and enforced**; they can be viewed, deleted (with reassignment to a system role) and members moved to system roles. | Falling back to a broader role on downgrade would escalate; freezing is the safe default (Q113). |
| P83-9 | **Limits:** ≤ **20 custom roles** per tenant (`RoleService::MAX_CUSTOM = 20`) → 409 `role_limit_reached`. Name 1–40 chars, unique per tenant case-insensitively (incl. "Owner", "Manager", "Staff"). | Bounded matrix width; like `page_limit_reached`. |
| P83-10 | **Delete in use:** `DELETE /roles/{role}` with members or open invitations → 409 `role_in_use` unless `?reassign_to=<role id>`; then members and open invitations move and the role is deleted in one transaction. | No member without a role; one explicit step. |
| P83-11 | **Prerequisites:** some keys require others (§2.1 "needs"); a payload missing one → 422 `validation_failed` on `permissions`. WEB switches prerequisites on with the dependent toggle and off with the prerequisite. | Prevents nonsense roles (refund without seeing orders). |
| P83-12 | **Audit:** `role.created`, `role.updated`, `role.deleted`, `staff.role_changed` (amended meta), `staff.invited` (meta gains `role_id`, `role_name`) (§6.4). | Security-relevant merchant actions (CLAUDE.md). |
| P83-13 | **Super admin:** no new endpoint or permission. Merchant detail Staff tab shows `role_name`; `AdminTenantMember.role` gains `custom`. | Q124. |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q113–Q125; defaults accepted by the PO 2026-11-23)

| Q | Question | Default |
|---|---|---|
| Q113 | Are custom roles a paid feature? Downgrade behaviour? | Growth only (`custom_roles`); system roles on every plan; after downgrade custom roles stay assigned and enforced, can't be created/edited/assigned (402), can be deleted with reassignment (P83-8) |
| Q114 | Limit on custom roles | 20 per shop, 409 `role_limit_reached` |
| Q115 | Granularity; Figma rows without a feature | 22 keys (§2.1). "Change price on an order" (no price override exists; S39) and "Delete orders" (no order deletion) are not built; "See COD settlements & payouts" folds into `reports.view` |
| Q116 | What can a member with no permissions see? | Base (§3.1): read catalogue, stock levels (no cost), coupons, store settings, integration and domain status, dashboard aggregates. No toggle hides them |
| Q117 | Delegation and self-edit | Only permissions you hold; never your own role or membership; owner never assignable; system roles locked (§4) |
| Q118 | Deleting a role that people have | 409 `role_in_use` unless reassigned in the same request |
| Q119 | "Warehouse access" per role (`90:26913`, `90:26879`) | Hidden: multi-warehouse isn't built (Phase 8 inventory task) |
| Q120 | Per-person permissions in the invite modal | Not built: permissions come only from the role |
| Q121 | Seed "Order staff" and "Packer"; invite by phone/SMS (Figma) | Not seeded (Duplicate role covers it); invitations stay e-mail |
| Q122 | When does a change apply; sign the member out? | Next request; no sign-out, no e-mail (P83-6) |
| Q123 | Is Manager editable? Ownership transfer? | Manager is a locked system role with all 22 grantable keys; only the owner has `billing.manage`; ownership transfer not built |
| Q124 | Super-admin visibility | Role name on the merchant detail Staff tab only |
| Q125 | Mobile layout (no mobile frames in `89:26676`) | Responsive composition: matrix scrolls horizontally inside its card, role detail stacks to one column below `lg` |

---

## 2. Permission catalogue (owner API; mirrored in `packages/types` as `PermissionKey`)

### 2.1 Keys (order = UI order; groups follow Figma `90:26913` / matrix in `60:15365`)

| # | Key | Group | Label (EN) · description | Needs | Sensitive | Replaces |
|---|---|---|---|---|---|---|
| 1 | `orders.view` | orders "Orders" | View & create orders · Orders, unfinished orders, returns | — | | operate |
| 2 | `orders.process` | orders | Confirm & cancel orders · Status changes, edit items, returns, payment links | 1 | | operate |
| 3 | `orders.refund` | orders | Refunds & paid cancellations · Refund money, cancel paid orders, change COD amount | 2 | ✓ | manage_refunds |
| 3a | `fraud.manage` | orders | **Phase 8.8a** (PHASE-8-8 §2.1): Fake order guard · Guard rules, blocked numbers and number checks; requires `orders.view`; O ✓ A ✓ S ✗, grantable (catalogue 26 keys, 25 grantable) | 1 | ✓ | — |
| 4 | `shipments.manage` | shipping "Shipping" | Book courier & print labels · Steadfast, Pathao, RedX | — | | operate |
| 5 | `shipments.cancel` | shipping | Change courier after booking · Cancel a booked parcel | 4 | | operate |
| 6 | `products.edit` | products "Products & stock" | Edit products & prices · Products, categories, images | — | | operate |
| 7 | `products.delete` | products | Delete products & categories | 6 | | manage_catalog |
| 8 | `inventory.adjust` | products | Adjust stock · Receive and count stock | — | | operate |
| 9 | `customers.view` | customers "Customers" | View customers · Names, phones, order history | — | | operate |
| 10 | `customers.edit` | customers | Add & edit customers · Details and notes | 9 | | operate |
| 11 | `customers.delete` | customers | Delete customers and others' notes | 10 | | manage_catalog |
| 12 | `costs.view` | money "Money & data" | See product cost & profit · Cost price, margin, profit report | — | ✓ | view_costs |
| 13 | `reports.view` | money | Reports, payouts & COD settlements · Sales and delivery reports | — | | operate (Q87) |
| 13a | `expenses.manage` | money | **Phase 8.7** (PHASE-8-7 §2.1): Record & see expenses · Expenses, receipts and export; O ✓ A ✓ S ✗, grantable | — | ✓ | — |
| 14 | `data.export` | money | Export customer phone numbers · CSV export of products and customers (product `cost_price` only with `costs.view`, §3.2) | — | ✓ | bulk_data |
| 15 | `data.import` | money | Import products & customers (CSV) · also needs the keys of what the file writes (§3.2) | — | | bulk_data |
| 16 | `marketing.manage` | store "Store & settings" | Create & edit coupons → **"Coupons & campaigns"** and sensitive from Phase 8.5 (PHASE-8-5 P85-23, §2.1) → **"Coupons, campaigns & automations"** from Phase 8.6 (PHASE-8-6 P86-18, §2.1) | — | ✓ (8.5) | manage_marketing |
| 17 | `settings.manage` | store | Change shop settings · Delivery charges, checkout, themes, pages, publish | — | | manage_settings |
| 18 | `integrations.manage` | store | Connect payments & couriers · API keys and credentials | — | ✓ | manage_integrations |
| 19 | `domains.manage` | store | Manage domains | — | | manage_domains |
| 20 | `staff.manage` | team "Team & billing" | Manage staff & roles · Invite, remove, change roles | — | ✓ | manage_staff |
| 21 | `audit.view` | team | View activity log | — | | view_audit |
| 22 | `billing.view` | team | View plan & invoices | — | | view_billing |
| — | `billing.manage` | team | Change plan & pay · **Owner only, never grantable** | 22 | ✓ | manage_billing |

`Permission` enum methods: `group()`, `requires(): list<self>`, `sensitive(): bool`, `grantable(): bool` (false only for
`BillingManage`), `label()`, `description()`. `Permission::grantedTo()` and `TenantUser::ROLES`-based checks are removed;
`grep -rn "grantedTo(" app/Domain --include=*.php` outside `Admin/` returns nothing.

### 2.2 System roles (`SystemRole` enum; seeded per tenant; never editable)

| key | name | `P(role)` |
|---|---|---|
| `owner` | Owner | all 23 keys |
| `admin` | Manager | all 22 grantable keys (everything except `billing.manage`) |
| `staff` | Staff | `orders.view`, `orders.process`, `shipments.manage`, `shipments.cancel`, `products.edit`, `inventory.adjust`, `customers.view`, `customers.edit`, `reports.view` |

Descriptions (returned by the API): Owner "Full access, billing & staff"; Manager "Everything except billing & ownership";
Staff "Products, inventory, orders & customers" (today's `roleDescription`).

---

## 3. Route → permission map (binding; `RoutePermissionsTest` checks every row)

### 3.1 Base (`perm:base`)
`GET /stores`, `GET /stores/{store}`, `/dashboard` (cost field still needs `costs.view`), `/launch-checklist`,
`POST /preview-token`, `GET /settings`, `GET /shipping`, `GET /themes[/{code}]`, `GET /pages[/{page}]`,
`GET /page-templates`, `GET /navigation`, `GET /document-templates`, `GET /payment-gateways`, `GET /couriers`,
`GET /couriers/{provider}/areas`, `GET /couriers/{provider}/pickup-stores`, `GET /domains[/{domain}]`,
`GET /products[/{product}]`, `GET /categories[/{category}]`, `GET /inventory`, `GET /inventory/movements` (cost
fields need `costs.view`), `GET /media[/{media}]`, `GET /coupons[/{coupon}]`, `GET /features`, `GET /themes` (catalog),
`GET /plans`. Paths without prefix are under `/stores/{store}`.

### 3.2 Keyed routes (`a|b` = any of)

| Area | Routes | Permission |
|---|---|---|
| Orders | `GET /orders`, `GET /orders/{order}` | `orders.view\|shipments.manage` |
| | `POST /orders`, `POST /orders/quote`, `POST /orders/{order}/notes`, `GET /orders/{order}/payment-links` | `orders.view` |
| | `PATCH /orders/{order}`, `confirm`, `ready`, `ship`, `deliver`, `return`, `cancel`, `POST /orders/bulk`, `PUT /orders/{order}/items`, `POST /orders/{order}/items/quote`, `POST /orders/{order}/restock`, `POST|DELETE /payment-links[/{link}]`, `POST …/resend` | `orders.process` |
| | `POST /orders/{order}/refunds` | `orders.refund` |
| | `POST /orders/{order}/guard/release` (Phase 8.8a) | `orders.process` |
| Fake order guard (Phase 8.8a) | every `/fraud-guard/*` route: settings, reset, overview, events, blocked numbers, check (PHASE-8-8 §8.1) | `fraud.manage` |
| Returns | `GET /returns`, `GET /returns/{return}`, `POST /returns/{return}/notes` | `orders.view` |
| | `POST /orders/{order}/returns`, `approve`, `reject`, `receive`, `close`, `exchange-order` | `orders.process` |
| Shipments | `GET /shipments`, `GET /shipments/{shipment}`, `GET /shipment-batches/{batch}` | `shipments.manage\|orders.view` |
| | `POST /orders/{order}/shipments`, `POST /shipments/bulk`, `POST /shipments/sync`, `POST /shipments/{shipment}/refresh` | `shipments.manage` |
| | `POST /shipments/{shipment}/cancel`, `mark-cancelled` | `shipments.cancel` |
| Documents | `POST /documents`, `POST /documents/preview`, `GET /documents/{document}`, `GET /api/v1/documents/{document}/download` | `orders.view\|shipments.manage` |
| | `PUT /document-templates/{kind}` | `settings.manage` |
| Catalog | `POST|PATCH /products[/{product}]`, `POST /products/{product}/duplicate`, `POST /products/bulk`, `POST|PATCH /categories[/{category}]`, `PUT /categories/order` | `products.edit` |
| | `DELETE /products/{product}`, `DELETE /categories/{category}` | `products.delete` |
| Inventory | `POST /inventory/adjustments`, `PATCH /inventory/{variant}` | `inventory.adjust` |
| Customers | `GET /customers[/{customer}]` | `customers.view` |
| | `POST|PATCH /customers[/{customer}]`, `POST /customers/{customer}/notes`, `DELETE …/notes/{note}` | `customers.edit` |
| | `DELETE /customers/{customer}` | `customers.delete` |
| Media | `POST /media`, `DELETE /media/{media}` | `products.edit\|settings.manage` |
| Coupons | `POST|PATCH|DELETE /coupons[/{coupon}]` | `marketing.manage` |
| Reports | `GET /reports/sales`, `GET /reports/delivery` | `reports.view` |
| | `GET /reports/profit` | `reports.view` (+ `costs.view` in code, + `profit_reports` feature) |
| Expenses (Phase 8.7) | every `/expenses*` route incl. receipts and export (PHASE-8-7 §8.1) | `expenses.manage` |
| Data | every `/imports*` route | `data.import` (+ in code, SEC-M2: upload/validate/run of `type=products` also need `products.edit` and `inventory.adjust`, run also `costs.view` when a row sets cost; `type=customers` needs `customers.edit`; else 403 `forbidden`) |
| | `POST /exports`, `GET /exports/{export}`, `GET /api/v1/exports/{export}/download` | `data.export` |
| Settings | `POST /api/v1/stores`, `PATCH /settings`, `PUT /shipping`, `POST|PATCH|DELETE /pickup-locations[/{location}]`, `POST /themes/{code}/apply|discard|publish`, `PUT /themes/{code}/draft`, `POST|PATCH|DELETE /pages[/{page}]`, `PUT /navigation/{handle}`, `POST /publish` | `settings.manage` |
| Integrations | `PUT|PATCH|DELETE /payment-gateways/{provider}`, `POST …/test-payment`, `PUT|PATCH|DELETE /couriers/{provider}`, `POST /couriers/{provider}/test`, `POST …/webhook-secret` | `integrations.manage` |
| Domains | `POST /domains`, `POST /domains/{domain}/verify`, `POST …/primary`, `DELETE /domains/{domain}` | `domains.manage` |
| Staff | `GET /staff`, `POST /staff/invitations`, `DELETE /staff/invitations/{invitation}`, `POST …/resend`, `PATCH /staff/{member}` | `staff.manage` |
| | `DELETE /staff/{member}` | `perm:base`; in code: self (leave) or `staff.manage` (unchanged rule) |
| Roles | `GET /permissions`, `GET /roles`, `GET /roles/{role}`, `POST /roles`, `PATCH /roles/{role}`, `DELETE /roles/{role}` | `staff.manage` (+ §4, + feature for writes) |
| Audit | `GET /audit-logs` | `audit.view` |
| Billing | `GET /subscription`, `GET /billing/invoices[/{invoice}]`, `…/pdf`, `GET /billing/payments/{payment}`, `POST /billing/quote` | `billing.view` |
| | `POST /billing/change-plan`, `DELETE /billing/scheduled-change`, `POST /billing/invoices/{invoice}/pay`, testing `POST /dev/billing/clock` | `billing.manage` |

Not tenant routes (no `perm:`): `/auth/*`, `/invitations/{token}*`, `/geo/bd`, `/health`, webhooks, payment/billing
returns, `/internal/*`, `/storefront/*`, `/admin/*`, other `/dev/*`.

**Conditional checks in code** (each replaces today's `grantedTo` call 1:1):
| Where | Rule |
|---|---|
| `OrderStateMachine`, `OrderService::cancel`, bulk cancel | cancelling an order with `paid_amount > 0` needs `orders.refund` (403 `forbidden`) |
| `ReturnService` exchange difference < 0 | `orders.refund` |
| `BookingService::book` with `cod_amount` | `orders.refund` (S33) |
| `ProductController::bulk` `action=delete` | `products.delete` |
| `MediaPolicy::delete` logo/favicon | `settings.manage` |
| `CustomerPresenter::canDeleteNote` / delete another author's note | author or `customers.delete` |
| `ReportController::profit` | `costs.view` |
| `ImportController` store / validate / run (SEC-M2, amended 2026-11-24) | products: `products.edit` + `inventory.adjust` (+ `costs.view` on run when any row sets `cost_price`); customers: `customers.edit` → 403 `forbidden` |
| `ExportController::store` → `RunExport` (SEC-M1) | `data_exports.include_costs` = requester holds `costs.view`; false → product `cost_price` column empty (migration `000500`, default false) |
| Cost fields (product, variant, inventory, order items, dashboard `stock_value_cost_amount`, order placement/edit previews) | `costs.view`, else null as today |
| `OrderPresenter` `actions.refund`, payment `can_refund` | `orders.refund` |
| `DomainPresenter` `manage` | `domains.manage` |
| `BillingPresenter` `can_pay` | `billing.manage` |
| Gates `bulk-data` → split into `data.import` / `data.export`; `audit.view`, `billing.view|manage|features`, `integrations.view|manage` | redefined on the new keys (`billing.features` and `integrations.view` = base) |

### 3.3 Intended behaviour differences for system roles
None. (`POST /media` was open to every role; S has `products.edit`, so S, A, O keep it.) The parity test (§10) is the
proof.

---

## 4. Non-delegation and self rules (enforced in `RoleService` / `StaffService`, inside the locking transaction)

| # | Rule | Error |
|---|---|---|
| N1 | `POST/PATCH /roles`: every key in `permissions` ∈ `P(actor)` and grantable | 403 `permission_not_held`, `details.permissions: [keys]` |
| N2 | `PATCH/DELETE /roles/{role}`: current `P(role)` ⊆ `P(actor)` | 403 `permission_not_held` |
| N3 | `PATCH/DELETE /roles/{role}` where `role.id` = actor's `role_id` | 403 `cannot_edit_own_role` |
| N4 | System role (`is_system`) on PATCH/DELETE | 409 `system_role_locked` |
| N5 | Assign (invite, `PATCH /staff/{member}`, `reassign_to`): target `P(role)` ⊆ `P(actor)`; target is never the owner role | 403 `permission_not_held`; owner role → 422 `validation_failed` (`role_id`) |
| N6 | `PATCH /staff/{member}` and `DELETE /staff/{member}` (not self), invitation revoke/resend: current `P(member or invitation role)` ⊆ `P(actor)` | 403 `permission_not_held` |
| N7 | Own membership: `PATCH /staff/{member}` on self | 403 `cannot_change_own_role` (unchanged) |
| N8 | Owner membership: change or remove | 409 `last_owner` (unchanged) |
| N9 | Custom role as target of an assignment, or POST/PATCH of a custom role, without `custom_roles`. **Accepting an invitation is an assignment** (SEC-L4): a custom-role invitation sent before a downgrade can't be accepted after it | 402 `feature_not_in_plan` (`details.upgrade_plan: ["growth"]`) |

Evaluation order per request: `perm:` (403 `forbidden`) → 404s (foreign role/member) → N4 → N3/N7 → N9 → N1/N2/N5/N6 →
validation (422) → N8/limits/conflicts (409). **SEC-L3/L5 (2026-11-24):** N2, N5, N6 and N8 are evaluated again on the
rows locked by the writing transaction (tenant row first, then membership, role, target role); a role row that can't be
read counts as holding every permission (fails closed: only the owner passes). The owner passes N1/N2/N5/N6 trivially; an admin passes them for every
role except an owner-only key, which is never grantable anyway.

---

## 5. Data (migrations, owner API) — prefix `2026_11_01_`, forward-only

### 5.1 New tables (both `BelongsToTenant`, RLS in the create migration, listed in `RlsTables::SPECIAL` and the emergency script)
- **`roles`**: `id` char(26) PK · `tenant_id` FK tenants CASCADE · `key` varchar(16) null CHECK IN (`owner`,`admin`,`staff`)
  · `name` varchar(40) · `description` varchar(200) null · `is_system` boolean · `revision` integer default 1 ·
  `created_by`, `updated_by` char(26) null FK users SET NULL · timestamptz timestamps.
  **U(tenant_id, id)** (FK target) · **U(tenant_id, key) WHERE key IS NOT NULL** · **U(tenant_id, lower(name))** ·
  CHECK `is_system = (key IS NOT NULL)`.
- **`role_permissions`**: `tenant_id` · `role_id` · `permission` varchar(48) CHECK `permission ~ '^[a-z]+\.[a-z_]+$'` ·
  `created_at`. **PK(tenant_id, role_id, permission)**; FK `(tenant_id, role_id) → roles(tenant_id, id)` ON DELETE
  CASCADE. Only custom roles have rows (P83-2).
- **RLS policies** (special, because `/auth/me` lists every membership without a tenant context): SELECT
  `tenant_id = app_current_tenant()::bpchar OR tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id =
  app_current_user()::bpchar)`; INSERT/UPDATE/DELETE current tenant only. `RlsCoverageTest` gains both.

### 5.2 Changed tables
- `000200` **tenant_users** + `role_id char(26) null`; **staff_invitations** + `role_id char(26) null`;
  `tenant_users.role` CHECK becomes IN (`owner`,`admin`,`staff`,`custom`); `staff_invitations.role` accepts
  `admin`,`staff`,`custom` (app rule; column unchanged).
- `000300` **backfill** (idempotent, chunked by tenant, runs as `pgsql_owner`): per tenant insert the three system roles
  if missing (`SystemRoles::ensure`), set `role_id` from `role` on `tenant_users` and on **all** `staff_invitations`.
- `000400` **constrain**: both `role_id` NOT NULL; FK `(tenant_id, role_id) → roles(tenant_id, id)` ON DELETE RESTRICT;
  IX `tenant_users(tenant_id, role_id)`, `staff_invitations(tenant_id, role_id)`.
- Every code path that creates a tenant (`AuthController::register`, factories, e2e seeders) calls
  `SystemRoles::ensure($tenant)` in the same transaction. Every write of `role_id` writes `role` (P83-3).

---

## 6. API endpoints (owner API; openapi 1.11.0 is binding)

### 6.1 New
| Method | Path | Body / query | Success | Errors |
|---|---|---|---|---|
| GET | `/permissions` | — | 200 `PermissionGroup[]` (catalogue §2.1, grantable keys + `billing.manage` with `grantable: false`) | 403 |
| GET | `/roles` | — | 200 `Role[]` (system first: owner, admin, staff; then custom by name), `meta: RolesMeta` | 403 |
| POST | `/roles` | `CreateRoleInput { name, description?, permissions[] }` | 201 `RoleDetail` | 402, 403 (N1), 409 `role_limit_reached`, 422 |
| GET | `/roles/{role}` | — | 200 `RoleDetail` | 403, 404 |
| PATCH | `/roles/{role}` | `UpdateRoleInput { revision, name?, description?, permissions? }` | 200 `RoleDetail` | 402, 403 (N1–N3), 404, 409 `system_role_locked` / `revision_conflict`, 422 |
| DELETE | `/roles/{role}` | `?revision=<int>` (required, 1.11.1) `&reassign_to=<ulid>` | 204 | 402 (custom target), 403, 404, 409 `system_role_locked` / `revision_conflict` / `role_in_use` (`details.members`, `details.invitations`: id arrays, ApiError shape), 422 (`revision` missing; `reassign_to` unknown, same role, or owner) |

`permissions` = array of distinct grantable keys (0–22 items; empty is allowed: base access only). PATCH with
`permissions` replaces the set; every successful PATCH increments `revision`.

### 6.2 Changed (amends PHASE-2 staff endpoints)
- `POST /staff/invitations`: body takes **`role_id`** (preferred) **or** legacy `role` (`admin`|`staff`, mapped to the
  system role); exactly one; N5, N9. Response `StaffMember` gains fields below.
- `PATCH /staff/{member}`: `UpdateStaffRoleInput { role_id } | { role }` (same rule); N5–N9. No-op if unchanged.
- `DELETE /staff/{member}`, invitation revoke/resend: N6.
- `GET /staff`: each `StaffMember` gains `role_id`, `role_name`; `role` may be `custom`.
- `GET /auth/me`, token responses, `POST /invitations/{token}/accept` (200): `TenantMembership` gains `role_id`,
  `role_name`, `permissions: PermissionKey[]` (sorted catalogue order); `role` may be `custom`. Impersonation: owner
  set.
- `GET /invitations/{token}`: `InvitationPreview.role` may be `custom`; gains `role_name`.
- `POST /invitations/{token}/accept`: a custom-role invitation needs `custom_roles` at accept time (N9) → 402
  `feature_not_in_plan` (`details.upgrade_plan: ["growth"]`); nothing is created (1.11.1, SEC-L4).
- `GET /admin/tenants/{tenant}/members`: `AdminTenantMember.role` may be `custom`; gains `role_name`.

### 6.3 Shapes (summary; openapi is binding)
```
Role        { id, key: 'owner'|'admin'|'staff'|null, name, description|null, is_system, permissions: PermissionKey[],
              members_count, invitations_count, members_preview: {id, name}[] (≤ 3, members first),
              editable: boolean   // false for system roles, the actor's own role, or N2/N9 failing
              revision, created_at, updated_at, updated_by: {id, name}|null }
RoleDetail  Role & { members: RoleMember[] }   // members then open invitations, name order
RoleMember  { id, kind: 'member'|'invitation', user_id|null, name|null, email, phone|null,
              status: 'active'|'invited'|'expired', is_you }
RolesMeta   { custom_roles_used, custom_roles_limit: 20, custom_roles_enabled: boolean }
PermissionGroup      { key: 'orders'|'shipping'|'products'|'customers'|'money'|'store'|'team', label, permissions: PermissionDefinition[] }
PermissionDefinition { key: PermissionKey, label, description|null, requires: PermissionKey[], sensitive, grantable }
```
`owner.permissions` lists all 23 keys. Labels are English; WEB translates by key and falls back to `label`.

### 6.4 Audit rows (tenant log, actor = user)
| Action | Subject | `meta` |
|---|---|---|
| `role.created` | role | `{ name, permissions }` |
| `role.updated` | role | `{ changes: { name?: {from,to}, description?: {from,to}, permissions?: {added: [], removed: []} } }` (not written for no-op) |
| `role.deleted` | role (id kept, row gone) | `{ name, reassigned_to: {id, name}|null, members_moved, invitations_moved }` |
| `staff.role_changed` (amended) | tenant_user | `{ changes: { role: { from, to } } }` where from/to are role **names**, + `role_id: {from, to}`; one row per member also on `reassign_to` |
| `staff.invited` (amended) | invitation | `{ role, role_id, role_name }` |

### 6.5 Error codes (API-CONVENTIONS §3 gains them)
New: `permission_not_held`, `cannot_edit_own_role` (403); `system_role_locked`, `role_in_use`, `role_limit_reached` (409).
Reused: `forbidden`, `cannot_change_own_role`, `feature_not_in_plan`, `revision_conflict`, `last_owner`,
`validation_failed`, `not_found`.

---

## 7. Merchant dashboard (owner WEB) — Figma file `2W1wMKN79hhcr1czQS63oN`, section `89:26676`

Frames: Staff main `60:15365` (in `60:15363`), Invite modal `90:26879` (in `90:26504`), Role detail `90:26915` (in
`90:26913`). States: `148:34032`. Components from `packages/ui` only; tokens, no raw hex.

### 7.1 Permission plumbing
- `lib/permissions.ts`: `can.*` reads `activeTenant.permissions` (`has(key)`), `ROLE_CAN` is gone. Mapping:
  `viewCosts→costs.view`, `manageCatalog→products.delete` (customers page: `customers.delete`), `bulkData→data.import`
  (import page) / `data.export` (export buttons), `manageMarketing→marketing.manage`, `manageRefunds→orders.refund`,
  `manageSettings`/`editSettings→settings.manage`, `manageIntegrations→integrations.manage`,
  `manageDomains→domains.manage`, `manageStaff→staff.manage`, `viewAuditLog→audit.view`, `viewBilling→billing.view`,
  `manageBilling→billing.manage`, `createStore→settings.manage`; new helpers for every key in §2.1.
  `changeRole`/`removeMember`/`manageInvitation` add N5/N6 (`P(target) ⊆ P(me)`) using `GET /roles` data.
- Nav and routes: Orders `/orders*` and `/returns` need `orders.view` (orders list also visible with
  `shipments.manage`); `/shipments*` and `/orders/print` need `shipments.manage|orders.view`; `/customers*`
  `customers.view`; `/reports/sales|delivery` `reports.view`, `/reports/profit` + `costs.view`; `/products/import`
  `data.import`; `/staff` `staff.manage` (others see the existing "no access" state); `/settings/plan` billing as today.
  Hidden items are removed, not disabled; a deep link without permission shows the `148:34032` no-access state.
- Buttons: create/edit/delete/status actions are hidden when the key is missing (existing pattern for staff).
- On any 403 and on window focus, refetch `['me']`; permissions update in place.

### 7.2 Staff page `/staff` (`60:15365`)
- KPI row as built. **Team** table: role pill shows `role_name` (system colours as today; custom roles use the
  "Order staff"/"Packer" pill styles from Figma, cycling). Row menu "Change role" opens a role picker listing roles the
  actor may assign (N5).
- **Roles** card (right column): every role with pill, `members_count` "N people", description, `members_preview`
  avatars, chevron → `/staff/roles/:roleId`; "+ Custom role" → `/staff/roles/new`. Footer note from Figma when any
  role lacks `costs.view`: "{names} never see cost price or profit."
- **Roles & permissions** matrix: rows = §2.1 keys grouped by `PermissionGroup` (sub-header rows), sensitive rows
  highlighted (Figma "Sensitive" chip); columns = roles (Owner first, horizontal scroll past 5). Owner and system
  columns are disabled checkboxes; custom columns with `editable` are live checkboxes. Ticking stages a change; the
  **Unsaved changes** bar (`90:26915` bottom) shows "Discard" / "Save changes" → one `PATCH /roles/{id}` per changed
  role (with `revision`); prerequisites auto-tick (P83-11); 409 `revision_conflict` → toast + refetch.
- "+ Custom role" (header button) same as the card link. Without `custom_roles`: both open the existing Phase 7 upgrade
  prompt (`feature_not_in_plan` pattern) instead of the editor; custom columns become read-only with a "Growth plan"
  note.

### 7.3 Role detail `/staff/roles/:roleId` and `/staff/roles/new[?from=:roleId]` (`90:26915`)
- Breadcrumb Staff › Roles › name; title, subtitle "Role · N people · edited {date} by {name}"; buttons "Duplicate
  role" (→ `/new?from=id`, name "{name} copy") and "Save role" (primary; disabled when clean).
- **Role details** card: name, description; Warehouse access **hidden** (Q119).
- **People with this role** card: members/invitations with Active/Invited pills; "+ Assign" opens a picker of members
  whose role the actor may change (N5/N6) → `PATCH /staff/{member}`.
- Permission cards per group with toggles (label + description); sensitive keys in the amber block with the "Sensitive"
  chip and the Figma "When off: …" hint for `costs.view`. Toggles for keys the actor lacks are disabled with tooltip
  "You don't have this permission". System roles: all toggles disabled + info banner "Built-in role. Duplicate it to
  customise." Own role: same banner text "You can't edit your own role."
- **Delete role** (custom, `editable`): text-danger button at the bottom of the left column → confirm dialog; if
  people use it, a required "Move people to" select (assignable roles) → `DELETE ?reassign_to=`.
- Unsaved-changes bar as in Figma (summary of the last change, Discard, Save changes); route-leave guard.
- Loading/empty/error per `148:34032`; 404 → not-found state.

### 7.4 Invite modal (`90:26879`)
Role radio list = assignable roles (Manager, Staff, then custom roles; disabled with reason when N5 fails; custom roles
hidden without the feature) showing description and, for Manager, "Full access". Name, e-mail (existing field; phone
invite not built, Q121), seat notice as built. "Warehouse access" and "Permissions for this person" are **not shown**
(Q119, Q120). Sends `role_id`.

### 7.5 Super admin
Merchant detail Staff tab shows `role_name` instead of the fixed label map (`custom` falls back to the name). Nothing else.

---

## 8. Appendix A — `packages/types` changes (orchestrator applies; from openapi 1.11.0)
```ts
export type TenantRole = 'owner' | 'admin' | 'staff' | 'custom';
export type SystemRoleKey = 'owner' | 'admin' | 'staff';
export type PermissionKey =
  | 'orders.view' | 'orders.process' | 'orders.refund' | 'shipments.manage' | 'shipments.cancel'
  | 'products.edit' | 'products.delete' | 'inventory.adjust' | 'customers.view' | 'customers.edit' | 'customers.delete'
  | 'costs.view' | 'reports.view' | 'data.export' | 'data.import' | 'marketing.manage' | 'settings.manage'
  | 'integrations.manage' | 'domains.manage' | 'staff.manage' | 'audit.view' | 'billing.view' | 'billing.manage';
export type PermissionGroupKey = 'orders' | 'shipping' | 'products' | 'customers' | 'money' | 'store' | 'team';
export interface TenantMembership { id: string; name: string; role: TenantRole; role_id: string; role_name: string; permissions: PermissionKey[] }
export type AssignableRole = 'admin' | 'staff';                         // legacy input only (was Exclude<TenantRole,'owner'>)
// StaffMember: role: TenantRole (now incl. 'custom'); + role_id: string; + role_name: string
export type InviteStaffInput = { email: string; name?: string | null } & ({ role_id: string; role?: never } | { role: AssignableRole; role_id?: never });
export type UpdateStaffRoleInput = { role_id: string; role?: never } | { role: AssignableRole; role_id?: never };
// InvitationPreview: role: Exclude<TenantRole, 'owner'>; + role_name: string
// AdminTenantMember: role: TenantRole; + role_name: string
export interface PermissionDefinition { key: PermissionKey; label: string; description: string | null; requires: PermissionKey[]; sensitive: boolean; grantable: boolean }
export interface PermissionGroup { key: PermissionGroupKey; label: string; permissions: PermissionDefinition[] }
export interface RoleMemberPreview { id: string; name: string }
export interface Role {
  id: string; key: SystemRoleKey | null; name: string; description: string | null; is_system: boolean;
  permissions: PermissionKey[]; members_count: number; invitations_count: number; members_preview: RoleMemberPreview[];
  editable: boolean; revision: number; created_at: string; updated_at: string; updated_by: { id: string; name: string } | null;
}
export interface RoleMember { id: string; kind: 'member' | 'invitation'; user_id: string | null; name: string | null; email: string; phone: string | null; status: 'active' | 'invited' | 'expired'; is_you: boolean }
export interface RoleDetail extends Role { members: RoleMember[] }
export interface RolesMeta { custom_roles_used: number; custom_roles_limit: number; custom_roles_enabled: boolean }
export interface CreateRoleInput { name: string; description?: string | null; permissions: PermissionKey[] }
export interface UpdateRoleInput { revision: number; name?: string; description?: string | null; permissions?: PermissionKey[] }
export const PERMISSION_KEYS: readonly PermissionKey[];               // §2.1 order, billing.manage last
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly PermissionKey[]>; // §2.2
// REMOVED: ROLE_CAN (only consumer: merchant-dashboard src/lib/permissions.ts, WEB updates it)
```
`packages/api-client` (WEB) adds `permissions.list()`, `roles.list()`, `roles.get(id)`, `roles.create(input)`,
`roles.update(id, input)`, `roles.remove(id, { reassign_to? })`; staff invite/update accept the new inputs.

---

## 9. Security checklist (numbering continues S91–S99; each has a test in §10)

| # | Threat | Control | Test |
|---|---|---|---|
| S91 | **Unguarded route** after the refactor | `perm:` on every `tenant` route | `RoutePermissionsTest`: every route with `tenant` middleware has exactly one `perm:` and it equals §3 |
| S92 | **Escalation by granting** | N1, N2 | Custom role with `staff.manage` only tries to create a role with `costs.view` → 403 `permission_not_held` |
| S93 | **Escalation by assignment** | N5, N6, owner never assignable | Same actor assigns Manager / removes a Manager / revokes a Manager invitation → 403; `role_id` = owner role → 422 |
| S94 | **Self-escalation** | N3, N7 | Actor edits own role → 403 `cannot_edit_own_role`; changes own membership → 403 |
| S95 | **System role tampering** | N4; system sets in code | PATCH/DELETE system role → 409; `role_permissions` rows for a system role are ignored |
| S96 | **Cross-tenant roles** | `BelongsToTenant`, composite FKs, RLS | `assertTenantIsolation` on `/roles/{role}`; `role_id` / `reassign_to` of another tenant → 422 (not found in tenant); RLS: app role can't SELECT another tenant's roles unless a member |
| S97 | **Stale permissions** | Revision-keyed `TenantCache` | Remove a key → member's next request 403 without cache flush |
| S98 | **Downgrade escalation** | P83-8 | After downgrade a custom-role member keeps exactly `P(role)`; POST/PATCH role → 402 |
| S99 | **Unknown keys** | Enum validation; DB CHECK | Unknown/owner-only key in payload → 422; injected DB row with unknown key ignored |

SECURITY.md gains T33 (S91–S99) after acceptance (ARCH follow-up).

---

## 10. Test requirements

### API (Pest; group `roles`; RLS items also `rls`, security items `security`)
- **`PermissionParityTest` (the AC proof):** before the refactor, API records on `main` a fixture
  `tests/Fixtures/permission-parity.json` = status code of every merchant tenant route (fixed seeded store, valid
  minimal bodies, `Idempotency-Key` where needed) × {owner, admin, staff}; after the refactor the same requests give
  the same codes (± only 422-vs-201 noise from body state, which the fixture pins by resetting state per case).
- **`RoutePermissionsTest`** (S91): route list ↔ §3 table, both directions; unmapped or extra route fails.
- **`PermissionCatalogueTest`**: 23 keys, groups, prerequisites closed (no cycles), `SystemRole` sets = §2.2, owner =
  all, admin = all grantable; `PERMISSION_KEYS` in types equals the enum (snapshot of enum values).
- **Per-key enforcement dataset**: for each of the 22 grantable keys, a custom role with only that key (+ prerequisites)
  gets 2xx on one representative route of the key and 403 on one route of a sibling key; base routes 200 with an
  empty role. Conditional checks (§3.2 table) each with allowed/denied cases (paid cancel, COD override, bulk delete,
  branding delete, others' note, profit report, cost fields null).
- **`RolesApiTest`**: list order + meta; create (happy, duplicate name incl. "manager" case-insensitively → 422,
  prerequisites → 422, 21st custom → 409, unknown/owner-only key → 422); get detail (members + invitations); PATCH
  (revision → 409 `revision_conflict`, permissions replace, revision++); DELETE (unused 204; in use → 409 with member/invitation ids in details;
  `reassign_to` moves members **and** open invitations atomically; reassign to self/owner/foreign → 422); N1–N9 each;
  402 without `custom_roles` for create/update/assign, but list/get/delete-with-system-reassign work; audit rows and
  meta exactly as §6.4.
- **`StaffRolesTest`**: invite with `role_id` and with legacy `role`; both → 422; accept invitation → membership
  `role_id`/`role` consistent; `PATCH /staff/{member}` with custom role; `tenant_users.role` = `custom` /
  key always in sync; seat counter unchanged; owner notifications still reach the owner.
- **`MeTest`**: `tenants[*].permissions` per membership (two tenants, different roles), impersonation = owner set;
  change a role → next `/auth/me` reflects it (S97).
- **Isolation:** `assertTenantIsolation` for `GET|PATCH|DELETE /roles/{role}`; `role_id`/`reassign_to` from tenant B
  rejected in tenant A.
- **Migration test:** seeded pre-8.3 tenants (O/A/S members, open + accepted + revoked invitations) → after 000300/000400
  every row has the matching system `role_id`; re-running 000300 is a no-op; registration creates 3 system roles.
- **`rls` group** (Postgres, `TENANCY_RLS=true`): `RlsCoverageTest` includes `roles`, `role_permissions`; member-read
  policy (user in A and B reads both roles via `/auth/me`; user in A only can't read B's roles); writes limited to the
  current tenant.

### Web (Vitest + Testing Library, merchant-dashboard)
`can.*` from permissions (each helper), nav hiding per §7.1, Staff page roles card + matrix (system columns disabled,
custom editable, prerequisites auto-tick, unsaved bar save/discard, revision conflict), role detail (new, duplicate,
system read-only banner, own-role banner, disabled toggles not held, delete with reassign, 402 upgrade prompt), invite
modal role list (N5-disabled, custom hidden without feature), loading/empty/error states.

### QA (Playwright, `tests/e2e/specs/phase8-3.*.spec.ts`)
- `phase8-3.roles`: Growth owner creates "Order staff" (orders.view, orders.process, shipments.manage), invites a
  member with it, member signs in → sees Orders/Shipments, no Customers/Reports/Staff nav (Settings stays visible per §7.1; settings
  pages are read-only without `settings.manage`, which each action enforces — P83-QA-3), product cost hidden;
  direct API call to `/customers` → 403; owner adds `customers.view` → member's next navigation shows Customers.
- `phase8-3.delegation`: a custom role with `staff.manage` can't assign Manager (UI disabled, API 403).
- `phase8-3.plan`: Free shop sees the upgrade prompt on "+ Custom role".
- `phase8-3.legacy`: existing O/A/S flows of earlier phase specs still pass (run `phase5*`, `phase6*`, `phase7*` smoke).
- `phase8-3.visual`: 1280 px and 375 px screenshots of `/staff`, `/staff/roles/:id`, invite modal.

---

## 11. File ownership for Phase 8.3

| Agent | Owns (create/edit) |
|---|---|
| **API** | `apps/api/**`: migrations §5, `Tenancy/Authorization/**` (`Permission`, `SystemRole`, `PermissionSet`, `RequirePermission` middleware alias `perm`), `TenantContext`, `ResolveTenant`, `RlsTables` + emergency script, all policies/controllers/presenters/gates listed in §3, `app/Domain/Staff/Roles/**` (new: model, service, controller, requests, presenter), staff invite/accept/update, `UserResource`, admin member presenter, routes, factories/seeders, parity fixture |
| **WEB** | `apps/merchant-dashboard/**` (§7), `apps/super-admin/**` (role_name only, §7.5), `packages/ui/**`, `packages/api-client/**` |
| **QA** | `tests/e2e/**` (`phase8-3.*`), `.github/**` (Pest group `roles` in sqlite/Postgres/`api-rls`), `docs/development/TESTING.md`, `docs/reviews/phase-8-3-qa.md` |
| **Orchestrator** | `packages/types` (§8) |
| **ARCH** | This file, `openapi.yaml` 1.11.0, ADR 0017, OPEN-QUESTIONS Q113–Q125, DATABASE-DESIGN, roadmap, FIGMA-INDEX 8.3 rows; after acceptance: API-CONVENTIONS §3 error codes, SECURITY T33, MULTI-TENANCY (roles tables in the special-policy list) |

---

## 12. Order of work
1. **ARCH:** this contract, openapi 1.11.0, ADR 0017, Q rows. **Orchestrator:** types (§8).
2. **API:** record the parity fixture on the unchanged code first → enum + `SystemRole` + context/resolution →
   migrations + backfill → `perm:` middleware on routes + conditional checks (parity green) → roles API + N-rules →
   staff/invite changes → `/auth/me` fields → audit → RLS.
3. **WEB:** typecheck fix (`lib/permissions.ts` off `ROLE_CAN`, `rolePill` record gains `custom`), then permission
   plumbing → Staff page → role detail → invite modal → super-admin `role_name`.
4. **QA:** CI group wiring, `phase8-3.*` specs → gate `docs/reviews/phase-8-3-qa.md`.

---

## 13. Acceptance criteria
1. **Granular permissions enforced:** every merchant tenant route requires the §3 key (route test green); each key has
   allow/deny tests; conditional checks covered.
2. Existing tenants: O/A/S members get identical status codes on every route (parity test green on sqlite and Postgres).
3. Custom roles: create/edit/duplicate/delete-with-reassign, assign to members and invitations, Growth-gated, ≤ 20,
   audited; changes apply on the member's next request.
4. N1–N9 hold (S91–S99 tests green); owner unique and all-powerful; system roles locked.
5. SPA hides nav, pages and actions per `permissions`; Staff page `60:15365`, role detail `90:26915`, invite modal
   `90:26879` match Figma with the documented omissions; loading/empty/error states; usable at 375 px.
6. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`, groups `roles`, `rls`, `security`),
   Playwright `phase8-3.*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml` passes for 1.11.0.
