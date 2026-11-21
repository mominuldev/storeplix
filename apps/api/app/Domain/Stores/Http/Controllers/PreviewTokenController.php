<?php

namespace App\Domain\Stores\Http\Controllers;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Preview\PreviewTokenService;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

class PreviewTokenController
{
    /** POST /api/v1/stores/{store}/preview-token → 201 PreviewToken. {store} is tenant-scoped (foreign → 404). */
    public function __invoke(Store $store, PreviewTokenService $tokens, AuditLogger $audit): JsonResponse
    {
        Gate::authorize('preview', $store);

        $store->loadMissing('primaryDomain');
        $issued = $tokens->issue($store);

        $audit->log('store.preview_token_issued', $store);

        return new JsonResponse([
            'data' => [
                'token' => $issued['token'],
                'url' => $tokens->previewUrl($store, $issued['token']),
                'expires_at' => $issued['expires_at']->toIso8601ZuluString(),
            ],
        ], 201, ['Cache-Control' => 'no-store']);
    }
}
