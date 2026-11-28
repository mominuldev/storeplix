# Phase 8.9c contract: Help center — guides, search, feedback, support tickets (binding for ARCH, API, WEB, ADMIN, QA)

Status: **Accepted, 2026-11-28 — PO (product owner) set the scope and accepted the proposed defaults for Q306–Q323,
Q327–Q329**. Q324–Q326 are defaults in effect (open). Branch `feat/phase-8-9c-help-center` (stacked on
`feat/phase-8-9a-sms` + 8.9b + the 8.8e Inbox contract; rebased on `main` once those merge).
Roadmap task **8.9c** "Help center" (Figma section `71:21271`, help states `2130:965`, mobile `2131:1440` /
`2132:55211`, super admin `2134:10410` / `2134:66712` / `39:15432`; FIGMA-INDEX "Phase 8.9 — Help center").
AC: **"A merchant finds a guide by topic or search in English or বাংলা, reads it (falling back to English with a note),
says whether it helped, and — when it does not — opens a support ticket with an optional related order and files;
platform staff write and publish guides, see their feedback, and answer tickets from one queue with assignment,
internal notes and SLA timestamps; both sides are emailed on replies; nothing changes for a merchant who never opens
Help"** (§17).

Everything in AGENT-CONTRACTS.md, PHASE-2 … PHASE-7 contracts, PHASE-8-1 … PHASE-8-9B and PHASE-8-8E contracts and
docs/api/API-CONVENTIONS.md still applies. PHASE-3 §4.4 (RichTextDoc + `RichTextValidator` + `SafeHref::richText`, the
shared rich-text sanitizer), PHASE-8-1 (platform staff, `platform.can:*`, reasons, `pgsql_admin`, impersonation with
`ticket_ref`), PHASE-8-3 (permission catalogue, ADR 0017), PHASE-8-7 P87-7/8 (private documents, signed 5-minute
links) and PHASE-8-8E P88E-7 (attachment rules) apply in full. **Amends** PHASE-8-1 §2.1 (two new platform permissions,
§2.2), PHASE-8-1 nav (Support tickets and Help articles return to the super-admin sidebar), PHASE-8-3 §2.1 (new key
`support.manage`) and DATABASE-DESIGN §6 (help/support rows replaced by §5.15).
Machine-readable spec: `docs/api/openapi.yaml` **v1.26.0** (tags `help`, `support`, `admin-help`, `admin-support`).
ADR **0029** (new: help content and support tickets). Product defaults: OPEN-QUESTIONS **Q306–Q329**.

### Scope

**One API PR, one WEB PR, one ADMIN PR, one QA gate** (WEB and ADMIN build against the types/client written here).

| Area | Owner | Ships |
|---|---|---|
| **Guides** | API/WEB | Help home, topics, article page (en/bn, fallback note, TOC, related, helpful vote), search (§4–§6) |
| **Help content admin** | API/ADMIN | Article list + editor (draft / publish / schedule / unpublish / archive), categories, platform help images, feedback stats (§7) |
| **Merchant tickets** | API/WEB | New ticket modal, My tickets, ticket thread, replies, files, mark solved, CSAT (§8) |
| **Support queue** | API/ADMIN | `/support` queue, thread with internal notes, assign, status, priority, SLA timestamps, related order card (audited) (§9) |
| **Notifications** | API | Emails to merchant requester and to platform staff (§10) |
| **Docs + types** | ARCH | openapi 1.26.0, `packages/types`, `packages/api-client` (**written**, §15), ADR 0029, DATABASE-DESIGN §5.15, SECURITY T46, MULTI-TENANCY count 106, OPEN-QUESTIONS, roadmap |
| **QA** | QA | `phase8-9c.*`, Pest groups `help`, `support` (§16) |

**Out of scope** (hide, never fake; Q327–Q329): Live chat (`71:23630`, `77:23297`, `77:23376`), Call / WhatsApp /
hotline buttons, system status strip and status page, Video tutorials, "Ask Storeplix AI", What's new (`71:23237`),
plan-targeted articles ("Visible to"), SLA targets and breach alerts (incl. Figma "reply within 30 minutes"), staff
macros, replying to a ticket by email, auto-resolve of silent tickets, the Setup checklist on Help home, Bangla app UI.

### Conventions in this file
- Roles: **O** owner, **A** admin ("Manager"), **S** staff, **C** custom role. "Member" = a signed-in merchant user of
  the tenant. **Staff** (capitalised in §9) = platform staff (`users.platform_role`), never merchant staff.
- **Guide** = help article. One article has an English translation (required to publish) and an optional বাংলা one,
  sharing one slug.
- `[T]` = tenant-owned table (`BelongsToTenant`, RLS `tenant_isolation`). `[P]` = platform table (no RLS, like
  `platform_settings`; app role grants listed per table).
- Ticket reference shown everywhere = `T-{number}` (global sequence from 1001).
- Times: UTC `timestamptz` in the DB, Asia/Dhaka in both UIs. Local runs: api **:8010**, merchant **:5183**, super
  admin **:5184**; `MAIL_MAILER=log|smtp` (Mailpit).

### Standing rules for every agent
- Browser checks: Playwright only. Shared working tree: never `git stash`, `git reset`, `git checkout -- <path>`, never
  commit for another agent. Touch only owned files (§16.1). Re-read shared-read files before each Edit.
- New dependencies: **none** (search uses Postgres FTS + `pg_trgm`, already installed; Markdown ↔ doc conversion in the
  editor reuses the Tiptap stack already in the merchant rich-text editor — ADMIN may add the same Tiptap packages the
  merchant app already pins, same versions, no others).
- Never `migrate:fresh` the local dev DB.
- **No HTML is ever stored or returned for help content**: bodies are `HelpArticleDoc` JSON, validated on write,
  rendered by React components (no `dangerouslySetInnerHTML`).
- **A merchant who never opens Help sees no change**: the only new merchant chrome is the existing sidebar link
  "Help & support" (`86:24820`) turning into a real route. Every existing test stays green except the permission
  catalogue counts and the platform permission matrix.

---

## 0. Summary and goals
Merchants today have no way to learn the product inside it and no channel to Store Plix staff except phone calls.
8.9c adds **Help & support** (`/help`): bilingual guides written by Store Plix staff, browsable by topic and searchable in
English and বাংলা, each with a "Was this helpful?" vote; and **support tickets** that carry the shop automatically, an
optional related order and files. Staff get a **Help articles** editor and a **Support tickets** queue in the super
admin, with assignment, internal notes and first-reply / resolution timestamps. Replies on either side send an email.

## 1. Decisions (with rationale)

| # | Decision | Why |
|---|---|---|
| P89C-1 | **Scope** (Q306): guides (categories, en/bn translations, search, feedback, related) + merchant support tickets + super-admin editor and queue. Live chat, phone/WhatsApp, status page, videos, AI answers, What's new, plan targeting, SLA targets → later (Q327–Q329) | Everything in scope works without staffing hours or third parties |
| P89C-2 | **Languages** (Q307): one article, one shared slug, translations `en` (required to publish) and `bn` (optional). A merchant asks for `language=bn`; when the বাংলা translation is not published the API serves English with `fallback: true` and the page shows "এই লেখাটি এখনো বাংলায় নেই — ইংরেজিতে দেখানো হচ্ছে।" / "Not available in বাংলা yet — showing English." The article language toggle is independent of the app language | Figma `71:21665`, designer assumption "missing Bangla falls back to English with a note" |
| P89C-3 | **Statuses** (Q308): `draft` → `published` ↔ `draft` (unpublish); `draft` → `scheduled` (publish at `scheduled_at`, minute job) → `published`; any → `archived` → `draft` (restore). Only `published` is ever served to merchants; **draft, scheduled and archived all answer 404 `help_article_not_found`** (merchant UI: "This guide was moved or unpublished", `2130:965`). A never-published draft may be deleted | Figma status pills; archived links show the 404 state |
| P89C-4 | **Draft vs live copy**: each translation has editable draft fields and a separate **published snapshot** (title, summary, body, keywords). Editing never changes what merchants read until **Publish changes**; "Unpublished changes" = draft hash ≠ published hash. Scheduling applies to articles that are not yet live; a live article publishes changes immediately | Figma "Unpublished changes" pill; safe editing of live guides |
| P89C-5 | **Body format** (Q309): `HelpArticleDoc` = the PHASE-3 `RichTextDoc` subset (paragraph, heading 2/3, bullet/ordered list, blockquote; bold, italic, underline, strike, link) **plus** two block types: `image` `{media_id, alt (1–200, required), caption?}` and `callout` `{tone: info|warning|tip}` with paragraphs. Validated by `HelpArticleDocValidator` (extends `RichTextValidator`; 200 blocks, 64 KB; links through `SafeHref::richText` plus relative `/help/articles/{slug}`). The editor's Write / Markdown / Preview modes convert in the browser; the API accepts and returns JSON only — never Markdown, HTML, scripts, iframes or embeds | CLAUDE.md rule 7 and the shared sanitizer: content is data, rendered by components |
| P89C-6 | **Images** (Q310): platform-owned help images (`help_media` `[P]`), uploaded only by staff with `manage_help_content`: PNG/JPEG/WebP ≤ 5 MB, MIME sniffed, re-encoded (EXIF stripped), 200–6000 px a side, variants `w640`, `w1024`, `w1600` (webp), stored on the **public** CDN disk under `platform/help/{ulid}/` (never a tenant prefix). The doc references `media_id`; responses resolve them in `media` | Guides are platform content, not tenant media; same pipeline rules as T12 |
| P89C-7 | **Categories** (Q314): staff-managed list (≤ 30): slug, name en/bn, description en/bn (≤ 160), icon from a fixed set (`HELP_CATEGORY_ICONS`), manual order. One category per article. Delete only when it has no articles (409 `help_category_not_empty`). Merchant home shows categories with ≥ 1 published article | Figma topic cards; no free-form icons/SVG |
| P89C-8 | **Search** (Q311): published snapshots only. Postgres: `search_vector tsvector` per translation (`simple` config — no Bengali stemmer exists — weights A title, B keywords, C summary, D body text) + `pg_trgm` similarity on title; query = `websearch_to_tsquery('simple', q)` OR title `%` q; rank = `ts_rank` + 0.5 × similarity. sqlite (tests): case-insensitive `LIKE` over title / keywords / summary / body_text. `q` 2–100 chars; `language` = `both` (default) / `en` / `bn`; one row per matching translation; snippet = plain text ≤ 200 chars around the first hit (the UI bolds query terms itself; **no HTML highlights**). 20 per page, `counts_by_category` | Figma `2130:463`; Bangla and English both searched |
| P89C-9 | **Feedback** (Q312): one vote per **member (user) per article**, changeable and removable (Undo): `PUT /help/articles/{slug}/feedback` `{helpful, language, reason?, note?}`; `reason` (`steps_mismatch`, `hard_to_follow`, `out_of_date`, `not_my_question`) only with `helpful = false`, `note` ≤ 500 plain text. Counters `helpful_yes/no` on the article maintained in the same transaction. Page shows "n sellers found this helpful" (= yes count, hidden under 3) | Figma `71:21665`, `2130:965` |
| P89C-10 | **Related** (Q313): staff pick ≤ 5 (`related_article_ids`, editor aside); unpublished ones skipped; if fewer than 3 remain, filled with the most-viewed published articles of the same category | Figma "Related articles" |
| P89C-11 | **Views and Popular** (Q325, default in effect): an article view is counted at most once per member per article per Dhaka day (platform cache key `help:view:{user}:{article}:{date}`) into `help_article_daily_views`. "Popular this week" = top 8 by views in 7 days (ties: newest); hero chips = the first 4 of them. No search-query logging | No extra personal data; Figma "Popular" without a curated list |
| P89C-12 | **Platform permissions** (Q315): new **`manage_help_content`** (super_admin, support) for every `/admin/help-*` route; new **`manage_support`** (super_admin, support, billing) for every `/admin/support/*` route. read_only gets neither | Support writes guides and answers tickets; billing staff answer billing tickets |
| P89C-13 | **Who files tickets** (Q316): new merchant key **`support.manage`** "Contact Store Plix support" (group `store`, after `developers.manage`, not sensitive, `requires() = []`, grantable; Owner ✓ Admin ✓ **Staff ✗**). Holders see and reply to **all** tickets of the tenant (shared, requester shown). Guides need no key — every member reads them. Without the key, Help shows "Ask your shop owner to contact support" instead of New ticket | Tickets expose shop/order data to the platform: an owner decision; guides are for everyone |
| P89C-14 | **Ticket fields** (Q317): category (`SUPPORT_TICKET_CATEGORIES`), subject 5–150, description 20–5000 (plain text), priority `normal` (default) / `high` / `urgent` (`low` staff-only), optional `order_id` of the tenant's store (needs `orders.view`; else 422 on `order_id`), ≤ 5 attachments, `client_id` (idempotent create). Shop implicit (one store per tenant). Limits: ≤ 20 not-closed tickets per tenant (422 `support_ticket_limit_reached`), limiter `support-ticket-create` 10/h per tenant | Figma `75:23121`; abuse bounds |
| P89C-15 | **Attachments** (Q317): JPG / PNG / PDF ≤ **10 MB** each (Figma), ≤ 5 per message, MIME sniffed, new media purpose **`support_attachment`** (private disk, tenant prefix, images re-encoded / EXIF stripped, no variants, never a library purpose). Staff uploads land in the ticket's tenant media inside `TenantContext::run` (`// cross-tenant: support reply attachment`). Members view through signed 5-minute URLs; staff stream through the admin route. `nosniff`, CSP `sandbox; default-src 'none'`, `no-store`, PDF as attachment. Unattached uploads pruned after 24 h | Same rules as P88E-7 / P87-7/8, Figma's size |
| P89C-16 | **Statuses** (Q318): `open` (new, not yet answered) → staff reply → `awaiting_merchant`; merchant reply → `awaiting_support`; staff may set `awaiting_merchant`, `awaiting_support`, `resolved`, `closed`; merchant may **Mark as solved** (→ `resolved`). A merchant reply on `resolved` **reopens** (→ `awaiting_support`, `reopened` system row, `reopened_count + 1`). `resolved` auto-closes after **7 days** (`support:close-resolved`, hourly, `auto_closed` row). `closed` is final: reply → 409 `support_ticket_closed` ("Open a new ticket"). Merchant tabs: Open = open + awaiting_support · Waiting on you = awaiting_merchant · Solved = resolved + closed | Figma `71:22058`, `71:22844` ("replying to a Solved ticket reopens it") |
| P89C-17 | **CSAT** (Q319): rating card when `resolved` or `closed` and resolved ≤ 14 days ago: 1–5 + optional comment ≤ 500; changeable in that window (409 `support_rating_unavailable` outside it); `rated` system row (staff-visible only). Merchant stats show "Rated x / 5" once ≥ 1 rating exists | Figma rating card and "Rated 4.9 / 5" |
| P89C-18 | **Internal notes and assignment** (Q323): staff messages of kind `note` are never returned by any merchant route, email or export (explicit `kind IN ('merchant','staff','system')` + static test). One assignee, any active staff holding `manage_support` (422 `support_assignee_invalid`); assignment writes a system row and emails the new assignee (not on self-assign). Staff who lose the permission or are disabled are unassigned (system row) | Figma `39:15432` internal notes |
| P89C-19 | **SLA timestamps, no targets** (Q322): `first_staff_reply_at`, `last_staff_reply_at`, `last_merchant_reply_at`, `waiting_since` (set when entering `open` / `awaiting_support`, null otherwise), `resolved_at`, `closed_at`. Derived: first reply time, resolution time, waiting time; merchant stat "Avg. first reply" (90 days); queue sorts by longest waiting. Priority never changes timing rules | PO: "SLA timestamps", targets later |
| P89C-20 | **Related order for staff** (Q321): the merchant shares the order by linking it. While the ticket is not `closed`, staff see a **limited live card**: number, placed_at, status, payment status/method, totals, item count + first item name, courier provider + latest tracking status, customer first name + district (no phone, email or street). Read inside `TenantContext::run` (`// cross-tenant: support ticket related order`), audited `support_ticket.order_viewed` (at most once per staff per ticket per day). Closed tickets show the number only. Anything deeper uses audited impersonation with `ticket_ref = T-{number}` (PHASE-8-1) | Figma "Shared with support" note; least data, every cross-tenant read audited |
| P89C-21 | **Email notifications** (Q320): merchant side — ticket received (requester), staff reply (requester; ≤ 300-char preview, never notes, never attachments), resolved (requester, with rating link), auto-closed (none). If the requester left or lost `support.manage`, mail goes to the tenant owner. Staff side — new ticket and merchant reply → the assignee, else `SUPPORT_TEAM_EMAIL` (`config/support.php`; unset = no staff mail); assignment → new assignee. Default (transactional) mailer, links to the apps, no Reply-To inbox (reply by email later, Q329). No SMS | PO: "thread replies from both sides, with email notifications" |
| P89C-22 | **Retention** (Q324, default in effect): closed tickets are deleted **24 months after `closed_at`** with messages and attachments (`support:prune`, nightly); feedback notes kept with the vote; daily view rows older than 13 months pruned. Tenant deletion cascades | Bounded personal data, enough history |
| P89C-23 | **Publishing rule** (Q326, default in effect): Publish needs a complete English translation (title, summary, body ≥ 1 block); a বাংলা translation that exists must be complete too (else 422 `help_article_incomplete` details `{language, fields}`). Figma's "publish only when English and বাংলা are both filled" switch and "Visible to" select are **not built** ("Missing বাংলা" tab tracks the gap; all merchants see every published guide) | Ship English guides now without blocking on translation |
| P89C-24 | **Plan**: no feature key, no limit — Help and tickets on every plan (Free included) | Support is part of the product |

### 1.1 Product-owner questions (OPEN-QUESTIONS Q306–Q329)
Q306–Q323 and Q327–Q329 **answered 2026-11-28: proposed defaults accepted**; Q324–Q326 defaults in effect (open).

| Q | Question | Proposed default |
|---|---|---|
| Q306 | 8.9c scope | Guides + search + feedback + related; merchant tickets; super-admin editor + queue |
| Q307 | Languages | en + bn sharing one slug; en required; fallback to English with a note |
| Q308 | Article statuses | draft / published / scheduled / archived; only published served; archived 404 |
| Q309 | Article body | Sanitized rich-text JSON (RichTextDoc + image + callout); Markdown only inside the editor; no HTML / scripts / embeds |
| Q310 | Article images | Platform help media (public CDN, re-encoded, staff upload only) |
| Q311 | Search | Postgres FTS (`simple`) + trigram; sqlite LIKE fallback; both languages |
| Q312 | Was this helpful? | One vote per member per article, changeable, reason + note on No |
| Q313 | Related articles | Staff pick ≤ 5, topped up from the same category |
| Q314 | Categories | Staff-managed, en/bn names, fixed icon set, ordered, delete only when empty |
| Q315 | Staff permissions | New `manage_help_content` (SA, support) and `manage_support` (SA, support, billing) |
| Q316 | Who files tickets | New `support.manage` (Owner, Admin); tickets shared within the tenant |
| Q317 | Ticket fields and files | Category, subject, description, priority, optional order (needs `orders.view`); JPG/PNG/PDF ≤ 10 MB × 5, sniffed, private; ≤ 20 open per tenant |
| Q318 | Ticket statuses | open / awaiting merchant / awaiting support / resolved / closed; reply reopens resolved; resolved auto-closes after 7 days; closed is final |
| Q319 | CSAT | 1–5 + comment within 14 days of resolve, changeable |
| Q320 | Notifications | Emails both sides (requester → owner fallback; assignee → `SUPPORT_TEAM_EMAIL`); no SMS |
| Q321 | Staff view of the related order | Limited live card while not closed, cross-tenant read audited; deeper = impersonation with ticket ref |
| Q322 | SLA | Timestamps only (first reply, waiting since, resolved, closed); no targets |
| Q323 | Notes and assignment | Staff-only notes; one assignee holding `manage_support`; assignee emailed |
| Q324 | Ticket retention | Delete 24 months after close — **default in effect** |
| Q325 | Popular this week / hero chips | Top viewed in 7 days; chips = first 4 — **default in effect** |
| Q326 | Publish rule, "Visible to" | English required, বাংলা optional but complete if present; no audience targeting — **default in effect** |
| Q327 | Later: contact channels | Live chat, Call / WhatsApp / hotline, status strip + status page |
| Q328 | Later: content | Video tutorials, AI answers, What's new, plan-targeted articles, Setup checklist on Help |
| Q329 | Later: support ops | SLA targets + breach alerts, macros, reply by email, auto-resolve silent tickets, merchant unread markers |

## 2. Permissions and plan

### 2.1 Merchant (`support.manage`, P89C-13)
`Permission::SupportManage = 'support.manage'`, label "Contact Store Plix support", description "Open and reply to
support tickets for this shop". Route map rows for every §11.1 route (O/A/S parity fixture). Catalogue: **29 grantable
keys + owner-only `billing.manage`**. Guides (`/help/home`, `/help/categories*`, `/help/articles*`, feedback): any
member (`auth:sanctum` + `tenant`, no key). Impersonation: every write (feedback, ticket, reply, rating, upload) → 403
`impersonation_read_only`; attachment links → 403 `impersonation_attachment_hidden` (8.8e code). No external-API scope.

### 2.2 Platform (amends PHASE-8-1 §2.1)
`PlatformPermission::ManageHelpContent = 'manage_help_content'` (super_admin, support) and
`PlatformPermission::ManageSupport = 'manage_support'` (super_admin, support, billing). `PlatformRoleMatrix` and
`AdminPermissionTest` gain both columns. Super-admin nav: **Support tickets** `/support` (`manage_support`, badge =
`open` + `awaiting_support` count) and **Help articles** `/help-articles` (`manage_help_content`) after it.

## 3. Data (owner API; forward-only; migrations prefix `2026_12_14_`)
Platform help tables `[P]`: no `tenant_id`, no RLS; app role grants: **SELECT** on `help_categories`, `help_articles`,
`help_article_translations`, `help_article_redirects`, `help_media`; **SELECT, INSERT, UPDATE, DELETE** on
`help_article_feedback` (own rows by user id in code) and **SELECT, INSERT, UPDATE** on `help_article_daily_views`.
Every staff write runs on the platform connection (`PlatformDb::reroute`). Support tables `[T]` with RLS
(`RlsTables::TENANT` docblock **"106 after Phase 8.9c"**, + 3) and `database/sql/rls-emergency-off.sql` lines.

### 3.1 New tables
- **help_categories** `[P]` (`000100`): id · slug varchar(60) **U** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) · name_en varchar(60)
  · name_bn varchar(60) null · description_en varchar(160) null · description_bn varchar(160) null · icon varchar(16)
  CHECK `IN` `HELP_CATEGORY_ICONS` · position int · created_by / updated_by null FK users SET NULL · revision int default
  1 · timestamps. IX(position).
- **help_media** `[P]` (`000100`): id · disk varchar(16) · path varchar(255) (`platform/help/{id}/…`) · mime varchar(32)
  CHECK `IN ('image/png','image/jpeg','image/webp')` · size_bytes int CHECK `<= 5242880` · width / height int ·
  variants jsonb · status varchar(10) CHECK `IN ('processing','ready','failed')` · alt varchar(200) null ·
  uploaded_by null FK users SET NULL · created_at · updated_at.
- **help_articles** `[P]` (`000200`): id · slug varchar(80) **U** · category_id FK help_categories RESTRICT · status
  varchar(10) CHECK `IN ('draft','published','scheduled','archived')` default draft · scheduled_at null (CHECK
  `status <> 'scheduled' OR scheduled_at IS NOT NULL`) · related_article_ids jsonb default `[]` (≤ 5 ids) ·
  helpful_yes int default 0 · helpful_no int default 0 · first_published_at null · last_published_at null ·
  last_published_by null FK users SET NULL · archived_at null · archived_by null · created_by / updated_by null FK users
  SET NULL · revision int default 1 · timestamps. IX(status, category_id); IX(status, last_published_at DESC).
- **help_article_translations** `[P]` (`000200`): id · article_id FK CASCADE · language char(2) CHECK `IN ('en','bn')` ·
  draft: title varchar(120) · summary varchar(160) · body jsonb (`HelpArticleDoc`) · keywords jsonb (≤ 12 × ≤ 40) ·
  draft_hash char(64) · published snapshot: published_title / published_summary null · published_body jsonb null ·
  published_keywords jsonb null · published_hash char(64) null · published_at null · body_text text null (plain text of
  the published body, for snippets / sqlite search) · word_count int · read_minutes smallint (⌈words / 200⌉, min 1) ·
  `search_vector tsvector` (pgsql only; updated in code on publish: `setweight(to_tsvector('simple', …))` A/B/C/D) ·
  timestamps. **U(article_id, language)**; GIN(search_vector) and GIN(published_title gin_trgm_ops) on pgsql.
- **help_article_redirects** `[P]` (`000200`): slug varchar(80) PK · article_id FK CASCADE · created_at. Written when a
  published article's slug changes; a slug is unique across `help_articles.slug` ∪ redirects (checked in code under
  the platform advisory lock `help-slugs`).
- **help_article_feedback** `[P]` (`000300`): id · article_id FK CASCADE · user_id FK users CASCADE · tenant_id null FK
  tenants SET NULL (context for staff stats, not an RLS owner) · language char(2) · helpful bool · reason varchar(20)
  null CHECK `IN ('steps_mismatch','hard_to_follow','out_of_date','not_my_question')` (CHECK `helpful = false OR reason
  IS NULL`) · note varchar(500) null · timestamps. **U(article_id, user_id)**; IX(article_id, updated_at DESC).
- **help_article_daily_views** `[P]` (`000300`): article_id FK CASCADE · day date · views int · **PK(article_id, day)**;
  IX(day). Upsert `views = views + 1`.
- **support_tickets** `[T]` (`000400`): id · tenant_id · store_id null FK (tenant_id, store_id) → stores SET NULL ·
  number bigint **U** (Postgres sequence `support_ticket_number_seq` START 1001; sqlite: max + 1 inside the
  transaction) · requester_id null FK users SET NULL · category varchar(24) CHECK `IN` §8.1 · subject varchar(150) ·
  priority varchar(8) CHECK `IN ('low','normal','high','urgent')` · status varchar(20) CHECK `IN ('open',
  'awaiting_merchant','awaiting_support','resolved','closed')` default open · order_id null FK (tenant_id, order_id) →
  orders(tenant_id, id) SET NULL (on Postgres the FK nulls only `order_id`: `ON DELETE SET NULL (order_id)`) ·
  order_number varchar(32) null (snapshot) · assignee_id null FK users SET NULL (platform staff) · client_id
  varchar(36) · messages_count int default 0 · last_message_at · last_merchant_reply_at null · first_staff_reply_at
  null · last_staff_reply_at null · waiting_since null · resolved_at null · resolved_by_type varchar(8) null CHECK `IN
  ('merchant','staff')` · closed_at null · reopened_count smallint default 0 · csat_rating smallint null CHECK 1–5 ·
  csat_comment varchar(500) null · csat_rated_at null · revision int default 1 · timestamps.
  **U(tenant_id, client_id)** · IX(tenant_id, status, last_message_at DESC) · IX(status, waiting_since) ·
  IX(assignee_id, status) · IX(closed_at) (prune). Staff queue reads run on `pgsql_admin` (§9).
- **support_ticket_messages** `[T]` (`000500`): id · tenant_id · ticket_id FK (tenant_id, ticket_id) CASCADE · kind
  varchar(8) CHECK `IN ('merchant','staff','note','system')` · author_user_id null FK users SET NULL · body text null
  CHECK `char_length(body) <= 5000` (null only for system) · system_event varchar(20) null CHECK `IN ('created',
  'assigned','unassigned','status_changed','priority_changed','category_changed','reopened','rated','auto_closed')` ·
  system_meta jsonb null · client_id varchar(36) null · created_at. **U(ticket_id, client_id) WHERE client_id IS NOT
  NULL** · IX(tenant_id, ticket_id, id). Immutable.
- **support_ticket_attachments** `[T]` (`000500`): id · tenant_id · ticket_id null FK CASCADE · message_id null FK
  (tenant_id, message_id) → support_ticket_messages CASCADE · media_id **U** FK (tenant_id, media_id) → media RESTRICT ·
  uploaded_by_type varchar(8) CHECK `IN ('merchant','staff')` · uploaded_by_user_id null FK users SET NULL · filename
  varchar(160) · mime varchar(32) CHECK `IN ('image/jpeg','image/png','application/pdf')` · size_bytes int CHECK `<=
  10485760` · created_at. IX(tenant_id, ticket_id). Note attachments are allowed (staff-only like the note).

### 3.2 Changed
- **media** (`000600`): purpose `support_attachment` (`MediaPurpose::SupportAttachment`; jpeg/png/pdf, 10 MB, sides
  [32, 10000], no variants, private, never library; widen the purpose CHECK if one exists).
- **Permission catalogue** (code): `support.manage`. **Platform permissions** (code): `manage_help_content`,
  `manage_support`.

### 3.3 Locking
Ticket writes take the **ticket row `FOR UPDATE`** first (reply, status, assign, rating, priority). Publishing takes the
article row `FOR UPDATE` (platform connection), slug changes additionally the `help-slugs` advisory lock. Feedback
upsert: `INSERT … ON CONFLICT (article_id, user_id) DO UPDATE` and counter deltas in the same transaction under the
article row lock. Scheduled publish job uses `SKIP LOCKED`.

## 4. Help home and categories (owner API/WEB)
- `GET /help/home?language=en|bn` → `HelpHome` `{categories: HelpCategory[] (≥ 1 published article, ordered),
  total_articles, popular: HelpArticleLink[] (≤ 8, P89C-11), can_contact_support: boolean (support.manage)}`. Names
  and titles in the requested language with English fallback per item (`language` on each link).
- `GET /help/categories` → `HelpCategory[]`. `GET /help/categories/{slug}` → `HelpCategoryPage` `{category, articles:
  HelpArticleLink[]}` (published, ordered by title). Unknown / empty → 404 `help_category_not_found`.

## 5. Article (owner API/WEB)
`GET /help/articles/{slug}?language=en|bn` → `HelpArticle`: id, slug, `language` (served), `requested_language`,
`fallback`, `available_languages`, title, summary, `body` (`HelpArticleDoc`), `toc` (`HelpTocEntry[]` from H2/H3,
anchors `{index}-{kebab text}`), `media` (map media_id → `HelpMediaRef` with CDN URLs + `srcset`), category ref,
`read_minutes`, `updated_at` (served translation's `published_at`), `helpful` `{yes_count, my_vote}`, `related`
(P89C-10). A redirected slug answers 200 with `canonical_slug` ≠ request slug (WEB replaces the URL). Not published →
404 `help_article_not_found`. Records a view (P89C-11). Limiter `help-read` 120/min per member.
Feedback: `PUT /help/articles/{slug}/feedback` (P89C-9) → `HelpMyVote`; `DELETE …/feedback` → 204 (Undo). Limiter
`help-feedback` 30/min per member. Not published → 404.

## 6. Search (owner API/WEB)
`GET /help/articles?q=&language=both|en|bn&category={slug}&page=&per_page=` (P89C-8) → `HelpSearchResult[]` +
`HelpSearchMeta` (pagination, `total`, `query`, `counts_by_category`). `q` missing → 422 `validation_failed`. Limiter
`help-search` 60/min per member. Results are ordered by rank, then `last_published_at DESC`.

## 7. Help content admin (owner API/ADMIN; `platform.can:manage_help_content`)

### 7.1 Articles
- `GET /admin/help-articles` — `filter[tab]` `all` (default; excludes archived) | `published` | `draft` | `scheduled` |
  `archived` | `missing_bn` (published or scheduled without a complete বাংলা translation); `filter[q]` (title, slug or
  keyword ≥ 2); `filter[category]` (id); `filter[language]` (`en`|`bn`: has that translation); `sort` `updated`
  (default) | `title` | `helpful` | `views`; page/per_page (25). Rows `AdminHelpArticleSummary`; meta
  `AdminHelpArticleListMeta` (`counts` per tab, `stats` `{published, drafts, missing_bn, helpful_percent_30d}`).
- `POST /admin/help-articles` `{slug, category_id, title_en}` → 201 `AdminHelpArticle` (draft, empty English body).
- `GET /admin/help-articles/{id}` → `AdminHelpArticle` (both translations' draft + published state, media map, related
  refs, `feedback` summary, `views_7d`, `merchant_path`).
- `PATCH /admin/help-articles/{id}` `{revision, slug?, category_id?, related_article_ids?, translations?: {en?, bn?:
  HelpTranslationInput | null}}` — saves **draft** fields only (`bn: null` deletes the বাংলা draft; a published বাংলা
  translation is then removed at the next publish). Autosave from the editor (debounced 2 s). 409 `revision_conflict`,
  409 `help_slug_taken`, 422 `validation_failed` (doc errors keyed `translations.en.body.content.3…`). Slug change on a
  live article creates a redirect.
- `POST …/{id}/publish` `{revision, scheduled_at?: string | null}` — null: copy drafts to the published snapshot, status
  `published`, rebuild search vector / body_text / read time, `last_published_*`; with `scheduled_at` (≥ now + 5 min,
  ≤ 1 year; only when not live, else 409 `invalid_state_transition`) → `scheduled`. 422 `help_article_incomplete`
  (details `{language, fields}`), 422 `help_article_media_missing` (an image id not `ready`).
- `POST …/{id}/unpublish` (published | scheduled → draft; snapshot kept for "last published") · `POST …/{id}/archive`
  `{reason?}` · `POST …/{id}/restore` (archived → draft) · `DELETE …/{id}` (never published only, else 409
  `invalid_state_transition`) → 204.
- `GET …/{id}/feedback?filter[helpful]=0|1&page=` → `AdminHelpFeedbackEntry[]` (reason, note, language, tenant ref,
  dates) for the editor's Feedback panel and stats.
- Job `help:publish-scheduled` (every minute): `scheduled_at ≤ now` → publish as above (actor `system`); a draft that
  became incomplete stays scheduled and raises `help_article.schedule_failed` audit + Sentry warning.

### 7.2 Categories
`GET /admin/help-categories` → `AdminHelpCategory[]` (with `article_counts {published, total}`) · `POST` (201) ·
`PATCH /{id}` (`revision`) · `DELETE /{id}` (409 `help_category_not_empty`) · `POST /admin/help-categories/reorder`
`{ids}` (all ids). 409 `help_category_slug_taken`. Max 30 (422 `help_category_limit_reached`).

### 7.3 Images
`POST /admin/help-media` multipart `file`, `alt?` → 201 `HelpMediaRef` (`status` processing → ready via the existing
media job queue, platform variant). Limiter `help-media-upload` 30/min per staff. Images are never deleted while any
draft or published body references them (nightly `help:prune-media` removes unreferenced images older than 7 days).

## 8. Merchant support tickets (owner API/WEB; `support.manage`)

### 8.1 Constants
Categories `orders_payments`, `shipping_couriers`, `products_inventory`, `storefront_domain`, `billing_plan`,
`sms_marketing`, `account_access`, `bug`, `other` (labels in `SUPPORT_TICKET_CATEGORY_LABELS`). Priorities P89C-14.

### 8.2 Routes
- `GET /help/tickets` — `filter[tab]` `all` (default) | `open` | `waiting_on_you` | `solved`; `filter[q]` (subject or
  `T-1234` / `1234`); page/per_page (20), ordered `last_message_at DESC`. Rows `SupportTicketSummary`; meta
  `SupportTicketListMeta` (`counts` per tab, `stats` `{open, waiting_on_you, solved_this_month, avg_first_reply_seconds
  (90 days), csat_average, csat_count}`).
- `POST /help/tickets` `CreateSupportTicketInput` → 201 `SupportTicket` (P89C-14; replay with the same `client_id` → 200
  stored row). Creates the ticket + first `merchant` message (description) + attachments + `created` system row; emails
  §10; audited `support_ticket.created`.
- `GET /help/tickets/{ticket}` → `SupportTicket` (assignee **first name only**, `related_order` ref; `order_card` only
  when the member has `orders.view`; `files` = all non-note attachments; `can` `{reply, resolve, rate}`).
- `GET /help/tickets/{ticket}/messages` → `SupportTicketMessage[]` (kinds `merchant`, `staff`, `system` only; staff
  author shown as "{first name} · Store Plix"; system rows `created`, `assigned` (as "picked up"), `status_changed`,
  `reopened`, `auto_closed`). Oldest first, all (≤ 500).
- `POST /help/tickets/{ticket}/messages` `{body 1–5000, attachment_ids ≤ 5, client_id}` → 201 (P89C-16 transitions;
  closed → 409 `support_ticket_closed`). Limiter `support-reply` 60/min per member.
- `POST /help/tickets/{ticket}/resolve` → `SupportTicket` (open / awaiting_* → resolved, `resolved_by_type =
  merchant`; resolved → 200 no-op; closed → 409 `support_ticket_closed`).
- `PUT /help/tickets/{ticket}/rating` `{rating 1–5, comment?}` → `SupportTicket` (P89C-17).
- `POST /help/attachments` multipart `file` → 201 `SupportAttachment` (limiter `support-upload` 30/min per member;
  422 `validation_failed` on `file` for type/size). `GET /help/attachments/{attachment}/link` → `SupportAttachmentLink`
  (signed 5-minute URL to public `GET /support-attachments/{attachment}/download`; 409 `support_attachment_processing`;
  never for note attachments → 404).

## 9. Support queue (owner API/ADMIN; `platform.can:manage_support`; never reads `X-Tenant-Id`)
Cross-tenant list and counts read on `pgsql_admin` in `Support\Admin\SupportQueue` (`// cross-tenant: support
queue`); every per-ticket action resolves the ticket there, then runs inside `TenantContext::run($ticket->tenant)`
(`// cross-tenant: support ticket action`).
- `GET /admin/support/tickets` — `filter[status]` (comma list; default `open,awaiting_support`), `filter[assignee]`
  (`me` | `unassigned` | staff id), `filter[priority]`, `filter[category]` (comma lists), `filter[q]` (T-number,
  subject, shop name or owner email ≥ 2), `sort` `waiting` (default: `waiting_since ASC NULLS LAST`) | `newest` |
  `updated` | `priority`; page/per_page (25). Rows `AdminSupportTicketSummary` (tenant + shop + plan, requester,
  assignee, priority, status, waiting_since, first reply seconds, last message). Meta `AdminSupportListMeta` (`counts`
  per status + `mine` + `unassigned`; `stats` `{median_first_reply_seconds_7d, csat_average_30d, csat_count_30d}`).
- `GET /admin/support/tickets/{ticket}` → `AdminSupportTicket` (+ requester name/email, shop context `{tenant id/name,
  store name, primary domain, plan, status}`, `order_card` per P89C-20 (audited), rating, SLA fields, `can`).
- `GET …/{ticket}/messages` → `AdminSupportMessage[]` (all kinds incl. notes; author full name + role).
- `POST …/{ticket}/messages` `{kind: 'reply'|'note', body, attachment_ids ≤ 5, client_id, status?}` → 201. Reply:
  default next status `awaiting_merchant` (`status` may be `awaiting_support` or `resolved` instead); sets
  `first_staff_reply_at` once; emails the merchant (§10). Note: no status change, no email. Limiter `support-staff-reply`
  120/min per staff.
- `POST …/{ticket}/assign` `{assignee_id: string|null, revision?}` (P89C-18) · `POST …/{ticket}/status` `{status,
  revision?}` (staff transitions P89C-16; same status = no-op; `closed` / `resolved` set timestamps) · `PATCH
  …/{ticket}` `{priority?, category?, revision}` — each writes a system row; audited `support_ticket.assigned`,
  `support_ticket.status_changed`.
- `POST …/{ticket}/attachments` multipart `file` → 201 `SupportAttachment` (stored in the ticket tenant's media).
  `GET …/{ticket}/attachments/{attachment}` → stream (headers P89C-15).
- `GET /admin/support/assignees` → `AdminSupportAssignee[]` (active staff with `manage_support`, you first, open
  counts).

## 10. Notifications (owner API; `App\Domain\Support\Mail\*`, queued, `TenantAware` where tenant data is read)
| Mail | To | When |
|---|---|---|
| `SupportTicketReceivedMail` | requester | ticket created ("We got your ticket T-n") |
| `SupportTicketRepliedMail` | requester (→ owner fallback, P89C-21) | staff `reply` (never `note`) |
| `SupportTicketResolvedMail` | requester (→ owner) | status → resolved by staff (rating link) |
| `SupportTicketStaffMail` | assignee, else `SUPPORT_TEAM_EMAIL` | ticket created, merchant reply, reopened |
| `SupportTicketAssignedMail` | new assignee | assigned (not self) |
Bodies: plain text + escaped HTML, subject `[T-n] {subject}`, ≤ 300-char preview, links to `/help/tickets/{id}`
(merchant app URL) or `/support/{id}` (super-admin URL). Never attachments, never notes, never order data.
Coalescing: at most one `SupportTicketRepliedMail` per ticket per 5 minutes (later replies in that window are summed
into the pending job).

## 11. API surface and errors (openapi 1.26.0 binding)

### 11.1 Merchant (`routes/help.php` + include line; `auth:sanctum` + `tenant`; tenant-level, no `{store}`)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/help/home` | member | §4 |
| GET | `/help/categories` · `/help/categories/{slug}` | member | §4 |
| GET | `/help/articles` | member | §6 search |
| GET | `/help/articles/{slug}` | member | §5 |
| PUT · DELETE | `/help/articles/{slug}/feedback` | member | §5 |
| GET · POST | `/help/tickets` | `support.manage` | §8.2, POST 201 |
| GET | `/help/tickets/{ticket}` | `support.manage` | §8.2 |
| GET · POST | `/help/tickets/{ticket}/messages` | `support.manage` | §8.2 |
| POST | `/help/tickets/{ticket}/resolve` | `support.manage` | §8.2 |
| PUT | `/help/tickets/{ticket}/rating` | `support.manage` | §8.2 |
| POST | `/help/attachments` | `support.manage` | §8.2, 201 |
| GET | `/help/attachments/{attachment}/link` | `support.manage` | §8.2 |
| GET | `/support-attachments/{attachment}/download` | signed URL | public route in `api.php` |
No `/stores/{store}/…` routes: the tenant's single store is attached server-side.

### 11.2 Super admin (`routes/admin-help.php`, `routes/admin-support.php`; admin stack)
| Method | Path | Platform permission |
|---|---|---|
| GET · POST | `/admin/help-articles` | `manage_help_content` |
| GET · PATCH · DELETE | `/admin/help-articles/{article}` | `manage_help_content` |
| POST | `/admin/help-articles/{article}/publish` · `/unpublish` · `/archive` · `/restore` | `manage_help_content` |
| GET | `/admin/help-articles/{article}/feedback` | `manage_help_content` |
| GET · POST | `/admin/help-categories` | `manage_help_content` |
| PATCH · DELETE | `/admin/help-categories/{category}` | `manage_help_content` |
| POST | `/admin/help-categories/reorder` | `manage_help_content` |
| POST | `/admin/help-media` | `manage_help_content` |
| GET | `/admin/support/tickets` · `/admin/support/assignees` | `manage_support` |
| GET · PATCH | `/admin/support/tickets/{ticket}` | `manage_support` |
| GET · POST | `/admin/support/tickets/{ticket}/messages` | `manage_support` |
| POST | `/admin/support/tickets/{ticket}/assign` · `/status` · `/attachments` | `manage_support` |
| GET | `/admin/support/tickets/{ticket}/attachments/{attachment}` | `manage_support` |

### 11.3 Error codes (new)
`help_article_not_found` (404), `help_category_not_found` (404), `help_slug_taken` (409), `help_category_slug_taken`
(409), `help_category_not_empty` (409), `help_category_limit_reached` (422), `help_article_incomplete` (422, details
`{language, fields}`), `help_article_media_missing` (422, details `{media_ids}`), `support_ticket_closed` (409),
`support_ticket_limit_reached` (422), `support_rating_unavailable` (409), `support_assignee_invalid` (422),
`support_attachment_processing` (409). Existing: `validation_failed`, `revision_conflict`, `invalid_state_transition`,
`impersonation_read_only`, `impersonation_attachment_hidden`, `rate_limited`, `not_found`.

## 12. Audit and security

### 12.1 Audit actions
`HELP_AUDIT_ACTIONS` (platform actor, `tenantId: false`): `help_article.created`, `help_article.published`,
`help_article.scheduled`, `help_article.unpublished`, `help_article.archived`, `help_article.restored`,
`help_article.deleted`, `help_article.schedule_failed`, `help_category.created`, `help_category.updated`,
`help_category.deleted`. `SUPPORT_AUDIT_ACTIONS` (tenant-scoped rows): `support_ticket.created` (member),
`support_ticket.assigned`, `support_ticket.status_changed`, `support_ticket.order_viewed` (platform, `platform: true`).
Meta never holds message bodies, notes, attachment names or order customer data. Edits of article drafts are not
audited (the editor shows "last changed by").

### 12.2 Security checklist (S248–S261; each has a test)
- **S248** isolation: tickets, messages, attachments of another tenant → 404 on every merchant route; RLS on the three
  support tables; `assertTenantIsolation` for tickets and attachments; `order_id` and `attachment_ids` resolved within
  the tenant (another tenant's → 422 / 404).
- **S249** permissions: route map O/A/S/C for `support.manage` (+ `orders.view` for `order_id` and `order_card`);
  guides readable by every member incl. a custom role with no keys; impersonation 403 on every write and attachment
  link; no API-key route.
- **S250** platform permissions: `/admin/help-*` only `manage_help_content` (SA, support), `/admin/support/*` only
  `manage_support` (SA, support, billing); read_only and merchant tokens → 403 / 401; `AdminPermissionTest` matrix.
- **S251** notes never leave: no merchant route, email, signed link or export returns a `note` row or a note
  attachment (query + static test on `kind` predicates).
- **S252** rich text: `HelpArticleDocValidator` rejects unknown nodes/marks/attrs, `javascript:` / `data:` / protocol-
  relative links, raw HTML strings, images without alt or with unknown / non-ready media ids, > 200 blocks, > 64 KB;
  merchant responses only ever contain validated JSON; WEB/ADMIN render with components (`react/no-danger`).
- **S253** content visibility: draft, scheduled and archived articles and categories without published articles → 404
  for merchants (incl. via search, related, popular, redirects); merchants never see draft fields or feedback of others.
- **S254** help images: staff-only upload, sniffed PNG/JPEG/WebP ≤ 5 MB, re-encoded, SVG rejected, platform prefix
  (never a tenant prefix), `nosniff`.
- **S255** ticket attachments: sniffed JPG/PNG/PDF ≤ 10 MB, ≤ 5 per message, private disk under the tenant prefix,
  re-encoded images, never a library purpose, signed 5-minute member links, admin stream only for that ticket,
  `nosniff` + sandbox CSP + PDF as attachment, orphan prune 24 h.
- **S256** cross-tenant reads: the queue only through `SupportQueue` on `pgsql_admin`; ticket actions inside
  `TenantContext::run`; `order_card` limited fields (no phone/email/street), hidden when closed, audited once per
  staff per ticket per day; arch test allowlists the two `// cross-tenant:` markers.
- **S257** feedback integrity: one row per user per article (unique + upsert race test), counters equal to rows,
  reason only on No, note plain text ≤ 500, limiter; votes only on published articles.
- **S258** search: `q` bound as a parameter (no interpolation into `to_tsquery`; `websearch_to_tsquery` only), length
  2–100, `%`/`_` literal on sqlite, published snapshots only, limiter.
- **S259** ticket workflow: transitions per P89C-16 only (invalid → 409), closed final, idempotent create and reply
  (`client_id`), ≤ 20 open per tenant, limiters, assignee must hold `manage_support` and be active.
- **S260** email safety: no notes, attachments or order data in mails; subjects/bodies escaped; recipient resolution
  never leaves the tenant (owner fallback) or the platform staff list.
- **S261** retention: `support:prune` deletes closed tickets > 24 months with objects after commit;
  `help:prune-media` never removes a referenced image; daily views pruned after 13 months.

## 13. Merchant app (owner WEB) — Figma section `71:21271`
Route `/help` (lazy, `src/help/**`); sidebar "Help & support" (`86:24820`) links to it for every member; mobile More →
Help center. Article language toggle state in the URL (`?lang=bn`), remembered per browser in `localStorage` (try/catch).
- **Home** `71:21272` / mobile `2131:1440`: title + English / বাংলা toggle, hero "Hi {first name}, how can we help
  today?" + search + 4 popular chips (Q325), Browse by topic (Topic card `71:24258`, counts, "All n articles"), Popular
  this week (Article link `71:24265`), **Talk to us** card with only **Email & tickets → New ticket** (or "Ask your shop
  owner…" without `support.manage`); mobile **My tickets** row (counts, "Reply needed" when waiting_on_you > 0) and
  sticky **Contact support**. Not built: status strip, Live chat, Call, WhatsApp, videos, AI, setup checklist.
- **Search** `2130:463` (`/help?q=`): breadcrumb, search bar, Language chips Both / English / বাংলা, "n results for “q”"
  + category chips with counts, Help / Search result rows `2130:451`, Show more (next page), aside "Didn't find your
  answer?" (**Contact support** → New ticket modal; no live chat), Search tips. No-results state `2130:965`. Popular
  searches aside = popular article titles.
- **Topic** `/help/topics/:slug`: composed from the search layout (category title + description + article rows).
- **Article** `71:21665` / mobile `2132:55211` (`/help/articles/:slug`): breadcrumb Help center › topic, topic tag +
  "Updated {date} · n min read", language toggle, fallback note (P89C-2), title, summary as intro, body renderer
  (`HelpArticleBody` in `@storeplix/ui`: headings with anchors, lists — ordered lists styled as numbered steps —
  callouts, images with `srcset` + alt + caption, links: internal via router, external `rel="noopener noreferrer"
  target="_blank"`), On this page (desktop aside, mobile collapsible "এই পাতায়" / "On this page"), Was this helpful
  Yes / No + count, No → reason card (`2130:965`) → Send feedback, thanks banner with Undo (DELETE), Related articles,
  Still stuck card (**Create a ticket** only). 404 state "This guide was moved or unpublished".
- **My tickets** `71:22058` (`/help/tickets`, `support.manage`): stats (Open, Waiting on you, Solved this month, Avg.
  first reply; "Rated x / 5" once ratings exist), tabs with counts, search, table → cards below `lg`, empty / error /
  loading states (`2130:965`).
- **New ticket modal** `75:23121`: Category, Subject, Related order picker (only with `orders.view`; searches the
  existing orders list endpoint), "What happened?", Attachments (drop zone, progress, PNG/JPG/PDF ≤ 10 MB, max 5),
  Priority chips Normal / High / Urgent (no "reply within 30 minutes" note), Cancel / Submit ticket; banners "Ticket
  T-n sent" (View ticket) and "Couldn't send your ticket" (Try again — text and files kept; same `client_id`).
- **Ticket thread** `71:22844` (`/help/tickets/:id`): header T-n + subject + status pill; thread (merchant / staff
  bubbles, attachments, system rows "Picked up by {name}", "Marked solved", "Reopened", "Closed automatically"); rating
  card when allowed; reply box (attach files) — disabled with "This ticket is closed. Open a new ticket" when closed;
  **Mark as solved**; side panel Ticket details (category, priority, status, assigned to, first reply, resolved in),
  Related order card (link to `/orders/:id` when `orders.view`), Your shop, "Shared with support" note ("Store Plix
  support can see this order's number, status, items and totals while the ticket is open"), Files. Polls messages
  every 30 s while visible (no ETag needed; plain GET).

## 14. Super admin (owner ADMIN) — section `49:7267`
- **Help articles** `2134:10410` (`/help-articles`): header + Categories / **New article** (dialog: title, slug
  auto-kebab, category); stats Published, Drafts, Missing বাংলা, Found helpful % (30 days); tabs with counts; search;
  chips Category / Language / Sort; table (title + `/help/articles/{slug}`, category, language tags with amber "বাংলা
  missing", status pill incl. "Scheduled {date}" / "Archived", helpful % · votes amber < 70 %, updated date · author);
  pagination.
- **Editor** `2134:66712` (`/help-articles/:id`, `/help-articles/new` = the dialog then redirect): breadcrumb, status
  pills (+ "Unpublished changes"), "Draft saved … · last published … by …", **Preview as merchant** (renders the draft
  with the shared `HelpArticleBody` in a merchant-width frame), **Publish changes**; language tabs English / বাংলা
  (+ "Both languages complete"); Title, Slug (shared), Summary (≤ 160 counter); editor Write (Tiptap with the allowed
  nodes only) / Markdown (textarea; converted on switch, unsupported syntax reported, never sent as Markdown) /
  Preview; toolbar H2 H3 B I list steps link image callout; image block requires alt; word count + read time; "No
  scripts or embeds". Aside: **Publish** (status, schedule date/time Asia/Dhaka, Unpublish; no "Visible to" and no
  "publish only when both" switch, Q326), **Category & search** (category, keyword chips per language ≤ 12),
  **Related articles** (search + pick ≤ 5), **Feedback** (yes %, top No reasons, list of notes), **Archive** (danger,
  confirm). Autosave 2 s; 409 revision conflict → reload prompt.
- **Categories** (drawer from the list header; composed): rows with icon, names en/bn, counts, drag to reorder, add /
  edit / delete (disabled with a tooltip while not empty).
- **Support tickets** `39:15432` (`/support`, `/support/:id`): reuse the existing frame — queue with status chips,
  assignee filter (Me / Unassigned / anyone), priority, search, sort; waiting time column (amber > 24 h, red > 72 h —
  display only, no SLA targets); thread with Reply / Internal note toggle (note bubbles amber "Only staff can see
  this"), attachments, status selector after reply; side panel merchant context (shop, plan, owner email, link to the
  merchant detail page, **Impersonate** button prefilled with `T-n` as ticket ref), related order card, ticket fields
  (priority, category, assignee), SLA timestamps, rating. Macros panel **hidden** (Q329). Poll the open thread every
  15 s and the queue every 60 s.

## 15. ARCH and types (owner ARCH — done in this change)
openapi **1.26.0** (tags `help`, `support`, `admin-help`, `admin-support`; `PermissionKey` + `support.manage`;
`PlatformPermission` + `manage_help_content`, `manage_support`; `MediaPurpose` gains nothing public — the purpose is
private). `packages/types`: Help center block (languages, statuses, icons, doc + blocks, category, article, links,
search, feedback, home, tickets, messages, attachments, list meta/stats, admin article/category/feedback/support
shapes, inputs, error codes, audit actions, limits) and the catalogue edits. `packages/api-client`: `help.home /
categories / category / search / article / vote / unvote`, `help.tickets.list / create / get / messages / reply /
resolve / rate`, `help.uploadAttachment / attachmentLink`, `admin.help.articles.* / categories.* / uploadMedia`,
`admin.support.*`, queries `helpSearchQuery`, `supportTicketQuery`, `adminHelpArticleQuery`, `adminSupportQuery`;
`UploadOptions.noTenant` (admin uploads never send `X-Tenant-Id`); tests `phase8-9c.test.ts`. Docs: ADR 0029,
DATABASE-DESIGN §5.15, SECURITY T46, MULTI-TENANCY count 106, OPEN-QUESTIONS Q306–Q329, roadmap 8.9c.

## 16. Test requirements
**API (Pest)**, groups `help`, `support` (+ `rls`, `security`, `race`): every §11 route (happy, validation, authz
matrix O/A/S/C and platform roles, impersonation, isolation); doc validator vectors (S252); publish / schedule /
unpublish / archive / restore / delete transitions, draft vs published snapshot, unpublished-changes flag, slug change +
redirect, incomplete-translation 422, media-missing 422, scheduled job (incl. incomplete); merchant visibility per
status (404s incl. search/related/popular); language fallback (`fallback`, `available_languages`); search on sqlite and
Postgres (en + bn text, trigram typo, category counts, pagination, injection strings); feedback upsert / change / undo /
counters / one per user (Postgres race); views dedupe per day; categories CRUD, reorder, not-empty, limit; help image
upload (sniff, SVG reject, platform path); tickets create (idempotent, limit 20, limiter, `order_id` needs `orders.view`
and same tenant, attachments ≤ 5 and 10 MB), list tabs/counts/stats, transitions (reply, reopen, resolve, closed 409,
auto-close job), rating window, notes never in merchant output (S251, static), signed attachment links + headers +
note-attachment 404; admin queue filters/sorts/counts across tenants on `pgsql_admin`, assign (invalid, disabled staff
unassigned), status, priority, staff attachments land in the tenant prefix, order card fields + audit dedupe + hidden
when closed; every mail (recipients, owner fallback, `SUPPORT_TEAM_EMAIL` unset, coalescing, no notes); prune
commands; permission catalogue (29 + 1) and platform matrix.
**Web (Vitest)**: home (toggle, chips, topic cards, Talk to us gating), search (language chips, category chips, no
results, show more), article (fallback note, TOC, renderer for every block incl. callout/image/links, helpful flow with
reasons + Undo, 404), tickets list (tabs, stats, search, cards on mobile), new ticket modal (validation, order picker
gating, uploads with limits, retry keeps data), thread (system rows, reply, reopen, closed state, rating card, mark
solved), loading/empty/error states.
**ADMIN (Vitest)**: nav gating per platform role; article list tabs/filters/stats; editor (tabs, autosave, revision
conflict, markdown round-trip of allowed syntax + rejection message, image alt required, publish errors, schedule,
archive confirm, preview); categories drawer; support queue filters, thread reply/note toggle, assign, status,
impersonate prefill, order card.
**QA (Playwright)** `phase8-9c.spec.ts`: staff writes and publishes an English guide with an image and a callout →
merchant finds it by search in English, opens বাংলা → fallback note; staff adds বাংলা and publishes → বাংলা shown;
merchant votes No with a reason → staff sees it in Feedback; owner opens a ticket with an order and a PDF → staff
(support role) sees it in the queue with the order card, writes an internal note and a reply → merchant sees the reply
but not the note, Mailpit/log has the reply mail; merchant marks solved and rates 5; a Staff-role member has no New
ticket; archived guide link shows the 404 state; 390 px screenshots of Help home, article and ticket thread.
**QA infra**: CI Pest groups `help`, `support` on sqlite, Postgres and RLS; race tests in `api-perf` / `api-rls`.

## 16.1 File ownership

| Agent | Owns (create/edit) |
|---|---|
| **API (Laravel)** | `apps/api/**` only: `app/Domain/Help/**` (models, services, `HelpArticleDocValidator`, search, presenters, requests, admin controllers, jobs/commands `help:publish-scheduled`, `help:prune-media`, `help:prune-views`), `app/Domain/Support/**` (models, services, `SupportQueue`, presenters, requests, policies, mail, commands `support:close-resolved`, `support:prune`, prune of orphan uploads), `routes/help.php`, `routes/admin-help.php`, `routes/admin-support.php` + include lines, signed download in `api.php`, migrations `2026_12_14_*`, `config/support.php`, `resources/views/mail/support/*`, `Media/MediaPurpose.php` (`support_attachment`), `Tenancy/Authorization/Permission.php` + `SystemRole.php`, `Admin/Authorization/PlatformPermission.php` + `PlatformRole.php`, `Tenancy` (`RlsTables`), `rls-emergency-off.sql`, staff-disable / permission-change hook for unassignment, `AuditLogger` subject types, scheduler entries, tests |
| **WEB (React)** | `apps/merchant-dashboard/**`: `src/help/**` (new: home, search, topic, article, tickets list, new ticket modal, thread, hooks), `src/layout/nav.ts` (Help & support route; mobile More), `src/lib/permissions.ts` (`manageSupport`), `App.tsx` routes, fixtures/tests |
| **ADMIN (React)** | `apps/super-admin/**`: `src/help-articles/**` (list, editor, categories drawer, markdown conversion), `src/support/**` (queue, thread, side panel), `src/layout/nav.ts` (Support tickets, Help articles), `App.tsx` routes, tests |
| **UI (shared, owned by WEB)** | `packages/ui/src/help/HelpArticleBody.tsx` (+ test) — the one renderer both apps use; ADMIN consumes only |
| **ARCH** | `docs/**` except `docs/reviews/**`, TESTING.md, FIGMA-INDEX.md, AGENT-CONTRACTS.md; `packages/types/**`, `packages/api-client/**` (done) |
| **QA** | `tests/e2e/**` (`phase8-9c*.spec.ts`), `.github/**`, `docs/development/TESTING.md`, `docs/reviews/phase-8-9c-qa.md` |
SF: **no change**. Shared-read rules: re-read `routes/api.php`, `Permission.php`, `PlatformRole.php`, both `nav.ts`
files and `MediaPurpose.php` before each Edit.

## 16.2 Order of work
1. ARCH: types + api-client + openapi (done), this file, ADR 0029, docs.
2. API: migrations + RLS → permissions (merchant + platform) → categories + help media → articles (draft, validator,
   publish, schedule, redirects) → merchant read + search + feedback + views → tickets (create, list, thread, replies,
   attachments, transitions, rating) → admin queue + actions + order card → mails → commands, limiters, audit, static
   tests.
3. WEB: `HelpArticleBody` → home + article → search + topic → tickets list + modal → thread → states + mobile.
4. ADMIN: nav → article list → editor → categories → support queue + thread.
5. QA: specs + CI groups while the others build; gate after all are green.

## 17. Acceptance criteria
1. A merchant who never opens Help sees no change; all pre-existing tests pass (catalogue counts and platform matrix
   only).
2. Every member reads published guides by topic, search (English and বাংলা) and links; a missing বাংলা version falls
   back to English with a note; draft, scheduled and archived guides are never visible.
3. A member votes once per guide (changeable, Undo, reason on No); staff see helpful % and reasons.
4. Staff with `manage_help_content` create, edit (rich text only, images with alt), preview, publish, schedule,
   unpublish, archive and restore guides and manage categories; publishing never exposes unsaved drafts.
5. Members with `support.manage` open tickets (category, subject, description, priority, optional order, JPG/PNG/PDF ≤
   10 MB), reply, mark solved, reopen by replying, and rate; closed tickets are final.
6. Staff with `manage_support` work one cross-tenant queue: assign, reply, write internal notes (never visible to
   merchants), change status/priority, see SLA timestamps and the limited, audited related-order card.
7. Emails reach the requester (owner fallback) on reply and resolve and the assignee / team address on new tickets and
   merchant replies; no notes or attachments in mail.
8. Figma `71:21272`, `2130:463`, `71:21665`, `71:22058`, `75:23121`, `71:22844`, `2130:965`, `2131:1440`,
   `2132:55211`, `2134:10410`, `2134:66712`, `39:15432` match with the documented differences (§18); 390 px usable.
9. `pnpm -r test`, `pnpm -r typecheck`, Pest (sqlite + Postgres + `api-rls`; groups `help`, `support`, `rls`,
   `security`, `race`), Playwright `phase8-9c*` green; `npx --yes @redocly/cli@1.25.11 lint docs/api/openapi.yaml`
   passes.

## 18. Figma notes for the PO (product owner)
- Talk to us / Still stuck cards show only **Email & tickets** / **Create a ticket**; Live chat, Call, WhatsApp, status
  strip, videos, AI and setup checklist are hidden (Q327, Q328).
- Hero "Popular" chips and "Popular searches" use the most-viewed guides of the week (Q325).
- The editor has no "Visible to" select and no "publish only when English and বাংলা are both filled" switch: English is
  required, বাংলা optional (Q326); the "Missing বাংলা" tab shows the gap.
- The New ticket modal's Urgent chip has no "reply within 30 minutes" promise (no SLA targets, Q329).
- Ticket Priority includes a staff-only `Low`.
- Super-admin Support tickets keep `39:15432` but the macros panel is hidden (Q329).
- Status names: merchant pills Open / Waiting on you / Waiting on support / Solved / Closed map to `open`,
  `awaiting_merchant`, `awaiting_support`, `resolved`, `closed`.
