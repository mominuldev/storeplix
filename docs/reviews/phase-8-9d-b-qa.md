# QA gate: Phase 8.9d part B (Nagad, AI credits, Claude writer, AI photos)

Date: 2026-11-28 · Branch `feat/phase-8-9d-integrations-b` (API `bff25d9`, WEB/SF `1d01df0`, ADMIN `53e8c70`) ·
Contract PHASE-8-9D §9–§11, §13, §14 (S341–S348), §16 QA (`phase8-9d-b`), §17 AC 5–8. Reviewer: QA. The stack,
commands and environment are the same as in `phase-8-9d-a-qa.md` §1.

**Verdict: FAIL** on one functional defect, P89D-QA-B2: AI product photos cannot be turned on from the dashboard.
**Re-gate: PASS** — B2 and B1 fixed, 21/21 (see "Re-gate after fixes" at the end).

Everything else in §16 part B passes in Chromium:
- Nagad: the order is paid only after the signed, verified return;
- the Claude writer fills the editor without saving and costs exactly 1 credit;
- the exhausted state works in both the UI and the API (402);
- photo apply and undo work;
- the super-admin bonus grant reaches the merchant and is spent from the bonus;
- 390 px has no overflow.

| ID | Severity | Owner | Summary |
|---|---|---|---|
| P89D-QA-B2 | **High** | WEB (or API) | `/integrations/ai-photos` → **Turn on** PUTs `row.defaults`, which include the read-only `keep_originals_days: 30`. The API answers 422 `validation_failed` ("This setting does not exist or cannot be changed."), so no merchant can turn AI photos on from the UI |
| P89D-QA-B1 | Low | WEB | The product editor shows the "Unsaved changes" bar right after loading a product whose description is empty (null). A product with a description loads clean. Answers the WEB question: **yes, in a real browser too, but only for empty descriptions** |

## 0. Defects

### P89D-QA-B2 (High): AI photos "Turn on" always fails
- WEB `src/integrations/AiToolPage.tsx` l. 127–129: `turnOn.mutate({ settings: (data.settings ?? data.defaults) … })`.
- API `app/Domain/Integrations/Settings/AiPhotosSettings.php` l. 12–21: `defaults()` returns `keep_originals_days`, but `writable()` is only `default_background`. The types (`AiPhotosSettings.keep_originals_days` "read-only") agree with the API.
- The Vitest for Turn on covers only `ai_writer`, whose defaults are all writable.
- **Repro:** sign in on a Starter shop with AI photos off, open `/integrations/ai-photos` and click **Turn on**. The PUT body is `{"settings":{"default_background":"studio_white","keep_originals_days":30}}` and the response is 422 with `details["settings.keep_originals_days"]`.
- The same applies to turning it back on after Turn off, because `data.settings` still carries the key.
- **Fix (either side):** WEB sends only writable keys (`{ default_background }`); or the API ignores read-only keys that equal their fixed value.
- **Spec:** `phase8-9d-b.ai` › "P89D-QA-B2 …" is `test.fail()`. The photo flow itself turns photos on through the API with writable keys only.

### P89D-QA-B1 (Low): "Unsaved changes" right after load (null description)
- `src/products/ProductEditorPage.tsx` l. 333: `RichTextEditor value={field.value}`.
- `src/online-store/richtext/RichTextEditor.tsx` l. 23 sets `lastEmitted = JSON.stringify(null)` and the editor content is `emptyDoc()`. The first `update` from tiptap (likely `setEditable` in the l. 58–60 effect, which emits by default) then sends the empty doc through `onChange` and dirties `description`. The bar says "1 section changed".
- **Repro:** create a product through the API without a description and open `/products/{id}`. The bar shows at once. A product created with a description shows no bar (both cases are measured in the spec).
- **Fix:** seed `lastEmitted` with the normalized empty doc when `value` is null, or `setEditable(…, false)`.
- This is probably older than 8.9d (shared editor). An A/B against main was not possible, because QA ran no git commands. **Spec:** "P89D-QA-B1 …" is `test.fail()`.

## 1. What ran

| Check | Result |
|---|---|
| `pnpm exec playwright test specs/phase8-9d-b.nagad.spec.ts` | **3/3** |
| `pnpm exec playwright test specs/phase8-9d-b.ai.spec.ts` | **6/6** (4 passed + 2 expected failures, B1 and B2) |
| `pnpm exec playwright test specs/phase8-9d-b.visual.spec.ts` | **2/2** (1280, 390) |
| `pnpm exec playwright test phase8-9d-` (A + B together, final run, after the sqlite IMMEDIATE fix and a worker restart) | **21/21** (18 + 3 expected failures), **0 flaky** |
| Pest sqlite `--group=nagad` / `--group=ai` | 16/16 · 36 (35 passed, 1 skipped) |

Flake: one `phase8-9d-b.ai` run timed out in `beforeAll` (240 s) while a Pest run was using the CPU at the same time. It passed on re-run and in the combined run, so it is recorded as a flake.

Not run: Postgres, RLS and the races (S343 "20 parallel → 10 charged"). The CI steps for the five groups are added to `ci.yml` (sqlite + Postgres).

## 2. Acceptance criteria (part B)

| # | Evidence (Playwright) | Result |
|---|---|---|
| 5 Nagad | **Page:** a short merchant number or a public key in the private-key field gives client errors and no PUT; the API returns 422 for the wrong key kind. A 2048-bit pair made by the spec saves and connects. The page shows `••••4225` and **Replace Merchant private key**, with no Show and no `BEGIN` anywhere. Pre-authorise, Agreement checkout and Remember number are disabled with "Not offered by Nagad yet" (×3), plus "Refund in the Nagad portal…". "Pay with Nagad wallet" is on. No key fragments appear in the gateways list. **Rule 8 (S342):** checkout `payment_method: nagad` gives a redirect. After the outcome POST alone the order is `unpaid`. A tampered `signature` on the return leaves it `unpaid`. The signed return makes it `confirmed`/`paid`, with one `nagad` charge `succeeded`. A replay adds no second charge. A `fail` outcome leaves it `pending_payment`/`unpaid`. **Storefront:** a Nagad radio, "Pay ৳ N with Nagad", the fake page, Pay, then "Paid ৳ …" and the order `nagad`/`paid` | Met |
| 6 AI | **Writer:** Off means no button. Turn on PUTs and the page shows Overview. "Write with AI" → key points + Formal → **202** with `Idempotency-Key` and `{product_id, key_points, tone: professional, variants: 2}` → the fake Bangla draft, "Draft 1 of 2", and "Used 1 credit · 299 left this month". Insert below puts the text in the editor and shows "Unsaved changes", with **no** product write. Available goes 300 → 299, and the ledger has one `consume` −1 `allowance`. **Photos:** Edit with AI → Mint → "Edit photo · 2 credits" → 202 `{media_id, product_id, replace_background, mint}` → Edited and Original images. The product is unchanged until **Save to product**, which replaces the image in place (one image). **Undo** brings the original back and the generation is `undone`. −2 credits, charged once. **Exhausted:** a Free shop spends its 20 credits and the panel shows "…have 0 left. Your credits reset on …" with Write drafts disabled. The API returns 402 `ai_credits_exhausted` `{needed:1, available:0, resets_at}` = 00:00 Dhaka on the 1st. **Admin:** the merchant Billing tab → AI credits → Adjust AI credits → grant 100 (+100 preview) + Promotion → Apply. Admin and merchant both see bonus 100, the merchant ledger has +100, and the Claude page shows 100. The next draft is paid from `bonus` (99 left) | Met **except B2** (photos can't be turned on in the UI) |
| 7 Screens 390 px | `phase8-9d-b.visual` at 1280 and 390: Integrations list (Payments, Marketing & tracking, Sales channels, AI for growth), Meta pixel Overview + Event log, Claude, Nagad, Facebook catalog connect. No page overflow, no console errors | Met (notes below) |
| 8 Suites | Playwright green except the three tracked `test.fail`s; Pest groups green on sqlite | Not met until B2 is fixed |

## 3. Visual / Figma notes (390 px, `tests/e2e/test-results/phase8-9d-visual/390/`)
- **Integrations list** (`2136:1866`): Nagad sits in Payments with its logo. The AI for growth group shows "Claude by Anthropic · On" (the card body repeats "On" as its summary line; minor) and "AI product photos · Off · Turn on", which leads to B2. The developer card sits at the bottom. Single column, no overflow.
- **Claude page** (`2135:55626`): the header stacks (Try it / Turn off), and the Try-it panel and the credits card ("1,500 of 1,500 left this month", allowance, bonus "never expire", costs 1 / 2) read well.
- **Nagad page** (`2134:67228`): the Sandbox/Live toggle sits beside the title. The greyed options match §18. The "Onboarding papers" copy says "the callback URL above", but the callback URL appears only once Nagad is connected, so a not-connected shop has nothing "above". Low copy note for the PO.
- **Meta pixel** at 390: the events table is cut at the right edge inside its card (see the A report).
- **Storefront** Nagad payment result at 390: `nagad-paid-390.png` in the spec output.

## Re-gate after fixes (2026-11-28, main session)

**Verdict after fixes: PASS.**

| ID | Status | Fix |
|---|---|---|
| P89D-QA-B2 | **Fixed** | Turn on sends only writable settings (`writableAiSettings` drops `keep_originals_days`); Vitest covers first Turn on and Turn on after Turn off (both fail without the fix). |
| P89D-QA-B1 | **Fixed** (pre-existing, shared editor) | `RichTextEditor` calls `setEditable(…, false)`: TipTap's `setEditable` emits `update` by default, so a null description came back as an empty doc and marked the form dirty on load. New `RichTextEditor.test.tsx` (fails without the fix). |

Re-run on the fixed branch: `cd tests/e2e && pnpm exec playwright test phase8-9d-` → **21 passed**, 0 failed, 0 flaky,
no `test.fail` left (API under `composer dev` with the fake flags — now including `queue-tracking`, `queue-feeds`,
`queue-ai` — and the sqlite `IMMEDIATE` transaction fix: no "database is locked" in the API log). Merchant dashboard
Vitest 848/848 on an idle machine; API suite 1,736 passed / 0 failed / 101 skipped.
