# QA gate: Phase 8.9d part A (tracking pixels + server events, product feeds)

Date: 2026-11-28 · Branch `feat/phase-8-9d-integrations-b` (contains part A from main and part B) · Contract
PHASE-8-9D §4–§8, §13, §14 (S330–S340, S349), §16 QA (`phase8-9d-a`), §17 AC 1–4, 7, 8. Reviewer: QA.

**Verdict: PASS, with three findings that don't block it** (A1–A3 fixed since; new A4 open — see "Re-gate after fixes" at the end). Everything §16 asks for on part A works end to end in Chromium on the fakes:
- the pasted pixel code is refused, then the bare ID connects;
- the storefront renders the Storeplix base tag;
- one confirmed order gives exactly one delivered server `purchase`, shown once in the Event log;
- the signed test-mode link and cookie work;
- the GA4 secret is write-only with **Replace**;
- GTM blocks the URLs it should;
- feeds go through fake OAuth, then items, then an issue, then Needs attention, then a typed disconnect.

None of the findings changes what a merchant or a shopper sees in production. A2 and A3 stop the documented local and CI walk-through from working without help: the spec works around A2, and the e2e workflow now works around A3.

| ID | Severity | Owner | Summary |
|---|---|---|---|
| P89D-QA-A1 | Low | API + WEB | The API sends 422 `details.field` as `settings.pixel_id` / `credentials.access_token`, but the pixel form compares against the bare key (`pixel_id`). Server-side ID errors show up as a general alert instead of under the field |
| P89D-QA-A2 | Medium | WEB | "Continue with Facebook/Google" only follows `https://` authorize URLs. The fake driver's URL is the local `http://` API callback, so the click stops with the toast "We couldn’t open the sign-in page" in local and CI |
| P89D-QA-A3 | Medium | API / infra | Nothing works the `tracking`, `feeds` and `ai` queues: not `composer dev` (`AppServiceProvider` l. 141–158), not `docker-compose.yml`, and there is no Horizon config. Locally, purchases are never delivered, feeds never sync and AI jobs never run |

## 0. Defects

### P89D-QA-A1 (Low): `details.field` prefix mismatch
- API: `app/Domain/Integrations/Settings/ProviderSettings.php` l. 107, 116, 123, 128 (`"settings.{$key}"`) and `IntegrationService.php` l. 340, 412, 414 (`credentials.{$key}`).
- WEB: `src/integrations/integrations.ts` l. 523 `errorField()` returns the raw value. `PixelPage.tsx` l. 217–219 then compares it with `ID_KEY[provider]` / `secret.key` / `'test_event_code'`.
- The Vitest mock (`phase8-9d.test.tsx` l. 179) uses `{ field: 'pixel_id' }`, so the mismatch is invisible there.
- **Repro (API):** `PUT /stores/{s}/integrations/meta_pixel` with `settings.pixel_id` = a Meta base-code snippet gives `422 integration_code_pasted`, `details.field = "settings.pixel_id"` (asserted in `phase8-9d-a.pixels`).
- In the UI, the client-side checks catch the common cases first. Only server-only refusals (for example a token the provider rejects) hit this, and the message still shows, just not on the field.
- **Fix:** strip a `settings.` / `credentials.` prefix in `errorField()`, or have the API send bare keys. Add a Vitest case with the real shape.

### P89D-QA-A2 (Medium): fake OAuth cannot be walked by clicking
- `src/integrations/integrations.ts` l. 465–467 `isSafeAuthorizeUrl` accepts only `https:`, and `FeedPage.tsx` l. 250 then toasts.
- `FakeFeedDriver::authorizeUrl` returns `{APP_URL}/api/v1/integrations/oauth/{provider}/callback?code=fake-code&state=…`, which is `http://localhost:8010` locally and in CI.
- **Repro:** run a Starter shop with `FEEDS_FAKE=true`, open `/integrations/meta-catalog` and click **Continue with Facebook**. The `oauth/start` call returns 200 and the page stays put with the error toast.
- **Fix:** also allow the API's own origin in non-production builds.
- **Spec:** the main flow `page.goto`s the returned URL, which is exactly the navigation the button would make. A separate test, `P89D-QA-A2 …`, is marked `test.fail()` and will flag the fix.

### P89D-QA-A3 (Medium): no workers for the 8.9d queues
- Contract §12 says the `tracking`, `feeds` and `ai` queues are "added to Horizon config". No `config/horizon.php` exists.
- `composer dev` starts `default,media`, `bulk`, `notifications`, `documents`, `domains`, `billing`, `webhooks-out`, `campaigns` and `automations`.
- Compose has no `queue-tracking`, `queue-feeds` or `queue-ai`.
- **Effect:** `DeliverTrackingEvent`, `SyncCatalog` and the AI jobs sit in `jobs` forever on a dev or compose stack.
- **QA change:** `.github/workflows/e2e.yml` now starts a `queue:work redis --queue=$q` for each of the three queues unless compose defines `queue-$q`, the same fallback as 8.4–8.6. TESTING.md documents the local worker.
- **Fix (API/infra):** add the workers to `AppServiceProvider` (dev) and compose.

## 1. What ran
- Stack:
  - API `php artisan serve --port=8010 --no-reload` (4 workers) with `PAYMENTS_FAKE COURIERS_FAKE DOMAINS_FAKE TRACKING_FAKE FEEDS_FAKE=true AI_DRIVER=fake AI_IMAGE_DRIVER=fake`;
  - one `php artisan queue:work --queue=default,media,notifications,tracking,feeds,ai,bulk,webhooks`;
  - merchant vite :5183 and super-admin :5184 (`VITE_API_PROXY_TARGET=http://localhost:8010`);
  - storefront `next dev` :3010 with `STOREFRONT_API_URL=http://localhost:8010`.
- Dev DB: backed up to the scratchpad first, then `php artisan migrate` (forward only), which applied the pending 8.9a/b, 8.8e, help and 8.9d migrations. No reset and no seed.
- `composer dev` was tried first. Its 12 `queue:listen` workers on sqlite produced "database is locked" 500s, so the leaner stack above was used. Main has since switched sqlite to `IMMEDIATE` transactions. The worker was restarted after that and the final run had no lock errors. Lock failures are not recorded as bugs.

| Check | Result |
|---|---|
| `pnpm exec playwright test specs/phase8-9d-a.pixels.spec.ts` | **7/7** |
| `pnpm exec playwright test specs/phase8-9d-a.feeds.spec.ts` | **3/3** (2 passed + 1 expected failure, A2) |
| `pnpm exec playwright test phase8-9d-` (all of part A + B together, final run) | **21/21** (18 passed + 3 expected failures A2, B1, B2), 2.8 min, **0 flaky** |
| Pest sqlite `php artisan test --group=integrations` / `tracking` / `feeds` (`--exclude-group perf --exclude-group race`) | 77 (76 passed, 1 skipped) · 34 (33 passed, 1 skipped) · 9 (8 passed, 1 skipped) |
| `tests/e2e` `tsc --noEmit` | clean |
| `ci.yml` / `e2e.yml` | parse as YAML |

Flakes seen before the IMMEDIATE fix: `setupShop` 500 "database is locked" (twice), the `sync-runs` GET 500 (once), and the account PUT lost once. All of them passed on re-run.

Not run: Postgres, RLS and the races. The CI steps are added but were not run locally.

## 2. Acceptance criteria (part A)

| # | Evidence (Playwright) | Result |
|---|---|---|
| 1 Opt-in | A Starter shop with nothing connected renders no `script[data-sp-tag]` and no `[data-sp-consent-bar]` | Met (spot check; the byte-identical check is SF Vitest) |
| 2 IDs only | API: snippet gives 422 `integration_code_pasted`, and `<script>` in a TikTok ID gives 422. UI: "This looks like code. Paste only the Pixel ID" with **no PUT**. ID + token + `TEST48211` connects, and the token never appears in any response or the page (hint = last 4). The storefront loads only `connect.facebook.net/…` via `data-sp-tag="meta_pixel"` with `fbq('init', '128455670912334')`. GTM: the web container and `https://10.0.0.7` get the form error, with no PUT. The API returns 422 for IP, `169.254.169.254`, `.internal`, `localhost`, `:8443`, `http://` and `gtm.js` | Met |
| 3 One purchase per order | Confirm an order and one server row `purchase.{order}` is `sent`. Ready, ship and deliver add none. The log has no `payload` key. The Event log shows "Order QA-…" once, "Delivered". Test mode: Send test event 200; "Open shop in test mode ↗" gives a `?sp_test=` link on `{slug}.localhost` that expires in about 30 min; the storefront strips the param and sets the httpOnly `sp_track_test` cookie; the test row has `test: true`. GA4: masked "ending XXXX", no Show, **Replace** PUTs `{credentials:{api_secret}}` and the hint changes | Met |
| 4 Feeds | `oauth/start` 200, then the callback **303** to `localhost:5183/integrations/meta_catalog?oauth=success` (the page drops the param and shows "Choose a catalog" / "Finish setup"). Replaying the state gives `oauth=error`. Choosing "Storeplix test catalog" PUTs `{account_id:"100200300"}` and starts a `connect` sync with items; the draft product is not sent. The "Issue" product is `disapproved` with "Image too small (fake)", so the status is `needs_attention` + `items_with_issues` on the detail page, in the Fix all drawer, on the Products tab and on the list card. Disconnect: `confirm:"disconnect"` gives 422 `confirmation_mismatch`, and the dialog stays disabled until `DISCONNECT`. Afterwards the feed is not connected and `catalog_items` = 0 | Met (with A2 worked around) |
| 7 Screens | See the part B report (`phase8-9d-b.visual`) | See B |

## 3. Visual notes (390 px, `tests/e2e/test-results/phase8-9d-visual/390/`)
- **Integrations list** (`2136:1866`): the groups stack in one column and the chips scroll sideways. "Meta Pixel + Conversions API · Connected · Pixel 1284…2334 · CAPI on" reads well. No page overflow.
- **Meta pixel Overview:** the header actions stack. The "Events · last 7 days" table is wider than its card and is cut at the right edge, with the third column only partly visible. The table scrolls inside the card, so this is not page overflow, but there is no scroll hint. Low; for the PO and Figma.
- The fixed bottom tab bar shows mid-page in full-page screenshots. That's an artefact of the screenshot.

## Re-gate after fixes (2026-11-28, main session)

| ID | Status | Fix |
|---|---|---|
| P89D-QA-A1 | **Fixed** | `integrations.ts` `fieldOf` strips the API's `settings.` prefix, so server errors land under the field (unit test). |
| P89D-QA-A2 | **Fixed** | `isSafeAuthorizeUrl` still requires https, except an http URL on a localhost host while the dashboard itself runs on localhost (unit tests incl. production host + foreign host). The feeds spec now clicks through. |
| P89D-QA-A3 | **Fixed** | compose `queue-tracking` (×5, timeout 40), `queue-feeds` (×2, 910), `queue-ai` (×3, 190); `composer dev` gets one listener each. Horizon is not used in this repo. |
| **P89D-QA-A4** | **Fixed** (PO accepted the default: dedicated connection) — queue connection `redis-feeds` (`retry_after` 960 s, `REDIS_FEEDS_RETRY_AFTER`), `SyncCatalog` uses it when `FEEDS_QUEUE_CONNECTION=redis-feeds` (compose), worker `queue:work redis-feeds --queue=feeds`; `FeedsQueueConnectionTest` guards retry_after > the job timeout. Was: | `SyncCatalog::$timeout` is 900 s but `REDIS_QUEUE_RETRY_AFTER` is 360: a sync running past 360 s is re-reserved by another worker (tries=1 → the second copy fails with MaxAttemptsExceeded while the first still runs). Needs a design call: shorter chunked syncs, or a dedicated redis connection with `retry_after` > 900 for `feeds`. |

Re-run on the fixed branch: `cd tests/e2e && pnpm exec playwright test phase8-9d-` → **21 passed**, 0 failed, 0 flaky,
no `test.fail` left (API under `composer dev` with the fake flags — now including `queue-tracking`, `queue-feeds`,
`queue-ai` — and the sqlite `IMMEDIATE` transaction fix: no "database is locked" in the API log). Merchant dashboard
Vitest 848/848 on an idle machine; API suite 1,736 passed / 0 failed / 101 skipped.
