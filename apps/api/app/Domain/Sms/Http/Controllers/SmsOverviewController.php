<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers;

use App\Domain\Sms\Http\Requests\SmsTestRequest;
use App\Domain\Sms\SmsOverviewPresenter;
use App\Domain\Sms\SmsTestService;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;

/** PHASE-8-9A §6: GET /stores/{store}/sms (overview) and POST /stores/{store}/sms/test. */
class SmsOverviewController
{
    public function show(Store $store, SmsOverviewPresenter $overview): JsonResponse
    {
        return new JsonResponse(['data' => $overview->present($store)], 200, ['Cache-Control' => 'private, no-store']);
    }

    public function test(SmsTestRequest $request, Store $store, SmsTestService $service): JsonResponse
    {
        $language = $request->validated()['language'] ?? null;

        return new JsonResponse(['data' => $service->send($store, $request->user(), $language)]);
    }
}
