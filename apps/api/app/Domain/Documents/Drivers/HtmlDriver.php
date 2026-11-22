<?php

namespace App\Domain\Documents\Drivers;

/** Local dev / CI without the container (P5B-57): the rendered HTML is the file. */
class HtmlDriver implements DocumentDriver
{
    public function render(string $html, string $kind): array
    {
        return ['bytes' => $html, 'extension' => 'html', 'mime' => 'text/html; charset=utf-8', 'pages' => null];
    }
}
