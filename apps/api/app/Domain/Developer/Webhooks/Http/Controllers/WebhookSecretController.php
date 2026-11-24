<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Controllers;

use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Developer\Webhooks\WebhookSecrets;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/**
 * PHASE-8-4 §6.1 `/stores/{store}/webhook-secret…` (Q132, S109). Read and reveal on every plan (reveal is a read);
 * rotate needs api_webhooks. Reveal and rotate are audited; the secret is never logged.
 */
class WebhookSecretController
{
    public function __construct(private readonly WebhookSecrets $secrets) {}

    public function show(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => WebhookSecrets::present($this->secrets->ensure($store))]);
    }

    public function reveal(Store $store): JsonResponse
    {
        [$row, $plain] = $this->secrets->reveal($store);

        return new JsonResponse(['data' => WebhookSecrets::present($row, $plain)]);
    }

    public function rotate(Store $store, WebhookEndpoints $endpoints): JsonResponse
    {
        $endpoints->assertFeature();
        [$row, $plain] = $this->secrets->rotate($store);

        return new JsonResponse(['data' => WebhookSecrets::present($row, $plain)]);
    }
}
