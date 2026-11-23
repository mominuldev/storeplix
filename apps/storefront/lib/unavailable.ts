import { colors, elevation1, radius } from '@storeplix/config/tokens';

/**
 * Phase 8.1 (P8-12, PHASE-8-1-CONTRACT §7.3): a suspended shop shows a bare "temporarily unavailable" page on every
 * route: no theme, no shop name, `noindex`, HTTP 503 + `Retry-After: 86400` + `Cache-Control: no-store`. Layout and
 * copy structure follow the draft "Coming soon" page (eyebrow pill, heading, one line, "Powered by Store Plix"),
 * rendered with the platform tokens because the shop's theme must not show.
 */
export const UNAVAILABLE_COPY = {
  title: 'Temporarily unavailable',
  eyebrow: 'Temporarily unavailable',
  heading: 'This store is temporarily unavailable',
  body: 'Please check back later.',
  footer: 'Powered by Store Plix',
} as const;

export const UNAVAILABLE_STATUS = 503;
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 86400;

export const UNAVAILABLE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'retry-after': String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  'x-robots-tag': 'noindex, nofollow',
};

const css = `
*{box-sizing:border-box;margin:0}
body{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;padding:64px 16px;background:${colors.surface.canvas};color:${colors.text.primary};font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
section{width:100%;max-width:560px;display:flex;flex-direction:column;align-items:center;gap:24px;padding:48px 24px;border:1px solid ${colors.border.default};border-radius:${radius.card}px;background:${colors.surface.card};box-shadow:${elevation1}}
.eyebrow{border-radius:${radius.full}px;background:${colors.brand[50]};color:${colors.brand[700]};padding:6px 14px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
h1{font-size:32px;line-height:40px;font-weight:700;letter-spacing:-.5px}
p.body{font-size:16px;line-height:24px;color:${colors.text.secondary}}
footer{font-size:14px;line-height:20px;color:${colors.text.muted}}
@media (min-width:640px){section{padding:48px}h1{font-size:40px;line-height:48px}}
`.trim();

/** The full static document. Nothing request- or shop-specific goes in (no escaping needed, nothing to leak). */
export function unavailableHtml(): string {
  const c = UNAVAILABLE_COPY;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${c.title}</title>
<link rel="icon" href="/platform/storeplix-favicon.svg">
<style>${css}</style>
</head>
<body>
<main style="display:contents">
<section aria-labelledby="unavailable-heading">
<p class="eyebrow">${c.eyebrow}</p>
<h1 id="unavailable-heading">${c.heading}</h1>
<p class="body">${c.body}</p>
</section>
<footer>${c.footer}</footer>
</main>
</body>
</html>
`;
}

/** The 503 response the proxy sends for every page of a suspended shop. HEAD gets the headers only. */
export function unavailableResponse(method = 'GET'): Response {
  return new Response(method === 'HEAD' ? null : unavailableHtml(), { status: UNAVAILABLE_STATUS, headers: UNAVAILABLE_HEADERS });
}
