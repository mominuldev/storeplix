# ADR 0004 — Theme configuration and rendering

Status: Accepted · Date: 2026-11-21

## Context
Merchants customize logo, colors, typography and homepage sections without code; Figma defines several store designs.

## Decision
Themes are TypeScript packages inside `apps/storefront/src/themes`, registered in a typed `themeRegistry`
(code, version, Zod schema, defaults, sections, templates). Merchant config is JSON `{theme, version, settings, sections[]}`
stored as `store_themes.draft_config` / `published_config` (jsonb). Zod is the schema source of truth; exported to JSON
Schema and validated in Laravel on save; re-validated with Zod on render with fallback to defaults. Publish triggers
tag revalidation. No merchant HTML/JS/CSS; colors/fonts via CSS variables from validated values. Details: STOREFRONT-ENGINE.md.

## Consequences
+ Safe by construction; consistent performance; themes evolve via versioned `migrate()`.
− New section types require a deploy (acceptable; we ship them).
− Two validators must stay in sync → CI check that exported schema copy in API matches.

## Alternatives
- **Liquid/Handlebars templates editable by merchants:** flexibility at the cost of XSS/perf risk and a template sandbox to maintain.
- **Page-builder with arbitrary component trees:** heavier editor, harder to keep on-brand with Figma; reconsider with Online store V3 proposal (Figma 2028:44400).
