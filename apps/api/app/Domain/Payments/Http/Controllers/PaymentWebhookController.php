<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Payments\Jobs\ProcessPaymentWebhook;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Payments\PayloadScrubber;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\IntegrationLookup;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Webhooks\WebhookIngestor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Gateway webhooks (PHASE-5B §4.3, P5B-19, S24, S25). Public, no tenant header: the route key resolves the account
 * (definer function). Steps: resolve → cheap pre-filter → store in webhook_events (deduplicated) → 200 → queued
 * processing that re-verifies with the provider. Responses carry no tenant data.
 */
class PaymentWebhookController
{
    private const ACK = ['received' => true];

    public function __construct(
        private readonly IntegrationLookup $lookup,
        private readonly WebhookIngestor $ingestor,
        private readonly TenantContext $context,
    ) {}

    /** SSLCommerz IPN (form POST): `verify_sign` (md5 scheme of the official PHP SDK) is a pre-filter only. */
    public function sslcommerz(Request $request, string $routeKey): JsonResponse
    {
        $owner = $this->owner(PaymentGatewayAccount::SSLCOMMERZ, $routeKey);
        $post = array_filter($request->post() ?: $request->json()->all(), fn ($v, $k) => is_string($k) && (is_scalar($v) || $v === null), ARRAY_FILTER_USE_BOTH);
        $tranId = is_string($post['tran_id'] ?? null) ? substr($post['tran_id'], 0, 64) : null;
        $valId = is_string($post['val_id'] ?? null) ? substr($post['val_id'], 0, 100) : null;
        if ($tranId === null) {
            return new JsonResponse(['data' => self::ACK]);
        }
        $passwd = $this->context->run($owner['tenant_id'], function () use ($owner) {
            $account = PaymentGatewayAccount::query()->whereKey($owner['account_id'])->first();

            return $account?->isConnected() ? (string) (($account->credentials['store_passwd'] ?? '')) : '';
        });
        $status = $passwd !== '' && self::verifySign($post, $passwd) ? WebhookEvent::RECEIVED : WebhookEvent::IGNORED;
        $eventId = $valId ?? ($tranId.':'.strtolower((string) ($post['status'] ?? 'unknown')));

        $this->ingestor->ingest($owner, PaymentGatewayAccount::SSLCOMMERZ, $eventId, is_string($post['status'] ?? null) ? strtolower($post['status']) : null,
            PayloadScrubber::scrub($post), $status, fn (WebhookEvent $e) => new ProcessPaymentWebhook($e->id));

        return new JsonResponse(['data' => self::ACK]);
    }

    /**
     * bKash notification, AWS-SNS style (optional in 5b; VERIFY against sandbox). Only a trigger for Query Payment:
     * a forged notification can't change anything. SubscriptionConfirmation is confirmed only for an https
     * `sns.<region>.amazonaws.com` SubscribeURL (S27).
     */
    public function bkash(Request $request, string $routeKey): JsonResponse
    {
        $owner = $this->owner(PaymentGatewayAccount::BKASH, $routeKey);
        $body = json_decode((string) $request->getContent(), true);
        if (! is_array($body) || ! is_string($body['Type'] ?? null) || ! is_string($body['MessageId'] ?? null)) {
            return new JsonResponse(['data' => self::ACK]);
        }
        if ($body['Type'] === 'SubscriptionConfirmation') {
            $url = (string) ($body['SubscribeURL'] ?? '');
            if (self::isSnsUrl($url)) {
                try {
                    Http::timeout((int) config('payments.http.timeout', 30))->connectTimeout((int) config('payments.http.connect_timeout', 10))
                        ->withoutRedirecting()->get($url);
                    SafeHttpClient::log('bkash', 'sns_confirm', null, ['account_id' => $owner['account_id']]);
                } catch (Throwable) {
                    Log::warning('payments.sns_confirm_failed', ['account_id' => $owner['account_id']]);
                }
            } else {
                Log::warning('payments.sns_url_refused', ['account_id' => $owner['account_id']]);
            }

            return new JsonResponse(['data' => self::ACK]);
        }
        if ($body['Type'] !== 'Notification') {
            return new JsonResponse(['data' => self::ACK]);
        }
        $message = is_string($body['Message'] ?? null) ? json_decode($body['Message'], true) : null;
        $message = is_array($message) ? $message : [];
        $payload = PayloadScrubber::scrub(['Type' => 'Notification', 'MessageId' => $body['MessageId']] + array_filter($message, fn ($v) => is_scalar($v) || $v === null));
        $this->ingestor->ingest($owner, PaymentGatewayAccount::BKASH, substr($body['MessageId'], 0, 128), 'notification', $payload,
            WebhookEvent::RECEIVED, fn (WebhookEvent $e) => new ProcessPaymentWebhook($e->id));

        return new JsonResponse(['data' => self::ACK]);
    }

    /** md5 over the `verify_key` fields + md5(store_passwd), sorted by key, joined `k=v&` (SSLCommerz PHP SDK). */
    public static function verifySign(array $post, string $storePasswd): bool
    {
        $sign = $post['verify_sign'] ?? null;
        $keys = $post['verify_key'] ?? null;
        if (! is_string($sign) || ! is_string($keys) || $keys === '') {
            return false;
        }
        $data = [];
        foreach (explode(',', $keys) as $key) {
            $data[$key] = (string) ($post[$key] ?? '');
        }
        $data['store_passwd'] = md5($storePasswd);
        ksort($data);
        $parts = [];
        foreach ($data as $key => $value) {
            $parts[] = $key.'='.$value;
        }

        return hash_equals(md5(implode('&', $parts)), strtolower($sign));
    }

    public static function isSnsUrl(string $url): bool
    {
        $parts = parse_url($url);

        return is_array($parts) && ($parts['scheme'] ?? '') === 'https' && ! isset($parts['port']) && ! isset($parts['user'])
            && preg_match('/^sns\.[a-z0-9-]+\.amazonaws\.com$/', strtolower((string) ($parts['host'] ?? ''))) === 1;
    }

    /** @return array{tenant_id: string, store_id: string, account_id: string} */
    private function owner(string $provider, string $routeKey): array
    {
        return $this->lookup->routeKeyOwner($provider, $routeKey) ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
