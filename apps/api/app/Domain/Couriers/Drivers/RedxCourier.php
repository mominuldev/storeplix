<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\CourierPayload;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Http\Client\PendingRequest;

/**
 * RedX OpenAPI `v1.0.0-beta` (PHASE-5B §6.3; secondary sources: the OpenAPI files mirrored on apis.io). EVERYTHING
 * VERIFY against sandbox. Header `API-ACCESS-TOKEN: Bearer {token}`. Webhooks unverified: polling only, so
 * supportsWebhooks() is false and parseWebhook() refuses every call.
 */
final class RedxCourier extends HttpCourierDriver
{
    /** §6.3 expected status words (VERIFY against sandbox). */
    public static function statusMap(): array
    {
        return [
            'pickup-pending' => NormalisedStatus::of(Shipment::BOOKED),
            'ready-for-delivery' => NormalisedStatus::of(Shipment::IN_TRANSIT),
            'agent-area-change' => NormalisedStatus::of(Shipment::IN_TRANSIT),
            'delivery-in-progress' => NormalisedStatus::of(Shipment::OUT_FOR_DELIVERY),
            'delivered' => NormalisedStatus::of(Shipment::DELIVERED),
            'agent-hold' => NormalisedStatus::of(Shipment::ON_HOLD),
            'agent-returning' => NormalisedStatus::of(Shipment::RETURNING),
            'returned' => NormalisedStatus::of(Shipment::RETURNED),
        ];
    }

    public function capabilities(): array
    {
        return ['bulk', 'areas'];
    }

    public function supportsWebhooks(): bool
    {
        return false;
    }

    /** P5B-31: `GET /areas` with the token (VERIFY against sandbox). */
    public function checkCredentials(CourierAccount $account): CredentialCheck
    {
        $response = $this->send($this->api($account), 'GET', 'areas', [], 'areas', $account);
        if (in_array($response->status(), [401, 403], true) || ! $response->successful()) {
            throw new CourierException(CourierException::CREDENTIALS_INVALID, "redx areas rejected (HTTP {$response->status()}).");
        }

        return new CredentialCheck(true);
    }

    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult
    {
        if ($request->areaId === null) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Choose the RedX delivery area for this address.', 'area');
        }
        $response = $this->send($this->api($account), 'POST', 'parcel', $this->parcelBody($request), 'create_parcel', $account, ['shipment_id' => $request->invoice]);
        $body = self::json($response);
        if (in_array($response->status(), [401, 403], true)) {
            throw new CourierException(CourierException::CREDENTIALS_INVALID, 'redx create_parcel unauthorised.');
        }
        $tracking = self::str($body, 'tracking_id');
        if (! $response->successful() || $tracking === null) {
            throw self::rejection($body, 'RedX rejected the parcel.');
        }

        return $this->result(['tracking_id' => $tracking] + $body);
    }

    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate
    {
        $id = $shipment->consignment_id ?? throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Shipment has no tracking id.');
        $response = $this->send($this->api($account), 'GET', 'parcel/info/'.rawurlencode($id), [], 'parcel_info', $account, ['shipment_id' => $shipment->id]);
        $parcel = self::json($response)['parcel'] ?? null;
        $raw = is_array($parcel) ? self::str($parcel, 'status') : null;
        if (! $response->successful() || $raw === null) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "redx parcel_info returned HTTP {$response->status()}.");
        }
        $word = self::key($raw);

        return StatusUpdate::from(
            $this->normalise($word, $shipment),
            $word,
            self::time(null),
            codCollectedAmount: $word === 'delivered' ? self::paisa($parcel['cash_collection_amount'] ?? null) : null,
            raw: CourierPayload::scrub($parcel),
        );
    }

    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        return self::statusMap()[self::key($rawStatus)] ?? NormalisedStatus::unknown();
    }

    /**
     * VERIFY against sandbox: no documented lookup by merchant_invoice_id. Assumed
     * `GET /parcels?merchant_invoice_id={invoice}` returning `parcels[]`.
     */
    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult
    {
        $response = $this->send($this->api($account), 'GET', 'parcels', ['merchant_invoice_id' => $invoice], 'find_by_invoice', $account, ['shipment_id' => $invoice]);
        if (in_array($response->status(), [400, 404, 422], true)) {
            return null;
        }
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "redx find_by_invoice returned HTTP {$response->status()}.");
        }
        $rows = self::json($response)['parcels'] ?? [];
        foreach (is_array($rows) ? $rows : [] as $row) {
            if (is_array($row) && (string) ($row['merchant_invoice_id'] ?? '') === $invoice && self::str($row, 'tracking_id') !== null) {
                return $this->result($row);
            }
        }

        return null;
    }

    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData
    {
        throw new CourierException(CourierException::WEBHOOK_UNAUTHORIZED, 'RedX webhooks are not verified yet; RedX parcels are polled.');
    }

    /** RedX has one flat area list (level `area`); city/zone → []. */
    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        if ($level !== 'area') {
            return [];
        }
        $response = $this->send($this->api($account), 'GET', 'areas', [], 'areas', $account);
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "redx areas returned HTTP {$response->status()}.");
        }
        $out = [];
        foreach ((array) (self::json($response)['areas'] ?? []) as $row) {
            if (is_array($row) && self::str($row, 'id') !== null && self::str($row, 'name') !== null) {
                $out[] = new CourierArea((string) self::str($row, 'id'), (string) self::str($row, 'name'), 'area', null);
            }
        }

        return $out;
    }

    public function pickupStores(CourierAccount $account): array
    {
        $response = $this->send($this->api($account), 'GET', 'pickup/stores', [], 'pickup_stores', $account);
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "redx pickup_stores returned HTTP {$response->status()}.");
        }
        $out = [];
        foreach ((array) (self::json($response)['pickup_stores'] ?? []) as $row) {
            if (is_array($row) && self::str($row, 'id') !== null) {
                $out[] = new PickupStore((string) self::str($row, 'id'), (string) (self::str($row, 'name') ?? ''), self::str($row, 'address'));
            }
        }

        return $out;
    }

    protected function provider(): string
    {
        return CourierAccount::REDX;
    }

    /** "Ready for Delivery" / "ready_for_delivery" → "ready-for-delivery". */
    public static function key(string $raw): string
    {
        return trim((string) preg_replace('/[\s_\-]+/', '-', strtolower(trim($raw))), '-');
    }

    /** VERIFY against sandbox: the header carries "Bearer {token}" as its value (not the Authorization header). */
    private function api(CourierAccount $account): PendingRequest
    {
        return $this->client($account)->asJson()->withHeaders([
            'API-ACCESS-TOKEN' => 'Bearer '.(string) ($account->credentials['access_token'] ?? ''),
        ]);
    }

    /** @return array<string, mixed> */
    private function parcelBody(BookingRequest $r): array
    {
        $body = [
            'customer_name' => mb_substr($r->recipientName, 0, 100),
            'customer_phone' => self::localPhone($r->recipientPhone),
            'delivery_area' => (string) ($r->areaName ?? $r->thana),
            'delivery_area_id' => ctype_digit((string) $r->areaId) ? (int) $r->areaId : $r->areaId,
            'customer_address' => $r->fullAddress(250),
            'merchant_invoice_id' => $r->invoice,
            'cash_collection_amount' => self::taka($r->codAmount),
            'parcel_weight' => $r->weightGrams,
            'value' => intdiv($r->declaredValueAmount ?? $r->codAmount, 100),
            'instruction' => mb_substr(trim(($r->orderNumber !== null ? "Order {$r->orderNumber}. " : '').($r->note ?? '')), 0, 255),
        ];
        if ($r->providerStoreId !== null) {
            $body['pickup_store_id'] = ctype_digit($r->providerStoreId) ? (int) $r->providerStoreId : $r->providerStoreId;
        }

        return $body;
    }

    private function result(array $d): BookingResult
    {
        $id = (string) self::str($d, 'tracking_id');
        $template = config('couriers.providers.redx.tracking_url');

        return new BookingResult(
            consignmentId: $id,
            trackingCode: $id,
            trackingUrl: is_string($template) ? str_replace('{tracking_code}', rawurlencode($id), $template) : null,
            deliveryFeeAmount: self::paisa($d['charge'] ?? null),
            codChargeAmount: null,
            providerStatus: ($w = self::str($d, 'status')) !== null ? self::key($w) : null,
            raw: CourierPayload::scrub($d),
        );
    }
}
