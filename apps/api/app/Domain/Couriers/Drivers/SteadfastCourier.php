<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\CourierPayload;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use Illuminate\Http\Client\PendingRequest;

/**
 * Steadfast (PHASE-5B §6.1; official Postman collection "SteadFast API Documentation", 2024-12-26; webhook and the
 * status list from the `steadfast-it` Laravel package). Base `https://portal.packzy.com/api/v1`, headers `Api-Key`,
 * `Secret-Key`. No sandbox: both modes use the one base URL. No cancel and no area API.
 */
final class SteadfastCourier extends HttpCourierDriver
{
    /** §6.1 mapping (context-free form; see normalise() for `pending` after `in_review` and `cancelled` after pickup). */
    public static function statusMap(): array
    {
        return [
            'in_review' => NormalisedStatus::of(Shipment::BOOKED),
            'pending' => NormalisedStatus::of(Shipment::BOOKED),
            'hold' => NormalisedStatus::of(Shipment::ON_HOLD),
            'delivered_approval_pending' => NormalisedStatus::of(Shipment::DELIVERED),
            'delivered' => NormalisedStatus::of(Shipment::DELIVERED),
            'partial_delivered_approval_pending' => NormalisedStatus::of(Shipment::PARTIALLY_DELIVERED),
            'partial_delivered' => NormalisedStatus::of(Shipment::PARTIALLY_DELIVERED),
            'cancelled_approval_pending' => NormalisedStatus::of(Shipment::CANCELLED),
            'cancelled' => NormalisedStatus::of(Shipment::CANCELLED),
            'unknown_approval_pending' => NormalisedStatus::unknown(),
            'unknown' => NormalisedStatus::unknown(),
        ];
    }

    /**
     * Steadfast has no explicit "picked up" status in the public list (VERIFY against sandbox): `pending` seen after
     * `in_review` (or once the parcel already moved) = picked up → `in_transit`. `cancelled*` after pickup = the
     * parcel is coming back → `returning`.
     */
    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        $raw = strtolower(trim($rawStatus));
        $mapped = parent::normalise($raw, $shipment);
        if ($shipment === null) {
            return $mapped;
        }
        if ($raw === 'pending' && ($shipment->provider_status === 'in_review' || $shipment->wasPickedUp())) {
            return NormalisedStatus::of(Shipment::IN_TRANSIT);
        }
        if (in_array($raw, ['cancelled', 'cancelled_approval_pending'], true) && $shipment->wasPickedUp()) {
            return NormalisedStatus::of(Shipment::RETURNING);
        }

        return $mapped;
    }

    public function capabilities(): array
    {
        return ['bulk', 'webhook'];
    }

    public function supportsWebhooks(): bool
    {
        return true;
    }

    public function checkCredentials(CourierAccount $account): CredentialCheck
    {
        $response = $this->send($this->api($account), 'GET', 'get_balance', [], 'get_balance', $account);
        $body = self::json($response);
        if (in_array($response->status(), [401, 403], true) || ! $response->successful() || ! array_key_exists('current_balance', $body)) {
            throw new CourierException(CourierException::CREDENTIALS_INVALID, "steadfast get_balance rejected (HTTP {$response->status()}).");
        }

        return new CredentialCheck(true, self::paisa($body['current_balance']));
    }

    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult
    {
        $response = $this->send($this->api($account), 'POST', 'create_order', $this->orderBody($request), 'create_order', $account, ['shipment_id' => $request->invoice]);
        $body = self::json($response);
        $consignment = is_array($body['consignment'] ?? null) ? $body['consignment'] : null;
        if (! $response->successful() || $consignment === null || self::str($consignment, 'consignment_id') === null) {
            if (in_array($response->status(), [401, 403], true)) {
                throw new CourierException(CourierException::CREDENTIALS_INVALID, 'steadfast create_order unauthorised.');
            }
            throw self::rejection($body, 'Steadfast rejected the parcel.');
        }

        return $this->result($consignment);
    }

    /** Bulk endpoint, ≤ 500 orders per request (§6.1). The answer is matched back to the input by invoice. */
    public function bookBulk(CourierAccount $account, array $requests): array
    {
        $out = [];
        $chunk = max(1, (int) config('couriers.providers.steadfast.bulk_chunk', 500));
        foreach (array_chunk($requests, $chunk, true) as $part) {
            $byInvoice = [];
            foreach ($part as $key => $request) {
                $byInvoice[$request->invoice] = $key;
            }
            try {
                $response = $this->send($this->api($account), 'POST', 'create_order/bulk-order', $this->bulkBody($part), 'bulk_order', $account, ['count' => count($part)]);
                $rows = $this->bulkRows(self::json($response));
                if (! $response->successful() || $rows === null) {
                    $error = in_array($response->status(), [401, 403], true)
                        ? new CourierException(CourierException::CREDENTIALS_INVALID, 'steadfast bulk-order unauthorised.')
                        : self::rejection(self::json($response), 'Steadfast rejected the bulk order.');
                    foreach ($part as $key => $_) {
                        $out[$key] = $error;
                    }

                    continue;
                }
            } catch (CourierException $e) {
                foreach ($part as $key => $_) {
                    $out[$key] = $e;
                }

                continue;
            }
            foreach ($rows as $row) {
                $key = $byInvoice[(string) ($row['invoice'] ?? '')] ?? null;
                if ($key === null) {
                    continue;
                }
                $ok = ($row['status'] ?? null) === 'success' && self::str($row, 'consignment_id') !== null;
                $out[$key] = $ok ? $this->result($row)
                    : new CourierException(CourierException::COURIER_REJECTED, CourierException::sanitise((string) (is_string($row['error'] ?? null) ? $row['error'] : 'Steadfast rejected the parcel.')));
            }
            foreach ($part as $key => $_) {
                // Not in the answer: outcome unknown (reconcile by invoice).
                $out[$key] ??= new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'steadfast bulk-order returned no row for this invoice.');
            }
        }

        return $out;
    }

    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate
    {
        $id = $shipment->consignment_id ?? throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Shipment has no consignment id.');
        $response = $this->send($this->api($account), 'GET', 'status_by_cid/'.rawurlencode($id), [], 'status_by_cid', $account, ['shipment_id' => $shipment->id]);
        $body = self::json($response);
        $raw = self::str($body, 'delivery_status');
        if (! $response->successful() || $raw === null) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "steadfast status_by_cid returned HTTP {$response->status()}.");
        }

        return StatusUpdate::from($this->normalise($raw, $shipment), strtolower($raw), self::time(null), raw: CourierPayload::scrub($body));
    }

    /**
     * VERIFY against sandbox: `GET /trackings_by_invoice/{invoice}` (P5B-33) — the answer shape is not documented; the
     * consignment is read from `consignment`, `data` (object or first element) or the root.
     */
    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult
    {
        $response = $this->send($this->api($account), 'GET', 'trackings_by_invoice/'.rawurlencode($invoice), [], 'trackings_by_invoice', $account, ['shipment_id' => $invoice]);
        if ($response->status() === 404) {
            return null;
        }
        $body = self::json($response);
        if (! $response->successful()) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "steadfast trackings_by_invoice returned HTTP {$response->status()}.");
        }
        foreach ([$body['consignment'] ?? null, $body['data'][0] ?? null, $body['data'] ?? null, $body] as $candidate) {
            if (is_array($candidate) && self::str($candidate, 'consignment_id') !== null) {
                return $this->result($candidate + ['status' => $body['delivery_status'] ?? null]);
            }
        }

        return null;
    }

    /**
     * Webhook (P5B-37; payload and header from the steadfast-it package — VERIFY against sandbox):
     * `Authorization: Bearer {secret we issued}`; JSON `{ notification_type?, consignment_id, invoice, status,
     * cod_amount, delivery_charge?, tracking_message?, updated_at }`. `tracking_update` notifications carry no status:
     * stored and acknowledged only.
     */
    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData
    {
        $auth = (string) self::header($headers, 'Authorization');
        $token = preg_match('/^Bearer\s+(\S+)$/i', trim($auth), $m) === 1 ? $m[1] : null;
        if (! $account->webhookSecretMatches($token)) {
            throw new CourierException(CourierException::WEBHOOK_UNAUTHORIZED, 'steadfast webhook bearer missing or wrong.');
        }

        $consignment = self::str($payload, 'consignment_id');
        $invoice = self::str($payload, 'invoice');
        $type = self::str($payload, 'notification_type') ?? 'delivery_status';
        $raw = self::str($payload, 'status', 'delivery_status');
        $updatedAt = self::str($payload, 'updated_at');
        $eventId = hash('sha256', implode('|', [$consignment, $invoice, $type, $raw, $updatedAt, self::str($payload, 'tracking_message')]));
        $scrubbed = CourierPayload::scrub($payload);
        if ($consignment === null && $invoice === null) {
            return new WebhookEventData($eventId, null, null, $type, null, $scrubbed);
        }

        $update = null;
        if ($raw !== null) {
            $rawStatus = self::webhookStatus($raw);
            $update = StatusUpdate::from(
                $this->normalise($rawStatus),
                $rawStatus,
                self::time($updatedAt),
                description: self::str($payload, 'tracking_message'),
                codCollectedAmount: in_array($rawStatus, ['delivered', 'partial_delivered'], true) ? self::paisa($payload['cod_amount'] ?? null) : null,
                raw: $scrubbed,
            );
        }

        return new WebhookEventData($eventId, $consignment, $invoice, $type, $update, $scrubbed);
    }

    /** VERIFY against sandbox: the package sends "Delivered" / "Partial Delivered"; the API words are snake_case. */
    private static function webhookStatus(string $raw): string
    {
        return (string) preg_replace('/[\s\-]+/', '_', strtolower(trim($raw)));
    }

    protected function provider(): string
    {
        return CourierAccount::STEADFAST;
    }

    private function api(CourierAccount $account): PendingRequest
    {
        $c = $account->credentials;

        return $this->client($account)->asJson()->withHeaders([
            'Api-Key' => (string) ($c['api_key'] ?? ''),
            'Secret-Key' => (string) ($c['secret_key'] ?? ''),
        ]);
    }

    /** @return array<string, mixed> */
    private function orderBody(BookingRequest $r): array
    {
        $body = [
            'invoice' => $r->invoice,
            'recipient_name' => mb_substr($r->recipientName, 0, 100),
            'recipient_phone' => self::localPhone($r->recipientPhone),
            'recipient_address' => $r->fullAddress(250),
            'cod_amount' => $r->codAmount % 100 === 0 ? intdiv($r->codAmount, 100) : self::taka($r->codAmount),
            'note' => mb_substr(trim(($r->orderNumber !== null ? "Order {$r->orderNumber}. " : '').($r->note ?? '')), 0, 255),
            'item_description' => mb_substr($r->itemDescription, 0, 120),
        ];
        if ($r->recipientEmail !== null) {
            $body['recipient_email'] = $r->recipientEmail;
        }

        return $body;
    }

    /**
     * VERIFY against sandbox: the collection sends `data` as a JSON-encoded array of orders.
     *
     * @param  array<array-key, BookingRequest>  $requests
     */
    private function bulkBody(array $requests): array
    {
        return ['data' => json_encode(array_values(array_map(fn (BookingRequest $r) => $this->orderBody($r), $requests)), JSON_UNESCAPED_UNICODE)];
    }

    /** VERIFY against sandbox: the bulk answer is a list of rows (root or `data`) with invoice + status success|error. */
    private function bulkRows(array $body): ?array
    {
        $rows = array_is_list($body) ? $body : ($body['data'] ?? null);

        return is_array($rows) && array_is_list($rows) ? array_values(array_filter($rows, 'is_array')) : null;
    }

    private function result(array $c): BookingResult
    {
        $tracking = self::str($c, 'tracking_code') ?? (string) self::str($c, 'consignment_id');
        $template = config('couriers.providers.steadfast.tracking_url');

        return new BookingResult(
            consignmentId: (string) self::str($c, 'consignment_id'),
            trackingCode: $tracking,
            trackingUrl: is_string($template) ? str_replace('{tracking_code}', rawurlencode($tracking), $template) : null,
            deliveryFeeAmount: self::paisa($c['delivery_fee'] ?? $c['delivery_charge'] ?? null),
            codChargeAmount: null,
            providerStatus: self::str($c, 'status', 'delivery_status') !== null ? strtolower((string) self::str($c, 'status', 'delivery_status')) : null,
            raw: CourierPayload::scrub($c),
        );
    }
}
