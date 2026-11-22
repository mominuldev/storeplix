<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\CourierPayload;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Http\Client\Response;

/**
 * Pathao Merchant API (PHASE-5B §6.2; read from the merchant panel's developer page, no version/date — every call
 * VERIFY against sandbox). OAuth password grant: the access token is cached per account (TenantCache) for
 * `expires_in − margin`, refreshed with the refresh token, re-issued on a 401; a rejected issue-token is cached as an
 * error for 5 minutes so a bad account can't hammer the token endpoint. Webhook: our secret in `X-PATHAO-Signature`
 * (plain value), answer 202.
 */
final class PathaoCourier extends HttpCourierDriver
{
    private const API = 'aladdin/api/v1/';

    /**
     * VERIFY against sandbox: Pathao's integration check expects this response header on the webhook answer (value
     * published on the developer page). API-C2's webhook endpoint adds it to the 202.
     */
    public const WEBHOOK_RESPONSE_HEADERS = ['X-Pathao-Merchant-Webhook-Integration-Secret' => 'f3992ecc-59da-4cbe-a049-a13da2018d51'];

    /**
     * §6.2 mapping. Keys are webhook event names without `order.`; the status API's words ("Pickup_Requested",
     * "At the Sorting HUB") are folded into the same form by key().
     */
    public static function statusMap(): array
    {
        return [
            'created' => NormalisedStatus::of(Shipment::BOOKED),
            'pending' => NormalisedStatus::of(Shipment::BOOKED),
            'pickup-requested' => NormalisedStatus::of(Shipment::BOOKED),
            'assigned-for-pickup' => NormalisedStatus::of(Shipment::BOOKED),
            'picked' => NormalisedStatus::of(Shipment::PICKED_UP),
            'pickup-failed' => NormalisedStatus::unknown(),
            'pickup-cancelled' => NormalisedStatus::of(Shipment::CANCELLED),
            'at-the-sorting-hub' => NormalisedStatus::of(Shipment::IN_TRANSIT),
            'in-transit' => NormalisedStatus::of(Shipment::IN_TRANSIT),
            'received-at-last-mile-hub' => NormalisedStatus::of(Shipment::IN_TRANSIT),
            'assigned-for-delivery' => NormalisedStatus::of(Shipment::OUT_FOR_DELIVERY),
            'delivered' => NormalisedStatus::of(Shipment::DELIVERED),
            'partial-delivery' => NormalisedStatus::of(Shipment::PARTIALLY_DELIVERED),
            'delivery-failed' => NormalisedStatus::of(Shipment::DELIVERY_FAILED),
            'on-hold' => NormalisedStatus::of(Shipment::ON_HOLD),
            'returned' => NormalisedStatus::of(Shipment::RETURNING),
            'return' => NormalisedStatus::of(Shipment::RETURNING),
            'return-id-created' => NormalisedStatus::of(Shipment::RETURNING),
            'return-in-transit' => NormalisedStatus::of(Shipment::RETURNING),
            'returned-to-merchant' => NormalisedStatus::of(Shipment::RETURNED),
            'paid' => new NormalisedStatus(null, null, true),
            'paid-return' => new NormalisedStatus(null, null, true),
            'payment-invoice' => new NormalisedStatus(null, null, true),
            'exchanged' => new NormalisedStatus(null),
            'updated' => new NormalisedStatus(null),
        ];
    }

    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        return self::statusMap()[self::key($rawStatus)] ?? NormalisedStatus::unknown();
    }

    /** "order.pickup-requested" / "Pickup_Requested" / "At the Sorting HUB" → "pickup-requested" / "at-the-sorting-hub". */
    public static function key(string $raw): string
    {
        $k = strtolower(trim($raw));
        $k = str_starts_with($k, 'order.') ? substr($k, 6) : $k;

        return trim((string) preg_replace('/[\s_\-]+/', '-', $k), '-');
    }

    public function capabilities(): array
    {
        return ['bulk', 'areas', 'webhook'];
    }

    public function supportsWebhooks(): bool
    {
        return true;
    }

    public function checkCredentials(CourierAccount $account): CredentialCheck
    {
        $this->token($account, fresh: true);

        return new CredentialCheck(true);
    }

    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult
    {
        if ($request->weightGrams < 500 || $request->weightGrams > 10000) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Pathao takes parcels from 0.5 kg to 10 kg.', 'weight_grams');
        }
        if ($request->codAmount % 100 !== 0) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Pathao collects whole taka amounts only.', 'cod_amount');
        }
        if ($request->cityId === null || $request->zoneId === null) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Choose the Pathao city and zone for this address.', 'area');
        }
        if ($request->providerStoreId === null) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Choose the Pathao pickup store in the courier settings.', 'pickup_store');
        }

        $response = $this->call($account, 'POST', 'orders', $this->orderBody($request), 'create_order', ['shipment_id' => $request->invoice]);
        $body = self::json($response);
        $data = is_array($body['data'] ?? null) ? $body['data'] : [];
        if (! $response->successful() || self::str($data, 'consignment_id') === null) {
            throw self::rejection($body, 'Pathao rejected the parcel.');
        }

        return $this->result($data);
    }

    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate
    {
        $id = $shipment->consignment_id ?? throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Shipment has no consignment id.');
        $response = $this->call($account, 'GET', 'orders/'.rawurlencode($id).'/info', [], 'order_info', ['shipment_id' => $shipment->id]);
        $body = self::json($response);
        $data = is_array($body['data'] ?? null) ? $body['data'] : [];
        $raw = self::statusWord($data);
        if (! $response->successful() || $raw === null) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "pathao order_info returned HTTP {$response->status()}.");
        }

        return StatusUpdate::from(
            $this->normalise($raw, $shipment),
            self::key($raw),
            self::time(self::str($data, 'updated_at')),
            codCollectedAmount: self::collected($data),
            raw: CourierPayload::scrub($data),
        );
    }

    /**
     * VERIFY against sandbox: the public page documents no lookup by merchant_order_id. Assumed
     * `GET /aladdin/api/v1/orders?merchant_order_id={invoice}` returning `data.data[]` (or `data`) rows.
     */
    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult
    {
        $response = $this->call($account, 'GET', 'orders', ['merchant_order_id' => $invoice], 'find_by_invoice', ['shipment_id' => $invoice]);
        if (in_array($response->status(), [400, 404, 422], true)) {
            return null;
        }
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "pathao find_by_invoice returned HTTP {$response->status()}.");
        }
        $body = self::json($response);
        $rows = $body['data']['data'] ?? $body['data'] ?? [];
        $rows = is_array($rows) ? (array_is_list($rows) ? $rows : [$rows]) : [];
        foreach ($rows as $row) {
            if (is_array($row) && (string) ($row['merchant_order_id'] ?? '') === $invoice && self::str($row, 'consignment_id') !== null) {
                return $this->result($row);
            }
        }

        return null;
    }

    /**
     * §6.2: `X-PATHAO-Signature` carries the secret the merchant set in the Pathao panel (plain value, hash_equals).
     * `webhook_integration` → null (acknowledge with 202 + WEBHOOK_RESPONSE_HEADERS). `store.*` events → stored
     * without a parcel update. Event id = sha256(consignment_id|event|timestamp).
     */
    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData
    {
        $presented = self::header($headers, 'X-PATHAO-Signature');
        $secret = $account->webhookSecret();
        if ($presented === null || $secret === null || ! hash_equals($secret, $presented)) {
            throw new CourierException(CourierException::WEBHOOK_UNAUTHORIZED, 'pathao webhook signature missing or wrong.');
        }

        $event = self::str($payload, 'event');
        if ($event === 'webhook_integration') {
            return null;
        }
        $consignment = self::str($payload, 'consignment_id');
        $invoice = self::str($payload, 'merchant_order_id');
        $timestamp = self::str($payload, 'timestamp', 'updated_at');
        $eventId = hash('sha256', implode('|', [$consignment, $event, $timestamp]));
        $scrubbed = CourierPayload::scrub($payload);

        $update = null;
        if ($event !== null && str_starts_with($event, 'order.') && ($consignment !== null || $invoice !== null)) {
            $update = StatusUpdate::from(
                $this->normalise($event),
                self::key($event),
                self::time($timestamp),
                codCollectedAmount: self::collected($payload),
                raw: $scrubbed,
            );
        }

        return new WebhookEventData($eventId, $consignment, $invoice, $event, $update, $scrubbed);
    }

    /** Pathao cities (level city), zones of a city, areas of a zone. */
    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        [$path, $id, $name] = match ($level) {
            'city' => ['city-list', 'city_id', 'city_name'],
            'zone' => ['cities/'.rawurlencode((string) $parentId).'/zone-list', 'zone_id', 'zone_name'],
            'area' => ['zones/'.rawurlencode((string) $parentId).'/area-list', 'area_id', 'area_name'],
            default => throw new CourierException(CourierException::COURIER_REJECTED, 'Unknown area level.', 'level'),
        };
        if ($level !== 'city' && ($parentId === null || $parentId === '')) {
            return [];
        }
        $response = $this->call($account, 'GET', $path, [], "{$level}_list");
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "pathao {$level}_list returned HTTP {$response->status()}.");
        }
        $rows = self::json($response)['data']['data'] ?? [];
        $out = [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            if (is_array($row) && self::str($row, $id) !== null && self::str($row, $name) !== null) {
                $out[] = new CourierArea((string) self::str($row, $id), (string) self::str($row, $name), $level, $level === 'city' ? null : $parentId);
            }
        }

        return $out;
    }

    public function pickupStores(CourierAccount $account): array
    {
        $response = $this->call($account, 'GET', 'stores', [], 'stores');
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "pathao stores returned HTTP {$response->status()}.");
        }
        $rows = self::json($response)['data']['data'] ?? [];
        $out = [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            if (is_array($row) && self::str($row, 'store_id') !== null) {
                $out[] = new PickupStore((string) self::str($row, 'store_id'), (string) (self::str($row, 'store_name') ?? ''), self::str($row, 'store_address'));
            }
        }

        return $out;
    }

    protected function provider(): string
    {
        return CourierAccount::PATHAO;
    }

    // ---------------------------------------------------------------- token management

    /** A valid access token: cached → refresh → issue. A rejected issue is cached for 5 minutes. */
    private function token(CourierAccount $account, bool $fresh = false): string
    {
        $entry = $this->cache->get($this->cacheKey($account, 'token'));
        if (! $fresh && is_array($entry) && ($entry['use_until'] ?? 0) > now()->getTimestamp()) {
            return (string) $entry['access_token'];
        }
        $failure = $this->cache->get($this->cacheKey($account, 'token_failure'));
        if (! $fresh && is_string($failure)) {
            throw new CourierException($failure, 'pathao token request failed recently; retrying after the back-off.');
        }

        try {
            if (! $fresh && is_array($entry) && is_string($entry['refresh_token'] ?? null)) {
                try {
                    return $this->storeToken($account, $this->issue($account, ['grant_type' => 'refresh_token', 'refresh_token' => $entry['refresh_token']], 'refresh_token'));
                } catch (CourierException $e) {
                    if ($e->errorCode !== CourierException::CREDENTIALS_INVALID) {
                        throw $e;
                    }
                }
            }
            $c = $account->credentials;

            return $this->storeToken($account, $this->issue($account, [
                'grant_type' => 'password',
                'username' => (string) ($c['username'] ?? ''),
                'password' => (string) ($c['password'] ?? ''),
            ], 'issue_token'));
        } catch (CourierException $e) {
            if ($e->errorCode === CourierException::CREDENTIALS_INVALID) {
                $this->cache->put($this->cacheKey($account, 'token_failure'), $e->errorCode, (int) config('couriers.providers.pathao.token_failure_seconds', 300));
            }
            throw $e;
        }
    }

    /** @return array<string, mixed> */
    private function issue(CourierAccount $account, array $grant, string $action): array
    {
        $c = $account->credentials;
        $response = $this->send($this->client($account)->asJson(), 'POST', self::API.'issue-token', [
            'client_id' => (string) ($c['client_id'] ?? ''),
            'client_secret' => (string) ($c['client_secret'] ?? ''),
        ] + $grant, $action, $account);
        $body = self::json($response);
        if (! $response->successful() || ! is_string($body['access_token'] ?? null) || $body['access_token'] === '') {
            throw new CourierException(CourierException::CREDENTIALS_INVALID, "pathao {$action} rejected (HTTP {$response->status()}).");
        }

        return $body;
    }

    private function storeToken(CourierAccount $account, array $body): string
    {
        $expiresIn = is_numeric($body['expires_in'] ?? null) ? (int) $body['expires_in'] : 3600;
        $margin = (int) config('couriers.providers.pathao.token_margin_seconds', 3600);
        $useFor = max(60, $expiresIn - min($margin, intdiv($expiresIn, 2)));
        $this->cache->put($this->cacheKey($account, 'token'), [
            'access_token' => (string) $body['access_token'],
            'refresh_token' => is_string($body['refresh_token'] ?? null) ? $body['refresh_token'] : null,
            'use_until' => now()->getTimestamp() + $useFor,
        ], max($useFor, 30 * 86400));
        $this->cache->forget($this->cacheKey($account, 'token_failure'));

        return (string) $body['access_token'];
    }

    /** An authorised API call; a 401 drops the cached token and retries once. */
    private function call(CourierAccount $account, string $method, string $path, array $body, string $action, array $ids = []): Response
    {
        for ($try = 1; ; $try++) {
            $request = $this->client($account)->asJson()->withToken($this->token($account));
            $response = $this->send($request, $method, self::API.$path, $body, $action, $account, $ids);
            if ($response->status() === 401 && $try === 1) {
                $this->cache->forget($this->cacheKey($account, 'token'));

                continue;
            }
            if ($response->status() === 401) {
                throw new CourierException(CourierException::CREDENTIALS_INVALID, "pathao {$action} unauthorised.");
            }

            return $response;
        }
    }

    /** @return array<string, mixed> */
    private function orderBody(BookingRequest $r): array
    {
        $body = [
            'store_id' => is_numeric($r->providerStoreId) ? (int) $r->providerStoreId : $r->providerStoreId,
            'merchant_order_id' => $r->invoice,
            'recipient_name' => mb_substr($r->recipientName, 0, 100),
            'recipient_phone' => self::localPhone($r->recipientPhone),
            'recipient_address' => $r->fullAddress(220),
            'recipient_city' => self::idValue($r->cityId),
            'recipient_zone' => self::idValue($r->zoneId),
            'delivery_type' => in_array($r->deliveryType, [48, 12], true) ? $r->deliveryType : 48,
            'item_type' => $r->itemType,
            'item_quantity' => max(1, $r->itemQuantity),
            'item_weight' => self::kg($r->weightGrams),
            'amount_to_collect' => intdiv($r->codAmount, 100),
            'item_description' => mb_substr($r->itemDescription, 0, 120),
            'special_instruction' => mb_substr(trim(($r->orderNumber !== null ? "Order {$r->orderNumber}. " : '').($r->note ?? '')), 0, 255),
        ];
        if ($r->areaId !== null) {
            $body['recipient_area'] = self::idValue($r->areaId);
        }

        return $body;
    }

    /** grams → kg string with up to 3 decimals ("0.5", "1.25"). */
    private static function kg(int $grams): string
    {
        $kg = intdiv($grams, 1000).'.'.str_pad((string) ($grams % 1000), 3, '0', STR_PAD_LEFT);

        return rtrim(rtrim($kg, '0'), '.');
    }

    private static function idValue(?string $id): int|string|null
    {
        return $id !== null && ctype_digit($id) ? (int) $id : $id;
    }

    /** VERIFY against sandbox: the info answer's status field (`order_status_slug` preferred over `order_status`). */
    private static function statusWord(array $data): ?string
    {
        return self::str($data, 'order_status_slug', 'order_status', 'status');
    }

    /** VERIFY against sandbox: collected cash field name (`collected_amount` / `cash_collected`). */
    private static function collected(array $data): ?int
    {
        foreach (['collected_amount', 'cash_collected', 'amount_collected'] as $field) {
            if (array_key_exists($field, $data)) {
                return self::paisa($data[$field]);
            }
        }

        return null;
    }

    private function result(array $d): BookingResult
    {
        $id = (string) self::str($d, 'consignment_id');
        $template = config('couriers.providers.pathao.tracking_url');

        return new BookingResult(
            consignmentId: $id,
            trackingCode: $id,
            trackingUrl: is_string($template) ? str_replace('{consignment_id}', rawurlencode($id), $template) : null,
            deliveryFeeAmount: self::paisa($d['delivery_fee'] ?? null),
            codChargeAmount: null,
            providerStatus: ($w = self::statusWord($d)) !== null ? self::key($w) : null,
            raw: CourierPayload::scrub($d),
        );
    }
}
