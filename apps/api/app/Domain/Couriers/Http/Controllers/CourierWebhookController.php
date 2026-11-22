<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Controllers;

use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\CourierWebhooks;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Drivers\PathaoCourier;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\IntegrationLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Courier webhooks `/api/v1/webhooks/{steadfast|pathao|redx}/{route_key}` (PHASE-5B §4.3, P5B-37, S25, S32). Public,
 * no tenant header: the route key resolves the account (definer function). Steps: resolve → authenticate and parse
 * (driver: Steadfast bearer, sha256 + hash_equals; Pathao `X-PATHAO-Signature`) → store once in webhook_events →
 * respond (Steadfast 200, Pathao 202) → queued processing on `webhooks`. A bad secret → 401 and nothing is stored.
 * RedX: 404 until its driver declares webhook support. Responses carry no tenant data.
 */
class CourierWebhookController
{
    private const ACK = ['received' => true];

    public function __construct(
        private readonly IntegrationLookup $lookup,
        private readonly CourierWebhooks $webhooks,
        private readonly TenantContext $context,
        private readonly CourierManager $couriers,
    ) {}

    public function __invoke(Request $request, string $provider, string $routeKey): JsonResponse
    {
        $driver = $this->couriers->driver($provider);
        if (! $driver->supportsWebhooks()) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        $owner = $this->lookup->routeKeyOwner($provider, $routeKey) ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        $status = $provider === CourierAccount::PATHAO ? 202 : 200;
        // Pathao's integration handshake expects its header on every 202 acknowledgement.
        $headers202 = $provider === CourierAccount::PATHAO ? PathaoCourier::WEBHOOK_RESPONSE_HEADERS : [];
        $payload = $request->isJson() ? $request->json()->all() : $request->post();
        $payload = is_array($payload) ? $payload : [];
        $headers = $request->headers->all();

        return $this->context->run($owner['tenant_id'], function () use ($owner, $provider, $payload, $headers, $driver, $status, $headers202) {
            $account = CourierAccount::query()->where('store_id', $owner['store_id'])->whereKey($owner['account_id'])->first();
            if ($account === null || $account->provider !== $provider) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            try {
                $data = $driver->parseWebhook($payload, $headers, $account);
            } catch (CourierException $e) {
                if ($e->errorCode === CourierException::WEBHOOK_UNAUTHORIZED) {
                    Log::warning('webhook.rejected', ['provider' => $provider, 'account_id' => $account->id]);

                    throw new ApiException(401, 'unauthenticated', 'Invalid webhook credentials.');
                }
                Log::info('couriers.webhook_unreadable', ['provider' => $provider, 'account_id' => $account->id, 'code' => $e->errorCode]);

                return new JsonResponse(['data' => self::ACK], $status, $headers202);
            }
            CourierAccount::query()->whereKey($account->id)->update(['last_webhook_at' => now()]);
            if ($data === null) {
                return new JsonResponse(['data' => self::ACK], $status, $headers202); // e.g. Pathao `webhook_integration`
            }
            $this->webhooks->store($owner, $provider, $data, $payload);

            return new JsonResponse(['data' => self::ACK], $status, $headers202);
        });
    }
}
