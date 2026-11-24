<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Http\Controllers;

use App\Domain\Developer\Webhooks\Http\Resources\WebhookPresenter;
use Illuminate\Http\JsonResponse;

/** GET /webhook-event-types (PHASE-8-4 §6.1): the §4.1 catalogue, UI order. */
class WebhookEventTypeController
{
    public function __invoke(): JsonResponse
    {
        return new JsonResponse(['data' => WebhookPresenter::eventTypes()]);
    }
}
