<?php

namespace App\Domain\Shared\Http;

use Illuminate\Http\JsonResponse;

class HealthController
{
    public function __invoke(): JsonResponse
    {
        return new JsonResponse([
            'data' => [
                'status' => 'ok',
                'version' => (string) config('storeplix.version'),
                'time' => now()->toIso8601ZuluString(),
            ],
        ]);
    }
}
