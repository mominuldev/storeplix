# ADR 0029 — Help center: platform-authored guides and tenant-owned support tickets

Status: Accepted (Phase 8.9c; PO (product owner) scope and defaults Q306–Q323, Q327–Q329 accepted, 2026-11-28;
Q324–Q326 defaults in effect) · Date: 2026-11-28 · Binding detail: PHASE-8-9C-CONTRACT §1 (P89C-1 – P89C-24),
§3–§12, §12.2 (S248–S261)
Builds on: ADR 0001 (shared-database tenancy), 0009 (file storage and CDN), 0012 (Postgres RLS), 0015 (platform staff
and impersonation), 0017 (granular permissions), 0028 (private attachment pattern).

## Context
Figma section `71:21271` designs a merchant Help center (topics, search, bilingual articles, "Was this helpful?") and
support tickets, and the super admin has an article editor (`2134:66712`) and a support queue (`39:15432`, drawn in
8.1 and deferred). Guides are written by Store Plix, not by merchants, and must exist in English and বাংলা. Tickets
belong to a merchant but are worked by platform staff across all tenants. The repo already has a strict rich-text JSON
format (PHASE-3 `RichTextDoc` + `RichTextValidator` + `SafeHref`), a private-document media pattern (8.7, 8.8e), a
platform connection that bypasses RLS for staff (`pgsql_admin`), audited impersonation with a `ticket_ref`, and no
support-ticket or help code.

## Decision
1. **Two ownership models.** Help content (`help_categories`, `help_articles`, `help_article_translations`,
   `help_article_redirects`, `help_media`, `help_article_feedback`, `help_article_daily_views`) is **platform data**:
   no `tenant_id` owner, no RLS, app role read-only except votes and view counters, staff writes on the platform
   connection. Tickets (`support_tickets`, `support_ticket_messages`, `support_ticket_attachments`) are **tenant data**
   with RLS (`RlsTables::TENANT` 106), so a merchant can only ever reach their own; staff read the queue through one
   allowlisted cross-tenant class on `pgsql_admin` and act on a ticket inside `TenantContext::run`.
2. **Bodies are JSON, never HTML or Markdown.** `HelpArticleDoc` extends `RichTextDoc` with `image` (platform media id +
   required alt) and `callout` blocks; one validator on write, one React renderer (`@storeplix/ui` `HelpArticleBody`)
   shared by the merchant app and the editor preview. Markdown exists only inside the editor as an input mode.
3. **Draft and published snapshot per translation.** Staff edit drafts freely; Publish copies the snapshot and rebuilds
   the search vector. Merchants only read snapshots of `published` articles; every other status is a 404.
4. **Search in Postgres.** `tsvector` with the `simple` configuration (no Bengali stemmer exists) weighted title /
   keywords / summary / body, plus `pg_trgm` on titles for typos; a `LIKE` fallback keeps sqlite tests meaningful. No
   external search engine.
5. **Tickets are a small state machine with timestamps.** open → awaiting merchant ⇄ awaiting support → resolved →
   closed (auto after 7 days, final); a merchant reply reopens a resolved ticket. SLA *timestamps* are recorded now;
   targets and alerts are later. Staff internal notes are a message kind filtered out of every merchant path by
   explicit predicates.
6. **Least-privilege access on both sides.** Merchant key `support.manage` (Owner, Admin) — tickets share shop and order
   data with the platform, so the owner decides who may file them; reading guides needs no key. Platform permissions
   `manage_help_content` (super admin, support) and `manage_support` (super admin, support, billing). Staff see a
   limited related-order card (no customer contact data), each view audited; deeper access goes through existing
   impersonation referencing the ticket.
7. **Files**: ticket attachments are a new private media purpose (`support_attachment`, JPG/PNG/PDF ≤ 10 MB, sniffed,
   tenant prefix, signed 5-minute links), staff uploads stored in the ticket tenant's prefix; help images are public
   platform CDN objects under `platform/help/`.
8. **Email only** for notifications (requester with owner fallback; assignee or a team address); no SMS, no reply by
   email yet.

## Consequences
- + No new infrastructure or dependency; tenant isolation for tickets is enforced by RLS like every other merchant
  table; help content can be cached aggressively (it is the same for every tenant).
- + One renderer and one validator keep stored XSS out of a surface every merchant visits.
- − Bangla search has no stemming (exact word forms + trigram on titles); acceptable for a few hundred guides,
  revisit with an external engine if needed (Q328 "AI answers" would replace it anyway).
- − Two staff-facing code paths read across tenants (`SupportQueue`, ticket action resolver); both are allowlisted in
  the arch test and audited where tenant data is shown.
- − Closed tickets are deleted after 24 months (Q324, default in effect).

## Alternatives considered
- **Help content as tenant rows of a "platform tenant"** — rejected: RLS and `BelongsToTenant` would fight every
  merchant read; content is global by nature.
- **Store Markdown or sanitized HTML (HTMLPurifier)** — rejected: two formats to sanitize and render; the JSON doc
  already has a validator and renderer pattern in the repo.
- **External help desk (Zendesk / Freshdesk / Intercom)** — rejected for v1: per-seat cost, merchant data leaves the
  platform, no tenant-aware order card, and SSO work; can be revisited behind the same merchant UI.
- **Ticket permission = `settings.manage`** — rejected: Admin already has it, but a shop may want a dedicated support
  person without settings rights; a separate key costs one catalogue entry.
