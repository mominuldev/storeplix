<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers\Platform;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Providers\SmsProviderCatalog;
use App\Domain\Sms\Providers\SmsProviderPresenter;
use App\Domain\Sms\Providers\SmsProviderRules;
use App\Domain\Sms\Providers\SmsProviderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-9B §4, §9.1 `/admin/sms/drivers|alerts|providers…` (platform permission `manage_settings`). Credentials are
 * write-only: no response ever carries one (S220).
 */
class PlatformSmsProviderController
{
    public function __construct(
        private readonly SmsProviderService $providers,
        private readonly SmsProviderPresenter $presenter,
    ) {}

    public function drivers(): JsonResponse
    {
        return AdminPresenter::json(['data' => SmsProviderCatalog::all()]);
    }

    public function alerts(): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->presenter->alerts()]);
    }

    public function index(): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->presenter->overview()]);
    }

    public function show(string $provider): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->presenter->provider(SmsProviderService::locate($provider))]);
    }

    public function store(Request $request): JsonResponse
    {
        $input = $request->validate([
            'driver' => ['required', 'string', Rule::in(SmsProviderCatalog::CODES)],
            'name' => ['required', 'string', 'min:2', 'max:60'],
            'credentials' => ['required', 'array'],
            'settings' => ['required', 'array'],
        ] + SmsProviderRules::common(true));

        $provider = $this->providers->create($input, self::staff($request));

        return AdminPresenter::json(['data' => $this->presenter->provider($provider)], 201);
    }

    public function update(Request $request, string $provider): JsonResponse
    {
        $row = SmsProviderService::locate($provider);
        $input = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'name' => ['sometimes', 'string', 'min:2', 'max:60'],
            'settings' => ['sometimes', 'nullable', 'array'],
        ] + SmsProviderRules::common(false));

        return AdminPresenter::json(['data' => $this->presenter->provider($this->providers->update($row, $input, self::staff($request)))]);
    }

    public function test(Request $request, string $provider): JsonResponse
    {
        $row = SmsProviderService::locate($provider);
        $input = $request->validate(['phone' => ['required', 'string', 'max:20']]);

        return AdminPresenter::json(['data' => $this->providers->test($row, (string) $input['phone'], self::staff($request))]);
    }

    public function activate(Request $request, string $provider): JsonResponse
    {
        $row = SmsProviderService::locate($provider);
        $input = $request->validate([
            'role' => ['required', Rule::in([SmsProvider::PRIMARY, SmsProvider::FAILOVER])],
            'confirm_name' => ['nullable', 'string', 'max:120'],
            'keep_previous_as_failover' => ['sometimes', 'nullable', 'boolean'],
        ]);
        $this->providers->activate($row, (string) $input['role'], $input['confirm_name'] ?? null, (bool) ($input['keep_previous_as_failover'] ?? true), self::staff($request));

        return AdminPresenter::json(['data' => $this->presenter->overview()]);
    }

    public function rotate(Request $request, string $provider): JsonResponse
    {
        $row = SmsProviderService::locate($provider);
        $input = $request->validate([
            'credentials' => ['required', 'array'],
            'settings' => ['sometimes', 'nullable', 'array'],
            'settings.account_id' => ['sometimes', 'nullable', 'string', 'max:64'],
            'settings.base_url' => ['sometimes', 'string', 'max:255'],
            'phone' => ['required', 'string', 'max:20'],
        ]);
        $fresh = $this->providers->rotate($row, $input['credentials'], $input['settings'] ?? null, (string) $input['phone'], self::staff($request));

        return AdminPresenter::json(['data' => $this->presenter->provider($fresh)]);
    }

    public function remove(Request $request, string $provider): JsonResponse
    {
        $row = SmsProviderService::locate($provider);
        $input = $request->validate(['confirm_name' => ['present', 'nullable', 'string', 'max:120']]);
        $this->providers->remove($row, $input['confirm_name'] ?? null, self::staff($request));

        return AdminPresenter::json(['data' => $this->presenter->overview()]);
    }

    public function refreshBalance(string $provider): JsonResponse
    {
        return AdminPresenter::json(['data' => $this->presenter->provider($this->providers->refreshBalance(SmsProviderService::locate($provider)))]);
    }

    public static function staff(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }
}
