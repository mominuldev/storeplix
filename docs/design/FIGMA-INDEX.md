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
