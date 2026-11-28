<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers\Platform;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Platform\PlatformSmsMessageTypes;
use App\Domain\Sms\Platform\PlatformSmsType;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/** PHASE-8-9B §6, §9.1 `/admin/sms/message-types…` (platform permission `manage_settings`). */
class PlatformSmsMessageTypeController
{
    public function __construct(private readonly PlatformSmsMessageTypes $types) {}

    public function index(): JsonResponse
    {
        return AdminPresenter::json($this->types->list());
    }

    public function update(Request $request, string $type): JsonResponse
    {
        $t = PlatformSmsMessageTypes::type($type);
        $input = $request->validate(['enabled' => ['required', 'boolean']]);

        return AdminPresenter::json(['data' => $this->types->toggle($t, (bool) $input['enabled'], PlatformSmsProviderController::staff($request))]);
    }

    public function updateTemplate(Request $request, string $type, string $language): JsonResponse
    {
        $t = PlatformSmsMessageTypes::type($type);
        $language = self::language($language);
        $input = $request->validate(['body' => ['required', 'string', 'max:2000'], 'revision' => ['required', 'integer', 'min:0']]);

        return AdminPresenter::json(['data' => $this->types->updateTemplate($t, $language, (string) $input['body'], (int) $input['revision'],
            PlatformSmsProviderController::staff($request))]);
    }

    public function resetTemplate(Request $request, string $type, string $language): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->types->resetTemplate(PlatformSmsMessageTypes::type($type), self::language($language),
            PlatformSmsProviderController::staff($request))]);
    }

    public function preview(Request $request): JsonResponse
    {
        $input = $request->validate([
            'type' => ['required', Rule::enum(PlatformSmsType::class)],
            'language' => ['required', Rule::in(['bn', 'en'])],
            'body' => ['required', 'string', 'max:2000'],
        ]);

        return AdminPresenter::json(['data' => $this->types->preview(PlatformSmsType::from($input['type']), $input['language'], (string) $input['body'])]);
    }

    public function test(Request $request, string $type): JsonResponse
    {
        $t = PlatformSmsMessageTypes::type($type);
        $input = $request->validate([
            'language' => ['required', Rule::in(['bn', 'en'])],
            'phone' => ['required', 'string', 'max:20'],
            'body' => ['sometimes', 'nullable', 'string', 'max:2000'],
        ]);

        return AdminPresenter::json(['data' => $this->types->test($t, $input['language'], (string) $input['phone'], $input['body'] ?? null,
            PlatformSmsProviderController::staff($request))]);
    }

    private static function language(string $language): string
    {
        return in_array($language, ['bn', 'en'], true) ? $language : throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
