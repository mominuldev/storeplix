<?php

namespace App\Domain\Documents\Drivers;

/** Turns a rendered document HTML into the stored file (P5B-57: `gotenberg` PDF or `html`). */
interface DocumentDriver
{
    /** @return array{bytes: string, extension: string, mime: string, pages: int|null} pages null = use the layout estimate */
    public function render(string $html, string $kind): array;
}
