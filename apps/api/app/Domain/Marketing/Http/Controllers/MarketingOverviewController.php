<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Controllers;

use App\Domain\Marketing\MarketingOverview;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** GET /stores/{store}/marketing/overview?range=7d|30d|90d (PHASE-8-5 §6.1; perm:marketing.manage). */
class MarketingOverviewController
{
    public function __invoke(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate(['range' => ['sometimes', 'string', 'in:7d,30d,90d']]);

        return new JsonResponse(['data' => MarketingOverview::build($store, $input['range'] ?? '30d')]);
    }
}
