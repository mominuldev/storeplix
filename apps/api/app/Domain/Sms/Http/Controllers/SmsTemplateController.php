<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Http\Requests\SmsTemplatePreviewRequest;
use App\Domain\Sms\Http\Requests\SmsTemplateUpdateRequest;
use App\Domain\Sms\Templates\SmsTemplateCatalog;
use App\Domain\Sms\Templates\SmsTemplateService;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** PHASE-8-9A §7: `/stores/{store}/sms/templates…` (list, preview, save, reset). */
class SmsTemplateController
{
    public function __construct(private readonly SmsTemplateService $templates) {}

    public function index(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => SmsTemplateCatalog::all($store)]);
    }

    public function preview(SmsTemplatePreviewRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        $checked = SmsTemplateCatalog::validate($store, $input['key'], $input['language'], (string) $input['body']);

        return new JsonResponse(['data' => $checked['preview']]);
    }

    public function update(SmsTemplateUpdateRequest $request, Store $store, string $key, string $language): JsonResponse
    {
        self::assertKey($key);
        $input = $request->validated();
        $row = $this->templates->update($store, $key, $language, (string) $input['body'], isset($input['revision']) ? (int) $input['revision'] : null, $request->user());

        return new JsonResponse(['data' => SmsTemplateCatalog::present($store, $key, $language, $row?->load('updatedBy'))]);
    }

    public function destroy(Request $request, Store $store, string $key, string $language): JsonResponse
    {
        self::assertKey($key);
        $this->templates->reset($store, $key, $language, $request->user());

        return new JsonResponse(['data' => SmsTemplateCatalog::present($store, $key, $language, null)]);
    }

    private static function assertKey(string $key): void
    {
        if (! SmsTemplateCatalog::exists($key)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
    }
}
