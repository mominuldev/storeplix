import { serializeJsonLd } from '@/lib/json-ld';

/**
 * Structured data. React writes a string child of <script> verbatim (only `<script` sequences are
 * escaped), so no raw-HTML injection prop is needed; `serializeJsonLd` already removed every `<`.
 */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json">{serializeJsonLd(data)}</script>;
}
