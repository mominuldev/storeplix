# Figma Design Index — source of truth for all UI

File: https://www.figma.com/design/2W1wMKN79hhcr1czQS63oN/Store-Plix
fileKey: `2W1wMKN79hhcr1czQS63oN`

Rule: UI must follow this Figma file. Do not invent visual styles. Pull exact tokens/specs with the
Figma MCP (load the `figma:figma-design-to-code` skill before `get_design_context`). Page metadata
is very large (Merchant Admin desktop ≈ 4.9 MB) — query a specific section/frame id, never a whole page.

## Pages
| id | Page |
|---|---|
| 0:1 | Cover |
| 2:2 | Foundations (01 Color `127:19`, 02 Typography `128:131`, 03 Spacing/radius/elevation `128:221`, 04 Iconography `128:28752`, 05 Logo `117:2`, 06 Favicon `130:319`) |
| 2:3 | Components |
| 43:13544 | Merchant Onboarding |
| 2:4 | Merchant Admin – Desktop |
| 141:31474 | Merchant Admin – Prototype |
| 22:1736 | Merchant Admin – POS |
| 2:5 | Merchant Admin – Mobile |
| 5:189 | Platform Admin – Desktop (→ super-admin app) |
| 1:9207 | Storefront |
| 2:6 | Storefront – Mobile |
| 154:455 | Flows |
| 178:468 | Feature Presentation |

## Merchant Admin – Desktop sections (page 2:4)
26:2144 Dashboard · 41:12363 Orders list/detail/actions · 41:12364 Orders unfinished/returns ·
41:12365 Shipments/printing/fake-order guard · 44:16156 Invoice & label templates ·
141:48129 Inbox (chats→orders) · 26:2147 POS overview · 60:8983 Products · 26:2146 Inventory ·
61:12478 Customers · 61:12479 Marketing · 140:30335 Automations · 60:11810 Reports sales/profit/delivery ·
144:41613 Reports expenses · 60:11061 Online store (themes, editor, pages, domain) ·
32:5329 Integrations list · 32:5330 Courier detail · 32:5331 Payments/tracking/messaging/AI ·
144:40725 Developer (API keys & webhooks) · 89:26676 Staff & roles · 60:11161 Settings ·
148:33261 Account · 71:21271 Help · 148:34032 States (empty/loading/error) ·
2007:46186 Online store V2 (proposal) · 2028:44400 Online store V3 (proposal)

## Core tokens (from Foundations · 01 Color variables)
- brand: 50 #f3f2ff · 100 #e4e2ff · 500 #7a74ff · 600 #5b53ff (primary) · 700 #463ee0
- accent: 100 #ffe8e2 · 500 #fc856d (coral)
- text: primary #0d0d18 · secondary #5c6078 · muted #81859f · inverse #ffffff
- surface: canvas #fcfcfc · card #ffffff · subtle #f3f4f8
- border: default #ecedf2 · strong #d9dbe5
- status: success #14833b/bg #e3f4e8 · warning #b76e00/bg #fff2d9 · danger #c8312b/bg #fce6e5 · info #2563eb/bg #e3ecfd
- type (Inter): Display/40 bold 40/48 · Heading/20 semibold 20/28 · Body/16 400 16/24 · Body/14 400 14/20 ·
  Body/14 Semibold 600 14/20 · Caption/12 400 12/16 · Caption/12 Medium 500 12/16
- Elevation/1: 0 1px 3px #1A1F1A14, 0 4px 12px #1A1F1A0F
- Spacing / radius: read frame 128:221.

Brand assets (logos, favicons): `assets/brand/`.

## Online store V3 — "premium & simple" (section 2028:44400) — Phase 3 primary UI
Decision (Phase 3): V3 is the editor/online-store UI. Frame ids (each frame = Sidebar + Main unless noted):
| Screen | Frame | Notes |
|---|---|---|
| Overview | `2028:44401` (Main `2028:44403`) | |
| Themes (gallery + current theme) | `2032:44891` (Main `2032:44893`) | 9 library cards; only "Gallery" has storefront designs |
| Brand style | `2035:46054` (Main `2035:46056`) | logo/icons, style presets, colours, fonts, corners, draft bar |
| Pages | `2036:46279` (Main `2036:46281`) | |
| New page dialog | page `2046:48852`, dialog `2046:49298` | templates |
| Navigation | `2037:46510` (Main `2037:46512`) | menus + tree + live preview |
| SEO overview / SEO settings | `2043:47848` / `2044:48073` (Main `2044:48075`) | Phase 3 builds a subset of settings |
| Editor · Home · Desktop (shell, section list, settings panel, preview) | `2045:48301` (Toolbar `2045:48302`, Body `2045:48342`) | block actions `2057:51109`, Show on `2057:51202`, full-screen tooltip `2047:49090` |
| Editor · Block design (Design tab) | `2050:49617` (Toolbar `2050:49618`, Body `2050:49660`) | |
| Editor · Full screen | `2047:49102` (bar `2047:50107`) | |
| Editor · Landing page · Phone | `2045:48770` | device toggle reference (landing pages out of scope) |
| Media picker (hero image) | `2053:50828`, picker `2053:51939`; dragging `2054:51605` | |
| Quick pick (Brand style logo) | `2053:52101`, picker `2053:52607` | |
| Local components | `2033:46024`: OS3/NavPill `2033:46029`, Locked block dropdown `2057:51297`, Show on submenu `2057:51337` | |
| Out of scope (Phase 3) | Shop settings `2031:44654`, Popups `2038:46729`, Cart settings `2040:46952`, Landing pages `2041:47174`, Domains `2042:47403`, Buy a domain `2042:48250`, Media library `2051:50179` / `2052:50386` / `2052:51024` | |

V1 frames still referenced: Edit page (block list) `74:22532`.

## Storefront (page 1:9207) — theme "Gallery" (code `modern-commerce`)
Home desktop `1:10112` · tablet `1:10482` · mobile `1:10335`. Sections (desktop / mobile): Hero `1:10114` / `1:10337` ·
Shop by age `1:10153` / `1:10355` · Flash sale `1:10195` / `1:10373` · Categories `1:10216` / `1:10391` ·
New arrivals `1:10225` / `1:10406` · Editorial · Winter `1:10238` / `1:10419` · Three worlds `1:10248` / `1:10427` ·
Bestsellers `1:10279` · Promises `1:10292` / `1:10456` · Reviews & club `1:10297` / `1:10461`.
Chrome `1:10644`: header desktop `1:10645`, footer desktop `1:10700`, header mobile `1:10751`, footer mobile `1:10765`,
tab bar `1:10782`, header tablet `1:10799`. Menu drawer `1:14585`, mega menu `1:13837`.
Templates: PLP `1:10821` / `1:10946` · PDP `1:11034` / `1:11250` · Cart `1:11378` / `1:11506` · Checkout `1:11591` / `1:11690` ·
Order confirmed `1:11788` · Track order `1:11959` · Search `1:12443` · Flash sale page `1:12628` · About `1:13114` / `1:13189` ·
Help centre `1:13264` · Journal `1:13401` · Article `1:13455` · 404 `1:13565` / `1:13588`. Foundations `1:9864`, components `1:9319`, photography `1:9800`.
Storefront – Mobile (page 2:6): Product + order form `16:2`, Cart `31:6473`, Checkout `32:5087`, Order placed `33:5751`,
Track order `33:5864`, Landing page COD offer `149:1009`, Policy page (Delivery & returns) `149:1294`.

## Phase 4 — catalog, inventory, customers, dashboard (PHASE-4-CONTRACT §9)
Each desktop frame = Sidebar + Main (1440 wide).
| Screen | Frame | Notes |
|---|---|---|
| Dashboard | `10:600` (Main `10:754`; header `10:782`; KPI row `10:797`, KPI tiles `13:964`, hero money `10:798`; Today to-do `10:958`, Restock task `10:1011`) | Phase 4 builds catalog/stock cards + empty states; order/money widgets (`10:786`, `10:890`, `10:1024`, `10:1061`, `10:1085`, `10:1115`, `10:1168`) are Phase 5/7 |
| Products list | `60:8984` (Main `60:8986`); Product row `60:11336` | |
| Product editor | `60:9381` (Main `60:9383`); Variant row `61:13220` | |
| Categories & collections | `60:9778` (Main `60:9780`); Category row `63:13890` | Collections deferred |
| Import products (CSV) | `60:10175` (Main `60:10177`); Column map row `63:16638`; Import preview row `63:16857` | Also used for customer import |
| Product reviews / Barcode labels | `60:10572` / `147:32835` (label `147:32805`) | Deferred |
| Local components · Products | `60:10969` | |
| Inventory (stock levels) | `11:589` (Main `11:743`) | Stock levels + Stock movements tabs only |
| Purchase orders / New PO / Receive / Transfers / Stock count / Suppliers | `35:5619` / `35:6210` / `36:6607` / `153:34425` / `153:35246` / `153:35999` | Deferred (Phase 8) |
| Customers list | `63:14972` (Main `63:14974`); Customer/Row `61:12494`; Avatar `61:12493` | |
| Customer detail | `64:16382` (Main `64:16384`) | Contact, tags, notes only |
| Customer segments / Blocked | `65:16718` / `66:17034` | Deferred |
| Local components · Customers & Marketing | `61:12480` | |
| States: Orders empty / Products empty / Loading-error-no results | `148:34033` / `148:34667` (Card / Empty `148:35263`) / `148:35298` (Loading `148:35302`, Error `148:35336`, No results `148:35352`, Banners `148:35364`) | |
| Mobile (page 2:5): Today / Orders / Order detail / Create order / More / Products | `31:4281` / `31:4886` / `32:309` / `32:6124` / `32:6541` / `139:1077` | Components section `30:3010`: StatusBar `30:3012`, MobileTabBar `30:3170` (Today `30:3022`, Orders `30:3059`, Products `30:3096`, More `30:3133`), OrderCard `30:3171`, MenuRow `30:3202`, ProductCard `139:1065`. No mobile frames for editor, categories, inventory, customers, import |
| Onboarding 05 Add first products | `50:312` | **No mobile frame**: `54:941` (listed as M5) is the mobile "You're live" screen (Phase 5.13) |

## Phase 5 — commerce (PHASE-5-CONTRACT §5, §9, §11)
Frame names and scope as cited in the contract. 5a = built now; "Deferred" frames are recorded, not built.

### Storefront (theme "Gallery"; desktop page 1:9207, mobile page 2:6) — contract §5
| Route | Desktop | Mobile | Notes |
|---|---|---|---|
| PDP `/products/[slug]` | `1:11034` | `1:11250` | Mobile "Product + order form" `16:2` deferred |
| PLP `/c/[slug]` | `1:10821` | `1:10946` | Filters: price + in stock only |
| Search `/search?q=` | `1:12443` | — | Same grid as PLP |
| Cart `/cart` | `1:11378` | `1:11506` / `31:6473` | |
| Checkout `/checkout` | `1:11591` | `1:11690` / `32:5087` | COD only in 5a |
| Thank-you `/checkout/thank-you` (Order confirmed) | `1:11788` | `33:5751` (Order placed) | |
| Track order `/track` | `1:11959` | `33:5864` | Number + phone |
| Header/footer (cart badge, Track order link, Pay with) | chrome `1:10644` | | |
| Deferred | Flash sale page `1:12628`, Landing page COD offer `149:1009`, Product + order form `16:2` | | §11 |

### Merchant dashboard (file `2W1wMKN79hhcr1czQS63oN`) — contract §9
States everywhere: Loading `148:35302`, Error `148:35336`, No results `148:35352`; empty Orders `148:34033`.
| Screen / route | Frame | Notes |
|---|---|---|
| Orders `/orders` | `7:276` (section `41:12363`) | Status tabs, filters, table, bulk bar |
| Order detail `/orders/:id` | `33:3676` | |
| Cancel order dialog | `41:9687` | |
| Edit order `/orders/:id/edit` | `144:46654` | Contact + address + note only; "Edit items" is 5b |
| Create order `/orders/new` | `39:14382` | |
| Customers / Customer detail (orders table, counts) | `63:14972` / `64:16382` | Also listed under Phase 4 |
| Coupons `/marketing/coupons` ("Discounts & coupons") | `67:18689` | Section Marketing `61:12479` |
| Create / edit coupon | `68:19255` | |
| Settings → Shipping & delivery `/settings/shipping` | `60:14364` | Zones, free delivery, pickup addresses |
| Settings → Shipping · Edit zone drawer | `66:17755` | Area picker |
| Settings → Payments & checkout `/settings/payments` | `60:14865` | COD toggle only; others "Coming soon" |
| Settings → Notifications `/settings/notifications` | `60:15863` | New-order email + customer SMS toggles, language |
| Settings → Taxes & invoices `/settings/invoices` | `60:16858` | Invoice numbering (order prefix) only |
| Onboarding 06 Delivery `/onboarding/delivery` | `50:604`; connect courier card `45:8086` | Courier connect disabled (5b) |
| Onboarding 07 Get paid `/onboarding/payments` | `52:564` | COD only; gateways disabled (5b) |
| Onboarding 08 You're live `/onboarding/live` | desktop `52:765`, mobile `54:941` | |
| Dashboard `/` (orders widgets) | `10:600`, mobile `31:4281`; KPI tiles `13:964`, Needs you today `10:958`, Orders waiting `10:1115`, Best sellers `10:1168` | Range toggle, Sales chart `10:890`, Orders by source `10:1024`, Courier performance `10:1061`, Money flow `10:1085` deferred |
| Mobile (page 2:5) | Orders `31:4886`, Order detail `32:309`, Create order `32:6124`, OrderCard `30:3171`, tab bar Orders `30:3059` | |

### Deferred Phase 5 frames (contract §11)
5a record. What Phase 5b built from these frames, and what stays deferred, is in "Phase 5b" below.
| Area | Frames | Goes to |
|---|---|---|
| Orders | Request advance payment `144:46081`, Bulk book courier `39:18808`, Unfinished orders `39:9461`, Returns & exchanges `39:9900`, Return detail `146:32329` | 5b / Phase 8 |
| Shipments & printing | Shipments `39:10347`, Shipment detail `146:33100`, Invoices & labels `39:10790`, templates `44:16156` (A4 `42:11175`, 80 mm `42:12238`, A5 `42:13193`, packing slip `44:12097`, Pathao `44:13094`, RedX `44:14203`, Steadfast `137:30097`), Fake order guard `39:11233` | 5b / Phase 8 |
| Integrations | List `14:980`, Connect bKash `32:3770`, Steadfast disconnect `32:4182`, courier detail tabs `22:1181`, `29:1814`, `29:2562`, `31:2231`, `31:2905`, `31:3581`, Pathao `152:34534` | 5b / Phase 8 |
| Marketing | Overview `66:19179`, SMS & WhatsApp campaigns `70:19774` → **Phase 8.5 (see below)**; Abandoned cart recovery `71:20614` → **Phase 8.6 (see below)** | 8.5 / 8.6 |
| Settings | Policies & legal pages extras `87:25694` | Later |

## Phase 5b — online money, couriers, documents, order changes (PHASE-5B-CONTRACT §10, §11, §14)
Frames as cited in the contract and in the app code comments (`apps/merchant-dashboard/src`, `apps/storefront`).
**Built** = shipped in 5b (fake gateway/courier drivers; real providers pending sandbox certification). **Partly** =
the frame is used but some of its elements are deferred. **Deferred** = recorded, not built (contract §14). States
everywhere: Loading `148:35302`, Error `148:35336`, No results `148:35352`.

### Merchant dashboard
| Screen / route | Frame(s) | Status | Not built (→ where) |
|---|---|---|---|
| Integrations `/integrations` (section `32:5329`) | `14:980` | **Built** (5b-2/5b-3): chips All / Connected / Couriers / Payments; Steadfast, Pathao, RedX, bKash, SSLCommerz cards | Paperfly, CarryBee, Nagad, EPS, aamarPay, PayStation, Marketing & tracking, Messaging, AI, Developer banner: hidden (later 5.x drivers, Phase 7/8) |
| Connect gateway wizard (dialog) | `32:3770` (wizard frame `32:4105`) | **Built** (5b-2): 4-step rail, Sandbox/Live, test payment, go live | Setup guide link |
| Courier connect + manage (section `32:5330`) | Overview `22:1181`, Status webhook `31:2905`, Pathao `152:34534`; wizard frame `32:4105` | **Partly** (5b-3). Built **as a dialog** on the wizard frame, not as the `/integrations/couriers/:provider` page of §10: Connection card (masked keys, Edit keys, Test connection, Disconnect), Booking rules (Pickup from, Cash to collect = due, parcel description, default weight; Pathao store / delivery type / item type; RedX pickup store), webhook URL + Bearer/secret with Rotate (shown once) | Recent shipments, "This month" column, webhook event log and 24 h counts, status-mapping table (not in 5b); Book automatically / Print label after booking `29:1814` (Q62, Phase 8); Fraud check `29:2562` (Phase 8, Q23); COD & payouts `31:2231` (Q49, Phase 7); Activity log `31:3581`; Connection health; Send test event; Steadfast disconnect frame `32:4182` not referenced |
| Shipments `/shipments` (section `41:12365`) | `39:10347` | **Built** (5b-3): Sync now, Book parcels, KPI tiles incl. COD held by couriers, Needs attention (Call customer), courier chips, filters, table, bulk Print labels / manifest CSV | Reschedule, Request return, View payouts |
| Bulk book courier | `39:18808` | **Built** (5b-3): bulk dialog (≤ 500) and the single-order "Book with {courier}" variant | — |
| Shipment detail `/shipments/:id` | `146:33100` | **Built** (5b-3): stepper, tracking timeline + Refresh, parcel and COD cards, Print label, Open in courier, Cancel / Mark cancelled | Call rider, rider card, risk badge, Change address or COD, Ask to hold (Phase 8) |
| Order detail additions `/orders/:id` | `33:3676` | **Built** (5b-2/3/4/5): courier card (Book with …), Payments card (online charges, links, gateway refund), Invoice button, Create return, Edit items link | Risky banner, Delivery record (Phase 8, Q23) |
| Ask for an advance (dialog) | `144:46081` | **Built** (5b-2): Delivery charge / Part payment % / Full / Custom, gateway, expiry 2 h–48 h, SMS preview, cancel-if-unpaid, Copy link instead; active-link banner | — |
| Edit order · Edit items `/orders/:id/edit` | `144:46654` | **Built** (5b-5): lines, add product (Create order picker `39:14382`), What changes quote, reason, SMS toggle; read-only banner when booked | Scan barcode; courier COD update after booking (Q56) |
| Returns & exchanges `/returns` | `39:9900`, detail panel `146:32329` | **Built** (5b-5): KPI tiles, status tabs, table, side panel (approve/reject/receive with checks + restock, refund, exchange order + difference link, timeline) | Customer photos / shopper-initiated returns (Q57), courier return pickup, Return policy (Phase 8) |
| Invoices & labels `/orders/print` | `39:10790`; templates section `44:16156`: A4 `42:11175`, 80 mm `42:12238`, A5 two-up `42:13193`, packing slip `44:12097`, labels Steadfast `137:30097` / Pathao `44:13094` / RedX `44:14203` | **Built** (5b-4): Not printed / Printed today, template cards, sandboxed preview, print settings, Print N / Download PDF. The three label frames are one `label_4x6` layout whose header shows the shipment's courier | Printer select, Edit templates (free layout), VAT on top (Q52) |
| Settings → Payments & checkout `/settings/payments` | `60:14865` | **Partly** (5b-2): COD, Advance delivery charge (`cod_advance`), full online payment per gateway, connected gateways list | 2 % online discount, advance rules list, WhatsApp link, order form fields, OTP, settlement text (Phase 8) |
| Settings → Taxes & invoices `/settings/invoices` | `60:16858` | **Built** (5b-4): VAT display (none / prices include VAT) + rate, BIN, invoice footer | VAT added on top (Q52) |
| Onboarding 06 Delivery `/onboarding/delivery` | `50:604`, card `45:8086` | **Built** (5b-3): courier Connect opens the courier dialog; Connected ✓ state; copy "Book parcels and track them here" | "COD settled in 48 h" claim not used |
| Onboarding 07 Get paid `/onboarding/payments` | `52:564` | **Built** (5b-2): "Collect delivery charge in advance" toggle, bKash / SSLCommerz Connect → `32:3770`, checkout preview | EPS card hidden |
| Dashboard `/` | `10:600`; Needs you today `10:958`, Orders waiting `10:1115` | **Built** (5b): "Awaiting payment", "N unpaid online orders", "Book N parcels" (`to_book`), "N delivery problems" (`shipments.problems`) | Courier performance `10:1061`, Money flow `10:1085` (Phase 7.4) |
| Mobile (page 2:5) | Orders `31:4886`, Order detail `32:309`, OrderCard `30:3171` | **Built**: cards stacked; Shipments / Returns / Edit items responsive at 390 px (no dedicated mobile frames) | — |
| Deferred, unchanged | Unfinished orders `39:9461`, Fake order guard `39:11233` | **Deferred** (Phase 8) | |
| Developer API keys/webhooks | `144:40725` | Moved to Phase 8.4 (see below) | |

### Storefront (theme "Gallery")
| Route | Frame(s) | Status |
|---|---|---|
| `/checkout` (payment section) | `1:11591`, mobile `1:11690` / `32:5087` | **Built** (5b-2): COD, bKash, "Card or mobile banking" (SSLCommerz), advance delivery charge option |
| `/checkout/payment-result` | reuses thank-you `1:11788` | **Built** (5b-2): paid / pending (polling) / failed with retry and "Pay on delivery instead" |
| `/checkout/thank-you` | `1:11788`, mobile `33:5751` | **Built**: payment status line, retry / switch to COD |
| `/pay/[token]`, `/pay/result` | none in Figma: composed from checkout / thank-you components | **Built** (5b-2), `noindex` |
| `/track` | `1:11959`, mobile `33:5864` | **Built** (5b-3): courier status and times only (no rider data) |

## Phase 8.1 — super admin (page 5:189 "Platform Admin – Desktop"; PHASE-8-1-CONTRACT §7)
1440-wide frames, PlatformSidebar `15:2`. Sections: `26:2330` Overview · `26:2331` Components · `31:6763` Merchants ·
`31:6764` Billing & plans · `49:7263` Sign in · `49:7264` Merchant actions · `49:7265` Revenue & integration health ·
`49:7266` Risk network · `49:7267` Support & announcements · `49:7268` Themes & templates · `49:7269` Team & audit ·
`49:7270` Settings. The page has **no** empty/loading/error states: use `148:34032`.

| Screen | Frame | 8.1 |
|---|---|---|
| Sign in / 2FA | `44:4707` / `44:4784` | Build (no "keep me signed in", no security key, no trust device) |
| Dashboard | `15:123` | Subset: shop counts + "Needs attention" + new merchants; metrics are 8.2 |
| Merchants | `32:5527` | Build without MRR/GMV/orders/health/last-active columns, bulk bar, Export, Add merchant |
| Add merchant | `46:6071` | Not built (Q99) |
| Merchant detail | `33:4851` | Overview, Billing, Domains (composed), Staff, Audit log tabs; Orders, Integrations, Notes hidden |
| Change plan | `45:4989` | Build without "Charge today" (Q95) |
| Suspend | `45:8866` | Build; reactivate + impersonation reason dialogs composed from it |
| Impersonation mode (merchant app) | `44:15709` | Build (banner + amber frame in the merchant dashboard) |
| Billing & subscriptions | `34:859` | Invoice table only (KPIs, retry queue, dunning hidden, Q97) |
| Invoice drawer | `36:1598` | Build without Refund; + Mark paid / Void / Resend menu |
| Settings – Domains & SSL | `45:8156` | Custom domains table only, as its own "Domains" page |
| Team & roles / Invite | `39:12019` / `45:9344` | Build; matrix read-only (Q96), no active sessions |
| Audit log | `39:16118` | Build without hash chain, diff, Export CSV (Q100) |
| Plans & pricing | `35:1193` | Not built (Q98) |
| Components | StatusPill `31:6633`, Checkbox `31:6638`, MerchantRow `31:6639`, InvoiceRow `31:6672`, PlanCard `31:6696`, AuditLogRow `39:16461` | Reuse |
| Later | Revenue `39:12705`, Integration health `39:13048`, Incident `43:12377`, Risk `39:13391` / `43:13011`, Support `39:15432`, Announcements `39:15775`, Themes `39:11676` / `43:11825`, Settings `39:12362`, `45:5681`, `46:6794`, `46:7881`, `47:7183`, `48:7165` | 8.2+ |

## Phase 8.3 — custom roles & permissions (page 2:4, section `89:26676`; PHASE-8-3-CONTRACT §7)
The section has three 1440-wide desktop frames and **no** mobile frames (Q125); states from `148:34032`.

| Screen | Frame | 8.3 |
|---|---|---|
| Staff `/staff` | `60:15363` (Main `60:15365`) | Build: Team table with role names, **Roles** card, editable **Roles & permissions** matrix (rows = permission keys by group). Not built: Online now, Actions today, Staff sign-in security, Add seats |
| Invite staff modal | `90:26504` (modal `90:26879`) | Build role radio list (Manager, Staff, custom roles). Not built: phone/SMS invite (Q121), Warehouse access (Q119), "Permissions for this person" (Q120) |
| Role detail / new role `/staff/roles/:id`, `/staff/roles/new` | `90:26913` (Main `90:26915`) | Build: role details, People with this role + Assign, permission cards with toggles, Sensitive block, Duplicate role, Save role, Unsaved changes bar; + Delete role (composed). Not built: Warehouse access (Q119), "Change price on an order" and "Delete orders" rows (Q115) |

## Phase 8.4 — developer API keys & webhooks (page 2:4, section `144:40725`; PHASE-8-4-CONTRACT §7)
One 1440-wide desktop frame and **no** mobile frames (Q137: cards stack below `lg`, tables scroll inside their card);
states from `148:34032`. Figma prefixes `gs_live_` / `gs_test_` are the old brand: keys are `sp_live_` only (Q127).
Status: **In progress** (8.4 build; defaults Q126–Q137 accepted 2026-11-24).

| Screen | Frame | 8.4 |
|---|---|---|
| Developer `/integrations/developer` | `144:40726` | Build: header "Developer · API & webhooks" + "API docs" (hidden without `DEVELOPER_DOCS_URL`) + "+ Create API key"; plan note `144:41323` ("Growth plan" instead of Figma "Pro plan", Q126; trial variant); API keys card (name/created by, masked key, scope tags, last used, Rename/Revoke); Webhooks card (endpoint + last delivery or "Failing since", event tags, Success · 7 days pill, Edit / Send test event / Disable / Delete; "Events you can send" footer); Signing secret card (reveal, copy, rotate with 24 h overlap); Recent deliveries (last 5) + Log drawer with filters, detail and Resend, "Resend failed (n)"; Build with Storeplix card (API reference, Rate limits). Not built: test-mode keys (Q127), Postman collection row (Q134), docs links when no docs URL is configured |
| Create API key modal (composed) | — (uses `144:40726` tags and form tokens) | Build: name, scope checkboxes grouped read/write (implied read auto-checked, non-grantable disabled with tooltip), Include costs (only with `costs.view`); success step shows the plain key once with Copy + "I've stored it" |
| Add / edit endpoint modal (composed) | — | Build: URL, events checklist with Select all, description |
| Integrations list banner | `32:5329` | Build: "Developer · API & webhooks" card linking to the page, hidden without `developers.manage` |

## Phase 8.5 — marketing campaigns SMS + email (page 2:4, section `61:12479`; PHASE-8-5-CONTRACT §8)
Desktop frames only, **no** mobile frames (Q151: cards stack below `lg`, phone preview moves under the form, tables
scroll inside their card, 375 px usable); states from `148:34032`. WhatsApp has no provider: every WhatsApp element is
hidden and **Email** takes its slot (same components). Status: **In progress** (8.5 build; defaults Q138–Q151 accepted
2026-11-24).

| Screen | Frame | 8.5 |
|---|---|---|
| Marketing overview `/marketing` | `66:19179` (Main `66:19181`) | Build: header + range dropdown (7/30/90 days), "+ Create coupon", "+ New campaign"; tabs Overview · Coupons (n) · Campaigns (n); KPI tiles `39:9401` Revenue from marketing (± %), Orders from campaigns (n % of all orders), Messages sent (composed: "SMS + email, this month: n of allowance"), Unsubscribes (composed); stacked weekly revenue chart, series Coupons + Campaigns (legend "SMS & WhatsApp" → "Campaigns"); Active coupons card; Start something new: Discount coupon, SMS campaign (no price text), **Email campaign** (composed, WhatsApp slot); Recent campaigns table (CHANNEL tag SMS info / Email brand) + "See all n →". **Hidden:** Automations tab (8.6), Carts recovered and Return on spend tiles, Cart recovery series, "Best week yet" banner, Abandoned cart card, WhatsApp broadcast |
| Campaigns list `/marketing/campaigns` | composed from Recent campaigns `66:19809` + Tab `39:9419` | Build: status tabs All / Scheduled / Sending / Sent / Drafts, search, row menu (Edit, Duplicate, Cancel/Unschedule, Delete draft), empty state `148:34032` |
| New / edit campaign `/marketing/campaigns/new`, `/:id/edit` | `70:19774` (Main `70:19776`) | Build: Save draft, Send test to me, Schedule / Send campaign (confirm with recipients + allowance); Channel ChoiceCards SMS + **Email** ("n left"); Audience segment select with params, "Skip Risky customers (n)", "Skip anyone who ordered in the last 7 days (n)", disabled checked "Opted-out customers are never messaged (n)" (was "replied STOP", Q141), "N customers will get this message" + risk split; Message: বাংলা / English chips, Template picker (4 templates, Q150), merge tags, SMS counter/segment bar with greyed prefix + footer, Email subject; When to send (store tz, quiet-hours error); Preview on phone (SMS bubble with "n parts"; email card); **Allowance** card replaces Cost estimate. **Hidden:** WhatsApp card, ৳ rate/total, Top up, "Expected orders", send-time hint (Q148), money-saving text |
| Campaign detail `/marketing/campaigns/:id` | composed (page header + KPI tiles `39:9401` + table) | Build: status pill + channel tag + state actions; tiles Recipients, Sent, Orders, Revenue + caption failed/skipped/unsubscribed; message card; recipients table (needs `customers.view`; masked addresses); polls every 5 s while `sending` |
| Customer detail "Marketing" row | composed in Customers `61:12478` | Build: SMS / Email each Subscribed · Unsubscribed <date> (by customer / by you) · Not eligible · No address; "Stop marketing messages" / "Allow again" (merchant-owned only, `customers.edit`) |
| Storefront unsubscribe `/u/{code}` | composed (theme layout, Gallery tokens) | Build: store logo/name, "You get {SMS|emails} from {store} at {masked}", Unsubscribe → confirmation + Subscribe again; invalid and test states; `noindex`, no-store; reachable in Coming-soon mode |

## Phase 8.6 — automations + checkout recovery (page 2:4, sections `140:30335` and `61:12479`; PHASE-8-6-CONTRACT §10)
Desktop frames only, **no** mobile frames (Q166: cards stack below `lg`, flow column above the side cards, tables scroll
inside their card, 375 px usable); states from `148:34032`. Only the 5 shipped recipes appear (Q153); WhatsApp,
risky-order holds, courier success rate, click tracking and cost are hidden, never faked (Q164). Status: **In progress**
(8.6 build; defaults Q152–Q166 accepted 2026-11-24).

| Screen | Frame | 8.6 |
|---|---|---|
| Automations `/marketing/automations` | `140:30336` (Main `140:30338`) | Build: header buttons "Run log" (`140:30927`) and "+ New automation" (`140:30929`, scrolls to recipes); KPI tiles `39:9401` Active recipes ("n draft · n total"), Runs this week ("n % succeeded"), **Messages sent** (composed: "this month · n left"), **Carts recovered** (composed: "৳ x · last 30 days"); "Your automations" card `140:30980` (recipe + trigger → action tags `39:4554`, runs · 7 days, last run / "Draft", ON toggle `21:202`, pill `140:30981` "n on", quiet-hours note `140:31117` with the 9 PM – 9 AM / max 2 a day copy); "Recent runs" `140:31122` (last 6, See all → run log); "Start from a recipe" `140:31182` (tiles for recipes with `added=false`, "Use recipe"). Free plan: plan note + See plans, create/enable disabled; "Paused — not in your plan" pill. **Hidden:** Risky orders held and Time saved tiles; recipe tiles Order received SMS, Hold risky COD orders, Auto-book courier, Close COD orders, Ask for a review, Cancel unpaid advance |
| Recipe editor `/marketing/automations/:id` | `141:30622` | Build: header (name, "Automations › Recipe · last edited by …"), "Test with an order", "Save changes" (`141:31215`); flow column `141:31218`: When `141:31219` (read-only trigger, order-channel chips `39:4594` only where allowed), If `141:31289` (condition rows limited to the recipe's list, ≤ 5; hidden when the recipe has none; "Yes" / "Otherwise" connectors), Then `141:31369` (fixed actions with optional-step toggles, SMS preview `141:31307` "SMS · {language} · n part(s)" + "Edit message" with the 8.5 editor at 3 parts), Otherwise ("Nothing happens. The run is logged as skipped."); side: Recipe settings `141:31402` (ON toggle, Name, parameter Fields `39:4614`), Test with an order `141:31433` (subject picker + check/cross results + rendered message), Last 7 days `141:31459`. **Hidden:** Add a step, drag handles, per-step more menus, Messenger / POS chips, Courier success rate, "Match any" |
| Abandoned cart recovery `/marketing/automations/checkout-recovery` | `71:20614` | Build: pill On / Off / Draft, "Send test", "Save changes"; KPI tiles `71:21021` Carts left behind, Recovered, Revenue won back, **Messages sent** (replaces Cost); flow card: trigger row, wait pill (15/30/60/120/180 min), Recovery/Step `71:20588` ×2 (channel icon, toggle, message box with first product photo + sample, Sent · Recovered · Revenue), "Wait {hours} hours · only if still no order", coupon select, "Stop when an order is placed", exit row; side: Recent carts `71:21183` (60 s poll; pills Recovered / Waiting · step n / SMS sent / Email sent / Skipped · reason / Opted out), Recovered per day (14 bars), Rules (Skip risky toggle, Quiet hours shown on + disabled, One coupon per phone read-only/hint). **Hidden:** Clicked column, Add a step, WhatsApp channel, Cost tile |
| Run log `/marketing/automations/runs` | composed (page header + filters + table, states `148:34032`) | Build: automation filter, status chips All / Completed / Waiting / Skipped / Stopped / Failed; columns time, automation, subject, contact (masked), outcome pill + reason, steps summary; row expands to steps; cursor "Load more" |
| Marketing overview additions | `66:19179` | Build (unhidden from 8.5): Automations tab (count of `on`), Carts recovered tile, Cart recovery chart series, Abandoned cart recovery quick-create card. Still hidden: Return on spend, Best week yet, WhatsApp broadcast |
| Storefront checkout notice | composed under the phone field (Caption/12, muted) | Build: en "If you don't finish, we may text you a reminder. You can opt out any time." / bn "অর্ডার শেষ না করলে আমরা একটি রিমাইন্ডার SMS পাঠাতে পারি। যেকোনো সময় বন্ধ করতে পারবেন।" |
| Storefront `/r/{code}` | — (route handler, no UI) | Build: 303 to `/checkout` (or `/cart` when a line has an issue) with a restored copy of the cart; invalid → 303 `/` |
| Nav | Marketing children | Build: **Automations** after Campaigns (`marketing.manage`, else Forbidden state) |
