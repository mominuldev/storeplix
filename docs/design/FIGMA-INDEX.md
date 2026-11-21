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
