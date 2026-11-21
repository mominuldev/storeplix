# Phase 3 QA Review (Storefront engine)

- Date: 2026-11-21, 23:30–00:00 (+06)
- Branch: `phase-3-storefront-engine`, uncommitted Phase 3 work in the tree (API, WEB, SF).
- Spec: `docs/development/PHASE-3-CONTRACT.md` (§8 Security, §9 Tests, §10 Ownership, §11 Acceptance).
- Live target: the running dev stack: API :8000 (sqlite, `MAIL_MAILER=log`, `SMS_DRIVER=log`) with a queue worker on
  `default,media`, storefront `http://demo.localhost:3000`, merchant :5173.
- Second tenant: "QA Eve" registered through the API, with store `qa-eve-p3`. For browser checks I added a
  `qa-eve-p3.localhost` domain row and set the store active in sqlite. Adversarial content went only into that store.
- Data restored: the QA tenant (Eve) was deleted, along with her store, content, media rows and files. The QA staff
  user, the invitee users and all uploaded media were deleted too, and the staff membership was removed. On the demo
  store, the pages, menus, settings and theme (draft and published) match the pre-run sqlite backup. Revision counters
  are higher than before; the content is identical.
- **Not restored:** the `audit_logs` rows that the run created (19 → 205) are still there. The tool sandbox refused a
  bulk `DELETE` on the audit table. Remove them with `delete from audit_logs where created_at >= '2026-11-21 17:35'`
  if wanted. Also, `tests/e2e/.auth/demo.json` caches one demo Sanctum token, which is git-ignored.

**Verdict: PASS (ship), with one Medium visual/accessibility fix recommended.**

- Every §8 control I attacked held on the live stack: XSS through hrefs and rich text, CSS injection, JSON-LD
  breakout, cross-tenant access, preview scope, draft leakage, framing, staff 403s, 409 conflicts, limits, and
  SEO/robots/sitemap.
- Publish reached the public storefront in **2.4–2.9 s**; the contract target is < 5 s.
- The editor preview updated in **< 2 s**.
- All suites are green, and the new e2e flows pass against the running stack.

- **Critical:** none.
- **High:** none.
- **Medium:** 1. Accent "swing tags" use a hard-coded dark ink, so they are illegible on dark accent colours. The demo
  store is affected.
- **Low:** 7.

## 1. Command results

| Command | Result |
|---|---|
| `php artisan test` | **PASS**: 252 tests, 2645 assertions |
| `php artisan test --group=tenancy` | **PASS**: 51 tests, 426 assertions |
| `php artisan test --group=security` | **PASS**: 118 tests, 842 assertions |
| `vendor/bin/pint --test` | **PASS** |
| `pnpm -r typecheck` | **PASS** |
| `pnpm -r lint` | **PASS**: 0 errors, 22 warnings (ui 10, merchant-dashboard 11, super-admin 1) |
| `pnpm -r test` | **PASS**: 593 tests. themes 125, storefront 245, merchant-dashboard 155, api-client 43, ui 19, super-admin 5, config 1 |
| Theme parity (the new CI `themes` job, run locally) | **PASS**: `diff -r` of the mirror is clean; `@storeplix/themes` 125; storefront `theme.test.ts` 29; PHP `tests/Feature/Themes` + `SafeHrefTest` 93 tests |
| `tests/e2e` (Playwright, Chromium, against the running stack) | **PASS**: 12/12 in 40 s (5 new flow files, 8 new tests) |
| `cd tests/e2e && pnpm exec tsc -p .` | **PASS** |

These counts are identical to the baseline at launch: API 252/51/118, themes 125, storefront 245, merchant 155, api-client 43, ui 19.

## 2. Live security checks (§8)

### Links and rich text: 44 href payloads × 4 sinks

The four sinks are rich-text link marks, page `button.href`, theme `primaryCtaHref` and nav `url`.

| Payload class | Result |
|---|---|
| `javascript:` in mixed case, leading space, `\t`/`\n` inside the scheme, `%6a%61vascript:`, `&#106;`, `&colon;`, `jav&#x09;ascript:`, NBSP/BOM/NUL prefixes, `tel:javascript:` | 422 on all four ✓ |
| `data:text/html,…`, `vbscript:`, `ftp://` | 422 ✓ |
| `//evil.com`, `/\evil.com`, `\\evil.com`, `/%2fevil.com`, `/%5cevil.com`, `https:evil.com`, `https:/evil.com`, `https:///evil.com`, `https://evil.com\@good.com` | 422 ✓ |
| `https://user:pw@x.com`, `https://%65vil.com`, `/%0aevil`, `/%00`, `/ok path`, `\u0001/x` | 422 ✓ |
| `http://` | Allowed in rich text and nav, rejected in buttons and theme ✓ (per contract) |
| `mailto:a@b.com` | Rich text only ✓ |
| `mailto:…?bcc=` | 422 ✓ |
| `tel:+880…` | Rich text and button ✓ |
| `https://wa.me/880…` | All four ✓ |
| Same-site paths that merely contain the text, e.g. `/x#javascript:alert(1)`, `/%6a%61vascript:…` | Accepted. They render as `href="/%6a…"`, which is inert. ✓ |
| Trailing NUL / U+2028 | Stripped by `TrimStrings` before validation (normalised, not stored) ✓ |

Rendered on a published page:
- `<script>alert(1)</script><img onerror>` appears as escaped text.
- External links get `target=_blank rel="noopener noreferrer"`.
- `mailto:`/`tel:` links render.
- There is no `dangerouslySetInnerHTML` anywhere in the storefront (grep).
- Other rich-text checks:
  - A `link` mark with an extra `target` attr → 422.
  - An `{"type":"html"}` node → 422.
  - A `<script>` text node is stored verbatim and rendered as text.

### CSS injection and theme config limits

| Check | Result |
|---|---|
| Colours | `red`, `#fff;}`, `url(x)`, `#ffffff;background:url(//e)`, `#fff` → 422. `#FFFFFF` and `#ffffff\n` are normalised to `#ffffff` ✓ |
| `customBackground` | `red` → 422; `null` with `background: custom` → 422 ✓ |
| Fonts | `Comic Sans` and `Inter;}body{x` → 422 (closed enum) ✓ |
| Values in CSS | Reach CSS only through `themeCssVars` (React style object, re-sanitised hex) ✓ |
| Section and block counts | 31 sections → 422 `config.sections`; a second hero → 422 (maxInstances); a duplicate section id → 422; a 4th hero stat → 422 (maxBlocks) ✓ |
| Rich-text size | Rich-text doc > 10 KB → 422 ✓ |
| Config size | > 64 KB → **413** `payload_too_large`. A Bangla config of 79 KB in UTF-8 is also 413, so the limit counts bytes ✓ |
| Other fields | Unknown settings key, control character in a heading, `paddingTop: 65` → 422 ✓ |
| Theme mismatch | Wrong theme or major version → 422 `theme_mismatch` ✓ |
| Pages | Reserved slugs (`pages`, `admin`, `_next`, `sitemap`), duplicate, uppercase, `a--b` and > 80 chars → 422. 41 blocks or a body > 128 KB → 422. Unknown block key → 422. Control character in a title → 422 ✓ |
| Navigation | Depth 3 → 422 (with the contract path). 21 top-level items or 63 in total → 422. Label of 41 chars → 422. Bad collection handle → 422. Unknown handle → 404 ✓ |

### JSON-LD breakout

The store name was set to `Eve</script><script>alert(1)</script>&"x` and the SEO title/description to
`</script><img onerror>` / `</title><script>`.
- JSON-LD emits `</script>…&`. The `<title>` and meta tags are entity-escaped ✓
- In preview mode no JSON-LD is emitted, and robots is `noindex` ✓

### Cross-tenant (Eve ↔ Demo)

| Check | Result |
|---|---|
| Eve GET/PUT/POST/PATCH/DELETE on Demo's themes, draft/publish/discard/apply, pages, page by id, navigation | 404 on every request ✓ |
| Spoofed `X-Tenant-Id` | 403 `tenant_forbidden` ✓ |
| Demo media id placed in Eve's data: SEO share image; page `image` block; page `og` image; hero `imageMediaId`; `settings.logoOnDarkMediaId`; category `blocks[0].settings.imageMediaId` | 422 for each ✓ |
| Demo `page_id` in Eve's menu | 422 "Choose a page of this shop." ✓ |
| Cross-tenant GET/DELETE media | 404 ✓ |
| Media in use (page body, theme draft) → DELETE | 409 `media_in_use` ✓ |

### Preview token, draft leakage and framing

| Check | Result |
|---|---|
| Draft page | Public 404 `page_not_found`; with a valid token 200. A hidden page behaves the same ✓ |
| Eve's token with the demo host | Public data, `preview:false` ✓ |
| Tampered token | Public ✓. Expiry is enforced in `PreviewTokenService::isValidFor` by HMAC + `e > now` (code review). |
| `X-Storefront-Preview` on a merchant route | Ignored (401 without a Bearer token) ✓ |
| Preview API responses | `Cache-Control: no-store, private` ✓ |
| Draft leakage, theme | Alternating preview-cookie and cookie-less requests (HTML and `RSC: 1`) after a draft save: the draft heading appeared in **0/6** public responses ✓ |
| Draft leakage, pages | A cookie-less request after a preview render → 404 ✓ |
| Token exposure | The token never appears in the preview HTML ✓ |
| `?preview=…&embed=1` | `Set-Cookie sp_preview` and `sp_embed`, both `Secure; HttpOnly; SameSite=none; Partitioned; Max-Age=3600`. 307 to the same path with both params stripped (other params kept) ✓ |
| Non-embed preview | `SameSite=lax`; clears `sp_embed` ✓ |
| Framing headers | Live: `frame-ancestors 'none'` + `X-Frame-Options: DENY`. With `sp_preview`: `frame-ancestors 'self' http://localhost:5173` and no XFO ✓ |
| postMessage, storefront side (code review) | `acceptEditorMessage`: `source === window.parent`, exact origin allowlist, strict Zod. `targetOrigin` = the allowlisted `document.referrer` origin, otherwise no post. Messages carry no token or config ✓ |
| postMessage, dashboard side | `readPreviewMessage`: exact `contentWindow` and origin. `postToPreview` always passes `previewOrigin` ✓ |
| Iframe | `referrerPolicy="origin"` and a sandbox ✓ |
| Bridge tests | Unit tests exist on both sides ✓ |

### Roles and concurrency

| Check | Result |
|---|---|
| Staff writes (invited through the real invite flow): theme draft/publish/discard/apply, page create/patch/delete, nav PUT, settings SEO PATCH | **403 on all 9** ✓ |
| Staff reads: 9 GETs (themes, store themes, theme, pages, page, navigation, page templates, media, settings) | 200 ✓ |
| Staff UI | Every Online store screen shows the read-only banner, with no Publish/Save/New page. The editor has 0 enabled inputs. The only write a staff session makes is `POST preview-token` (read-only) ✓ |
| Stale `base_revision` / `draft_revision` / page `revision` / menu `revision` | 409 `revision_conflict` ✓ |

### SEO

| Check | Result |
|---|---|
| Canonical, home and pages | `http://demo.storeplix.test:3000/…`, the primary host, not the request host `demo.localhost` ✓ |
| Page meta | `og:title` / `og:description` / `og:url` / `og:type=website` / `twitter:card=summary_large_image`; title template `%s · {store}` ✓ |
| Live store | robots allow list + `Disallow: /search` + `Sitemap:` (primary host); the sitemap lists `/` and the published pages with `lastmod` ✓ |
| `hide_from_search` | robots `Disallow: /` within 1 s; empty urlset; `<meta name="robots" content="noindex, nofollow, nocache">` on home and pages ✓ |
| Draft store | Coming soon (200, `no-store`) on `/` and `/pages/about`; robots `Disallow: /`; empty sitemap; `noindex` ✓ |

### Revalidation

| Check | Result |
|---|---|
| Theme publish → public HTML, 3 runs | **2.4 s, 2.9 s, 2.8 s** ✓ (< 5 s) |
| Page publish, nav save, SEO save | Visible in < 3 s (e2e) ✓ |
| Theme draft saves | Never visible publicly ✓ |

### New store (§11.2)

A new store gets:
- an active `modern-commerce` 1.1.0 theme (draft rev 1 = published rev 1)
- About and Contact pages (published) and Privacy, Terms, Delivery & return (draft)
- the menus main (2), footer (1) and help (4)

## 3. Findings

| ID | Sev | Where | Finding | Repro / fix |
|---|---|---|---|---|
| M-1 | **Medium** | `apps/storefront/themes/modern-commerce/sections/hero.tsx:100`, `apps/storefront/themes/modern-commerce/not-found.tsx:15` | The hero swing tag ("New season") and the 404 tag use `bg-accent` with a hard-coded `text-[#0e1a33]`. The demo store's accent is `#0d0d18`, so both render as near-black on black, which is unreadable (WCAG fail). Figma `1:10114` / `1:13588` show readable ink on the accent. | Open `http://demo.localhost:3000/` (hero tag top right) or `/no-such-page`. Fix: `text-on-accent` (the `--sp-on-accent` var already exists in `themes/css-vars.ts`), as `flash-sale.tsx:20` does. Add a contrast test with a dark `secondaryColor`. |
| L-1 | Low | `apps/merchant-dashboard/src/pages/InvitePage.tsx:172` (form schema) | The invite-accept form requires "Mobile number", but `AcceptInvitationRequest` marks `phone` as `sometimes, nullable`. A staff member without a BD mobile can't join through the UI. | `/invite?token=…` → submit without a phone → "Enter your mobile number". Decide which side is right (Addendum A) and align UI and API. |
| L-2 | Low | `apps/storefront/themes/modern-commerce/not-found.tsx` | The 404 differs from Figma `1:13565`/`1:13588`. Missing: the search field, the secondary "Shop new arrivals" CTA, the category chips, and the centred mobile layout. | Visual comparison: `tests/e2e/test-results/visual/mobile-sf_no_such_page_qa.png` vs `test-results/figma/404-mobile.png`. The search can wait for `/search` (Phase 5); the chips and CTA could link to collections now. |
| L-3 | Low | `apps/storefront/themes/modern-commerce/sections/featured-products.tsx` | The category filter chips (All / Clothing / Toys / Food & nutrition / Essentials) in "New arrivals" / "What parents keep coming back for" (Figma `1:10225`, `1:10279`) are not rendered. | Acceptable while products are placeholders. Track for Phase 5. |
| L-4 | Low | `apps/merchant-dashboard/src/online-store/editor/ThemeEditorPage.tsx` (toolbar) | Publish stays enabled with 0 changes. This is harmless because the contract makes publishing idempotent, but every click re-publishes and revalidates. | Open the editor with no draft changes; Publish is active. Consider disabling it when `has_unpublished_changes` is false and nothing is pending. |
| L-5 | Low | `apps/merchant-dashboard/src/online-store/pages/NewPageDialog.tsx:32` | "Also add to Footer menu" defaults to on, and deleting a page leaves its menu item as `page_missing` (per contract). Create/delete cycles pile dead items into the footer (hidden publicly, flagged in the dashboard). My first e2e runs left 6 such items; the spec now restores the menus. | Consider removing a page's menu items on delete, or offering to. |
| L-6 | Low | Media policy (Phase 2 rule) | Staff can still `DELETE /media/{id}` for unused `page_image` media (204), while every other Online store write is O A only. This matches the Phase 2 contract (O A only for logo/favicon), so it is not a violation. | Consider O A for all media deletes now that media feeds the theme and pages. |
| L-7 | Low | Lint | 22 warnings (`react-refresh/only-export-components` and similar): ui 10, merchant 11, super-admin 1. | — |

Notes (not findings):
- **Hydration `caret-color` warning in the preview iframe:**
  - Not reproduced. Headless Chromium had no console errors or warnings on the editor/preview at 1440/834/390 (Playwright captures iframe console messages too).
  - A `caret-color` attribute mismatch is the signature of a browser extension injecting styles before hydration.
  - Judged **environmental (the user's Chrome), not a Phase 3 bug**.
- **Console output during the visual pass:**
  - Next dev warnings asking for `loading="eager"` on the LCP image (`editorial-winter.png` / `cardigan.png` / `elephant.png`). Consider `priority` on the hero image and the 404 photo (helps Lighthouse, acceptance 7).
  - The 404 page's own 404 resource log.
  - Nothing else.
- **Visual pass artefacts:** in a full-page screenshot, the bento "Three worlds" tall tile looks empty. The image is
  `loading="lazy"` and loads on scroll (verified: 700×400 rendered). Not a bug.
- **Mail latency:** one invite mail took about 11 s to reach the log, because the queue worker was busy. The e2e mail
  wait is 30 s.

## 4. Visual pass (Playwright at 1440 / 834 / 390 vs Figma)

Screenshots: `tests/e2e/test-results/visual/` (git-ignored), with Figma references in `tests/e2e/test-results/figma/`.

| Screen | Figma | Result |
|---|---|---|
| Storefront home | `1:10112` | Section order, copy, images, flash sale, category grid, editorial, bento tiles, bestsellers, promises and reviews/club match. Expected differences: wordmark instead of the merchant logo; demo colours; no mega-menu category bar (out of scope); countdown hidden because `endsAt` is null. Mismatches: M-1 (tag ink) and L-3 (filter chips). |
| `/pages/about` | `149:1294`, `74:22532` | Breadcrumb, H1, "Updated …", blocks, callout and the contact aside (Call / WhatsApp) on desktop ✓ |
| 404 | `1:13565` / `1:13588` | Framed elephant photo and copy ✓. M-1 and L-2. |
| Online store Overview | `2028:44401` | Hero card (Live, Gallery theme, Customise/Preview), "part by part" cards ✓. The stats row is omitted as the contract says. |
| Themes, Brand style, Pages, Navigation, SEO | §6 frames | Render at all three widths; tab bar scrolls on mobile. Pages: template chips, table, Built-in "Home" ✓ |
| Theme editor | `2045:48301` | Toolbar (back, theme · page, Saved hh:mm, device toggle, zoom, full screen, undo, Preview, Discard, Publish), section list with locked header/footer rows, "Phone off" pill, + Add section, Content/Design tabs, "Reset to theme", sample-products note ✓. Skipped items (Ask AI, history, Rename, floating toolbar) are hidden as the contract requires. |

## 5. Acceptance criteria (§11)

| # | Criterion | Status |
|---|---|---|
| 1 | Migration to `store_themes`, drop column; `stores:ensure-content` idempotent | ✓ (API tests `StoreContentMigrationTest`; the demo has 5 pages and 3 menus) |
| 2 | New store gets theme, pages, menus | ✓ live (Eve's store) |
| 3 | Edit → preview < 2 s without reload; public unchanged until Publish; < 5 s after; Discard | ✓ e2e `phase3.theme-editor` + live timings. Discard ✓ via API (draft := published, no revalidation). |
| 4 | Reorder/toggle/add/duplicate/delete/Show on persist; device widths; leave-guard | ✓ by reducer/autosave unit tests (WEB). Device widths 1440/834/390 ✓ (`DEVICE_WIDTH`). Not re-driven in e2e. |
| 5 | Two tabs → 409 + reload prompt | ✓ API 409 live. UI dialog covered by WEB unit tests. |
| 6 | Invalid fixture → 422 with a path; storefront never 500s | ✓ parity jobs + live probes |
| 7 | All 10 sections per Figma; placeholders; **Lighthouse mobile ≥ 90** | Partial: rendering ✓ apart from M-1/L-3. **Lighthouse not run in this pass** (dev server; measure on a prod build). |
| 8 | Brand style → draft/publish; logo/favicon/share immediate | ✓ (logo e2e; settings PATCH is immediate) |
| 9 | Pages: templates, publish → `/pages/{slug}` with breadcrumb/SEO; draft/hidden 404; reserved/dup slugs | ✓ e2e + live |
| 10 | Nav in header/drawer/footer; draft/deleted links hidden publicly and flagged | ✓ e2e (header) + live (`page_unpublished`/`page_missing` hidden publicly, kept in preview; nested child rendered) |
| 11 | Canonical = primary host; OG/Twitter; JSON-LD; sitemap; hide → noindex + `Disallow: /`; draft stores noindex | ✓ live + e2e. Rich Results validation not run (offline). |
| 12 | Onboarding 04 applies theme/colour/logo; checklist done | Not re-driven in e2e (WEB unit tests cover the apply flow; `apply` sets `applied_at` per API tests). |
| 13 | Staff read-only, 403 on every write | ✓ live (API and UI) |
| 14 | §8 tests pass; `pnpm -r test`, tenancy/security, parity jobs green | ✓ |

## 6. QA-owned changes in this review

- `docker-compose.yml`: storefront `STOREFRONT_EDITOR_ORIGINS: ${STOREFRONT_EDITOR_ORIGINS:-http://localhost:5173}`.
  `infrastructure/docker/.env.example` documents it.
- `.github/workflows/ci.yml`:
  - New `themes` job, triggered by `packages/themes/**`, `apps/api/resources/themes/**`, `apps/api/app/Domain/Themes/**`, `apps/storefront/themes/**`. Before this, a `packages/themes`-only change skipped the PHP side because the `api` job filters on `apps/api/**`.
  - Steps: a `diff -r` mirror check that can't skip (`ThemeSchemaSyncTest` skips when `packages/themes` is absent), `@storeplix/themes` AJV parity, storefront `theme.test.ts`, and PHP `tests/Feature/Themes` + `SafeHrefTest`.
  - `ci-ok` now includes `themes`.
- `.github/workflows/e2e.yml`: `MAILPIT_URL` and `E2E_ARTISAN=docker` for the flow specs.
- `tests/e2e`:
  - `support/api.ts`: cached login, dashboard sign-in through session storage, storefront polling, mail-link reader for `laravel.log` and Mailpit, and test-user cleanup limited to `@e2e.storeplix.test`.
  - Specs: `phase3.theme-editor`, `phase3.pages-nav-seo` (page, nav, noindex), `phase2.auth-flows` (invite → accept, password reset), `phase2.settings-logo`.
  - `workers: 1`, 60 s timeout, `.gitignore`.
  - `pnpm-lock.yaml` comes from `pnpm install --ignore-workspace`.
- `docs/development/TESTING.md`: the theme parity row and commands, a new §2c on how the e2e flows run (stack, mail, cleanup, the throttle note: wait about 60 s between back-to-back full runs), and catalogue rows T-25…T-31 for Phase 3.
