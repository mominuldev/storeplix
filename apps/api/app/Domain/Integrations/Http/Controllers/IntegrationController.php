<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Http\Controllers;

use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Integrations\IntegrationPresenter;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\IntegrationService;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-9D §4 (openapi tag `integrations`): list, get, connect (PUT), settings (PATCH), disconnect, verify. Reads
 * `integrations.manage | marketing.manage` (members with only `products.edit` see the AI rows of the list); writes
 * `integrations.manage` (route middleware). Responses are `private, no-store` and never carry a secret.
 */
final class IntegrationController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(private readonly IntegrationService $service, private readonly TenantContext $context) {}

    public function index(Store $store): JsonResponse
    {
        $rows = StoreIntegration::query()->where('store_id', $store->id)->get()->keyBy('provider');
        $full = $this->context->allowsAny(Permission::IntegrationsManage, Permission::MarketingManage);
        $providers = $full ? IntegrationProvider::ALL : IntegrationProvider::AI;

        return new JsonResponse(['data' => array_map(fn (string $p) => IntegrationPresenter::summary($p, $rows->get($p)), $providers)], 200, self::NO_STORE);
    }

    public function show(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assert($provider);

        return $this->one($request, $provider, IntegrationService::find($store, $provider));
    }

    public function update(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assert($provider);
        $input = $request->validate([
            'settings' => ['required', 'array'],
            'credentials' => ['sometimes', 'nullable', 'array'],
            'revision' => ['sometimes', 'integer', 'min:0'],
        ]);

        return $this->one($request, $provider, $this->service->save($store, $provider, $input, self::user($request)));
    }

    public function patch(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assert($provider);
        $input = $request->validate([
            'settings' => ['required', 'array'],
            'revision' => ['required', 'integer', 'min:1'],
            'credentials' => ['prohibited'],
        ]);

        return $this->one($request, $provider, $this->service->patch($store, $provider, $input, self::user($request)));
    }

    public function disconnect(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assert($provider);
        $confirm = $request->input('confirm');
        if ($confirm !== 'DISCONNECT') {
            throw new ApiException(422, 'confirmation_mismatch', 'Type DISCONNECT to confirm.', ['confirm' => ['Type DISCONNECT to confirm.']]);
        }

        return $this->one($request, $provider, $this->service->disconnect($store, $provider, self::user($request)));
    }

    public function verify(Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assert($provider);

        return new JsonResponse(['data' => $this->service->verify($store, $provider)], 200, self::NO_STORE);
    }

    private function one(Request $request, string $provider, ?StoreIntegration $row): JsonResponse
    {
        $readOnly = $request->hasSession() && SessionSurface::of($request) === SessionSurface::IMPERSONATION;

        return new JsonResponse(['data' => IntegrationPresenter::full($provider, $row?->refresh(), $readOnly)], 200, self::NO_STORE);
    }

    public static function user(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }
}
