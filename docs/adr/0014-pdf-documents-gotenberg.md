# ADR 0014 — Invoice and label PDFs with Bangla shaping (Gotenberg)

Status: Accepted (Phase 5b, task 5.9) · Date: 2026-11-22 · Binding detail: PHASE-5B-CONTRACT §7 (P5B-50–P5B-58)

## Context
Merchants print A4 invoices, 80 mm receipts, A5 two-up invoices, packing slips and 4×6 in courier labels
(Figma 44:16156). Names and addresses are often in Bangla. Bangla needs OpenType shaping (conjuncts such as ক্ষ,
pre-base vowel signs such as ে/ি, reph). dompdf and TCPDF do not shape Bengali; mPDF's OTL support for Bengali is
partial and fragile with mixed Latin/Bangla text. Chromium shapes Bengali through HarfBuzz.

## Decision
- **Render HTML in headless Chromium via a Gotenberg 9 container** (`POST /forms/chromium/convert/html`), pinned to
  an exact 9.x tag at least 14 days old. It runs on the internal network only (never exposed), with basic auth,
  JavaScript disabled and no outbound network (every asset is sent in the multipart request).
- The API renders **Blade templates from a JSON config** (`document_templates`, no merchant HTML): fixed layouts per
  kind, options such as logo, BIN/VAT line, product names, language, paper size and footer text.
- **Fonts are embedded files** shipped with the API: Noto Sans Bengali (SIL OFL) for Bangla and Inter for Latin,
  declared with `@font-face` and sent with each request. The container's system fonts are never relied on.
- Barcodes (Code 128) and QR codes are generated as inline SVG in PHP, so Chromium needs no network.
- Generation is a queued job (`documents` queue); PDFs go to the private disk under
  `tenants/{tenant_id}/invoices/`, are served by 5-minute signed URLs after a policy check, and are deleted after
  24 h (regenerated on demand).
- Local dev and CI without the container use `DOCUMENTS_DRIVER=html` (returns the rendered HTML, for template tests);
  one CI job runs the real container and checks the Bangla font is embedded and the text round-trips.

## Consequences
+ Correct Bangla, one rendering engine for all templates, CSS for layout (page sizes, two-up, 4×6).
+ The PHP image stays small (no Chromium inside php-fpm).
− One more container in compose and production (~1 GB image, memory per render); needs health checks and a
  concurrency limit.
− PDF output depends on the pinned Chromium version; template snapshots must be refreshed on upgrades.

## Alternatives
- Browsershot (Puppeteer) inside the API image: same engine, but Node + Chromium in every API container.
- mPDF: pure PHP, but unreliable Bengali shaping and slow for 100-label batches.
- Courier-issued labels only: not all couriers return printable labels, and invoices still need Bangla.
