<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Inbox\Http\Requests\InboxSettingsRequest;
use App\Domain\Inbox\InboxPresenter;
use App\Domain\Inbox\InboxSettingsService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Channels (PHASE-8-8E §4): read with inbox.manage | settings.manage, write and rotate with settings.manage. */
class InboxSettingsController
{
    public function __construct(
        private readonly InboxSettingsService $service,
        private readonly TenantContext $context,
    ) {}

    public function show(Store $store): JsonResponse
    {
        return $this->respond($store, $this->service->find($store->id));
    }

    public function update(InboxSettingsRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        foreach (['web_chat_enabled', 'order_messages_enabled', 'email_enabled'] as $key) {
            if (array_key_exists($key, $input)) {
                $input[$key] = filter_var($input[$key], FILTER_VALIDATE_BOOLEAN);
            }
        }
        $settings = $this->service->update($store, $input, (string) $request->user()?->getAuthIdentifier());

        return $this->respond($store, $settings->exists ? $settings : $this->service->find($store->id));
    }

    public function rotate(Request $request, Store $store): JsonResponse
    {
        return $this->respond($store, $this->service->rotate($store, (string) $request->user()?->getAuthIdentifier()));
    }

    private function respond(Store $store, mixed $settings): JsonResponse
    {
        return new JsonResponse(['data' => InboxPresenter::settings($settings, $store, $this->context->allows(Permission::SettingsManage))],
            200, ['Cache-Control' => 'private, no-store']);
    }
}
