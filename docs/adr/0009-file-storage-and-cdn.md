# ADR 0009 — File storage and CDN

Status: Accepted · Date: 2026-11-21

## Context
Product images dominate storefront weight; BD mobile networks are slow; uploads are an attack vector.

## Decision
- S3-compatible object storage (Cloudflare R2 in prod — zero egress to Cloudflare CDN; MinIO locally) via Laravel
  `Storage` disks `public_media` and `private`.
- Keys: `tenants/{tenant_id}/{area}/{ulid}.{ext}` via `TenantStorage`; metadata in `media`.
- Upload flow: API validates (sniffed MIME allowlist, size), stores original, queued `ProcessImage` job generates
  WebP variants (320/640/1024/1600) and strips EXIF. Direct-to-bucket presigned uploads only for CSV imports > 10 MB (Phase 5).
- Delivery: `cdn.storeplix.com` (separate host from storefront and app — cookieless, isolates any content-type
  confusion), immutable cache headers (keys are content-unique). Next.js `next/image` custom loader uses CDN variants.
- Private files (exports, invoices, imports) on private bucket, 5-minute signed URLs after policy check.

## Consequences
+ Cheap egress, fast delivery, tenant isolation by prefix and model.
− Async variant generation → UI shows processing state briefly.

## Alternatives
- AWS S3 + CloudFront: higher egress cost. · Local disk: not horizontally scalable. · Image CDN SaaS (Imgix/Cloudinary): cost per image at scale.
