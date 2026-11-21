<?php

namespace App\Domain\Themes\Http\Controllers;

use App\Domain\Themes\ThemeRegistry;
use Illuminate\Http\JsonResponse;

class ThemeCatalogController
{
    /** GET /themes → ThemeCatalogEntry[] (registry order). Any role. */
    public function __invoke(ThemeRegistry $registry): JsonResponse
    {
        return new JsonResponse(['data' => $registry->catalog()]);
    }
}
