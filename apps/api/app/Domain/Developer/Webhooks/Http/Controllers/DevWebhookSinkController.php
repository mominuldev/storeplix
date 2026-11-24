<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Controllers;

use App\Domain\Developer\Webhooks\Sending\FakeWebhookClient;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Http\JsonResponse;

/**
 * TESTING-ONLY dev sink (PHASE-8-4 §4.3): what the fake sender "received" for the current tenant, newest first, with
 * the exact signed `raw_body`. Never registered in production; 404 unless WEBHOOKS_OUT_FAKE=true.
 */
class DevWebhookSinkController
{
    public function __invoke(FakeWebhookClient $fake): JsonResponse
    {
        if (! (bool) config('webhooks_out.fake')) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return new JsonResponse(['data' => $fake->sink()]);
    }
}
