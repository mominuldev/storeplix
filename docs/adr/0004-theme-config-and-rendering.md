# ADR 0004 — Theme configuration and rendering

Status: Accepted · Date: 2026-11-21 · Refined by Phase 3 (PHASE-3-CONTRACT §1)

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

## Refinement (Phase 3, 2026-11-21)
- **Schema source of truth is now a hand-written JSON Schema** (draft 2020-12) per theme major version in
  `packages/themes/<code>/schema.v<major>.json`, not a Zod export. Laravel validates against a byte-identical copy
  (`opis/json-schema`); the storefront keeps self-healing Zod for render; shared valid/invalid fixtures run through
  all validators in CI (parity test). Rationale: no cross-app codegen step; one file readable by PHP, the dashboard
  form generator and AJV.
- **Editor = Online store V3** (`2028:44400`), still section-based (not a free-form page builder): ordered sections
  with ids, per-section design settings and blocks; global brand style. V1/V2-only settings stay in the schema.
- **Draft/publish applies to the theme document only**; pages, navigation and SEO save live (pages have
  draft/published/hidden status).
- **Rich text is JSON** (strict ProseMirror/Tiptap subset), never HTML; images are tenant media ids, never URLs.
- The whole theme document is camelCase (OPEN-QUESTIONS Q9 decided).
- Preview refresh: debounced draft save + postMessage `refresh` to the embedded preview (exact-origin checks both ways).
