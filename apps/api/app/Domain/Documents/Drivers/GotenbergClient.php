<?php

namespace App\Domain\Documents\Drivers;

use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\TemplateConfig;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Gotenberg 9 (ADR 0014, P5B-50): `POST {GOTENBERG_URL}/forms/chromium/convert/html`, multipart with `index.html`
 * plus the font files (no network inside Chromium), paper per kind in inches, `preferCssPageSize` (not for the roll),
 * `printBackground`, zero margins (the CSS @page rules own them), `singlePage` for the 80 mm roll. Fixed base URL
 * from config, basic auth, 10 s connect / 30 s total, no redirects; logs carry ids and status codes only.
 */
class GotenbergClient implements DocumentDriver
{
    public const ROUTE = '/forms/chromium/convert/html';

    public function render(string $html, string $kind): array
    {
        $config = config('documents.gotenberg');
        $paper = TemplateConfig::PAPER[$kind];
        $request = Http::timeout((int) $config['timeout'])->connectTimeout((int) $config['connect_timeout'])->withoutRedirecting()
            ->accept('application/pdf')
            ->attach('files', $html, 'index.html', ['Content-Type' => 'text/html']);
        foreach (DocumentRenderer::fontPaths() as $path) {
            $request = $request->attach('files', (string) file_get_contents($path), basename($path));
        }
        if (! empty($config['username'])) {
            $request = $request->withBasicAuth((string) $config['username'], (string) $config['password']);
        }
        $fields = [
            'paperWidth' => self::inches($paper['width_mm']),
            'paperHeight' => self::inches($paper['height_mm'] ?? 297),
            'marginTop' => '0', 'marginBottom' => '0', 'marginLeft' => '0', 'marginRight' => '0',
            // The 80 mm roll must not prefer the CSS @page size (80 × 297 mm): that pins the height and `singlePage` can
            // no longer fit the page to the content, so the printer would feed blank paper (QA 5b-4).
            'preferCssPageSize' => $kind === 'receipt_80mm' ? 'false' : 'true',
            'printBackground' => 'true',
            'singlePage' => $kind === 'receipt_80mm' ? 'true' : 'false',
        ];

        try {
            $response = $request->post(rtrim((string) $config['url'], '/').self::ROUTE, $fields);
        } catch (ConnectionException) {
            Log::warning('documents.gotenberg_unreachable', ['kind' => $kind]);
            throw new DocumentRenderFailed('renderer_unavailable', 'The PDF service is not reachable.');
        }
        if (! $response->successful()) {
            Log::warning('documents.gotenberg_failed', ['kind' => $kind, 'status' => $response->status()]);
            throw new DocumentRenderFailed($response->serverError() ? 'renderer_unavailable' : 'render_failed', 'The PDF service refused the document.');
        }
        $pdf = $response->body();
        if (! str_starts_with($pdf, '%PDF-')) {
            throw new DocumentRenderFailed('render_failed', 'The PDF service returned something else than a PDF.');
        }

        return ['bytes' => $pdf, 'extension' => 'pdf', 'mime' => 'application/pdf', 'pages' => self::countPages($pdf)];
    }

    public static function inches(float|int $mm): string
    {
        return rtrim(rtrim(number_format($mm / 25.4, 3, '.', ''), '0'), '.');
    }

    /** Page objects in the PDF (`/Type /Page`, not `/Pages`); null when it can't tell. */
    public static function countPages(string $pdf): ?int
    {
        $n = preg_match_all('#/Type\s*/Page(?![a-zA-Z])#', $pdf);

        return $n > 0 ? $n : null;
    }
}
