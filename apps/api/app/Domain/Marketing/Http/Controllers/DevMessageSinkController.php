<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Controllers;

use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/**
 * TESTING-ONLY (PHASE-8-5 §5.4, S125): the store's last 200 rendered campaign / test messages (DevSinkMessage[],
 * newest first). Never registered in production; 404 unless CAMPAIGNS_DEV_SINK=true.
 */
class DevMessageSinkController
{
    public function __invoke(Store $store): JsonResponse
    {
        if (! DevMessageSink::enabled()) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return new JsonResponse(['data' => DevMessageSink::all($store->id)]);
    }
}
