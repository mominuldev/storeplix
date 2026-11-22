<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Http\Requests\ConnectGatewayRequest;
use App\Domain\Payments\Http\Requests\UpdateGatewayRequest;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\PaymentGatewayPresenter;
use App\Domain\Payments\PaymentManager;
use App\Domain\Payments\PaymentUrls;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;

/**
 * Payment gateways (PHASE-5B §4.1, P5B-10/11; S26, S38): list, connect (live credential check first, then save),
 * enable / default, test payment, disconnect. Reads O A S; writes O A (`ManageIntegrations`). Credentials are never
 * returned or logged; the audit trail records provider and mode only. No row lock is held across a provider call.
 */
final class PaymentGatewayController
{
    public function __construct(
        private readonly PaymentManager $payments,
        private readonly AuditLogger $audit,
        private readonly StorefrontRevalidationObserver $revalidation,
    ) {}

    public function index(Store $store): JsonResponse
    {
        Gate::authorize('integrations.view', $store);
        $rows = PaymentGatewayAccount::query()->where('store_id', $store->id)->with('connectedBy')->get()->keyBy('provider');

        return new JsonResponse(['data' => array_map(
            fn (string $provider) => PaymentGatewayPresenter::present($rows[$provider] ?? null, $provider),
            PaymentGatewayAccount::PROVIDERS,
        )]);
    }

    public function connect(ConnectGatewayRequest $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $mode = (string) $request->validated('mode');
        $credentials = $request->credentials();
        $existing = $this->account($store, $provider);

        // 1. Live credential check with an unsaved candidate (no transaction, no lock).
        $candidate = new PaymentGatewayAccount;
        $candidate->id = $existing->id ?? strtolower((string) Str::ulid());
        $candidate->tenant_id = $store->tenant_id;
        $candidate->store_id = $store->id;
        $candidate->provider = $provider;
        $candidate->mode = $mode;
        $candidate->credentials = $credentials;
        try {
            $this->payments->driver($provider)->checkCredentials($candidate);
        } catch (GatewayException $e) {
            throw self::apiError($e);
        }

        // 2. Save (serialised per store by the store row lock).
        $account = DB::transaction(function () use ($store, $provider, $mode, $credentials, $candidate, $request) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->account($store, $provider);
            $replaced = $account !== null;
            if ($account === null) {
                $account = new PaymentGatewayAccount;
                $account->id = $candidate->id;
                $account->store_id = $store->id;
                $account->provider = $provider;
                $account->route_key = PaymentGatewayAccount::newRouteKey();
                $account->revision = 1;
            } else {
                $account->revision++;
            }
            if (! $replaced || $account->status !== PaymentGatewayAccount::CONNECTED) {
                $account->connected_at = now();
            }
            $account->mode = $mode;
            $account->credentials = $credentials;
            $account->credentials_hint = PaymentGatewayAccount::hintFor($provider, $credentials);
            $account->status = PaymentGatewayAccount::CONNECTED;
            $account->verified_at = null; // new credentials: the test payment is due again
            $account->last_checked_at = now();
            $account->last_error_code = null;
            $account->connected_by = $request->user()?->getKey();
            $account->save();

            $this->audit->log('integration.connected', $account, ['kind' => 'payment_gateway', 'provider' => $provider, 'mode' => $mode, 'replaced' => $replaced]);

            return $account;
        });

        return new JsonResponse(['data' => PaymentGatewayPresenter::present($account->load('connectedBy'), $provider)]);
    }

    public function update(UpdateGatewayRequest $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $input = $request->validated();

        $account = DB::transaction(function () use ($store, $provider, $input) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->account($store, $provider);
            if ($account === null || $account->status === PaymentGatewayAccount::DISCONNECTED) {
                throw self::notConnected();
            }
            if ((int) $input['revision'] !== $account->revision) {
                throw StoreThemeService::conflict();
            }
            $enable = $input['enabled'] ?? $account->enabled;
            $default = $input['is_default'] ?? $account->is_default;
            if (($enable && ! $account->enabled) || ($default && ! $account->is_default)) {
                // P5B-11: only a connected account with a passed credential check (and a configured live URL).
                if (! $account->isConnected() || $account->last_checked_at === null || $account->baseUrl() === null) {
                    throw self::notConnected();
                }
            }
            if (! $enable) {
                $default = false;
            }
            if ($default && ! $account->is_default) {
                PaymentGatewayAccount::query()->where('store_id', $store->id)->whereKeyNot($account->id)->where('is_default', true)
                    ->update(['is_default' => false, 'revision' => DB::raw('revision + 1'), 'updated_at' => now()]);
            }
            $changed = $enable !== $account->enabled || $default !== $account->is_default;
            $account->enabled = (bool) $enable;
            $account->is_default = (bool) $default;
            if ($changed) {
                $account->revision++;
                $account->save();
                $this->audit->log('integration.updated', $account, ['kind' => 'payment_gateway', 'provider' => $provider, 'enabled' => $account->enabled, 'is_default' => $account->is_default]);
                // StorefrontCommerce.payment_methods is cached publicly (≤ 300 s): revalidate after commit.
                $this->revalidation->dispatch($store->tenant_id, $store->id);
            }

            return $account;
        });

        return new JsonResponse(['data' => PaymentGatewayPresenter::present($account->load('connectedBy'), $provider)]);
    }

    /**
     * P5B-11 test payment (৳ 10 sandbox / ৳ 1 live, `purpose: test`, no order). The charge row commits first, then the
     * gateway is called outside the transaction. Completion runs through the normal return handler; PaymentService
     * calls PaymentGatewayAccount::markVerified() when the test charge succeeds.
     */
    public function testPayment(Request $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $account = $this->account($store, $provider);
        if ($account === null || ! $account->isConnected()) {
            throw self::notConnected();
        }

        $payment = new Payment;
        $payment->store_id = $store->id;
        $payment->order_id = null;
        $payment->provider = $provider;
        $payment->type = Payment::TYPE_CHARGE;
        $payment->status = Payment::STATUS_PENDING;
        $payment->purpose = Payment::PURPOSE_TEST;
        $payment->amount = (int) config("payments.test_amount.{$account->mode}", 1000);
        $payment->currency = 'BDT';
        $payment->gateway_account_id = $account->id;
        $payment->expires_at = now()->addMinutes((int) config('payments.hold_minutes', 30));
        $payment->actor_user_id = $request->user()?->getKey();
        $payment->save();

        try {
            $initiation = $this->payments->driver($provider)->initiate(
                $payment,
                $account,
                PaymentUrls::returnUrl($payment),
                $provider === PaymentGatewayAccount::SSLCOMMERZ ? PaymentUrls::ipnUrl($account) : null,
            );
        } catch (GatewayException $e) {
            Payment::query()->whereKey($payment->id)->where('status', Payment::STATUS_PENDING)
                ->update(['status' => Payment::STATUS_FAILED, 'failure_code' => 'initiation_failed', 'updated_at' => now()]);
            throw self::apiError($e);
        }

        $payment->provider_payment_id = $initiation->providerPaymentId;
        $payment->raw = $initiation->raw;
        $payment->save();

        return new JsonResponse(['data' => ['payment_id' => $payment->id, 'redirect_url' => $initiation->redirectUrl]], 201);
    }

    public function disconnect(Store $store, string $provider): Response
    {
        Gate::authorize('integrations.manage', $store);

        DB::transaction(function () use ($store, $provider) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->account($store, $provider);
            if ($account === null || $account->status === PaymentGatewayAccount::DISCONNECTED) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $busy = Payment::query()->where('store_id', $store->id)->where('gateway_account_id', $account->id)
                ->where('status', Payment::STATUS_PENDING)->exists();
            if ($busy) {
                throw new ApiException(409, 'gateway_busy', 'This gateway has payments or refunds in progress. Try again when they finish.');
            }
            $wasEnabled = $account->enabled;
            $account->credentials = [];
            $account->credentials_hint = null;
            $account->status = PaymentGatewayAccount::DISCONNECTED;
            $account->enabled = false;
            $account->is_default = false;
            $account->verified_at = null;
            $account->last_error_code = null;
            $account->connected_at = null;
            $account->revision++;
            $account->save();

            $this->audit->log('integration.disconnected', $account, ['kind' => 'payment_gateway', 'provider' => $provider]);
            if ($wasEnabled) {
                $this->revalidation->dispatch($store->tenant_id, $store->id); // payment method gone from checkout
            }
        });

        return response()->noContent();
    }

    private function account(Store $store, string $provider): ?PaymentGatewayAccount
    {
        return PaymentGatewayAccount::query()->where('store_id', $store->id)->where('provider', $provider)->first();
    }

    private static function notConnected(): ApiException
    {
        return new ApiException(422, 'gateway_not_connected', 'Connect this gateway (and pass the credential check) first.');
    }

    private static function apiError(GatewayException $e): ApiException
    {
        return match ($e->errorCode) {
            GatewayException::CREDENTIALS_INVALID => new ApiException(422, 'credentials_invalid', 'The gateway rejected these credentials. Check them and try again.',
                $e->field !== null && $e->field !== 'rate_guard' ? ["credentials.{$e->field}" => ['Rejected by the gateway.']] : null),
            GatewayException::NOT_CONNECTED => self::notConnected(),
            default => new ApiException(502, 'provider_unavailable', 'The gateway isn\'t responding. Nothing was changed; try again in a few minutes.'),
        };
    }
}
