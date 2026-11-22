<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\CourierPayload;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Support\TenantCache;
use Carbon\CarbonImmutable;

/**
 * Deterministic courier for local, testing and e2e (COURIERS_FAKE=true; refused in production). CourierManager binds
 * one per provider, so capabilities, areas and webhook support mirror the real courier (Steadfast: no areas; RedX: no
 * webhooks; no courier has a cancel API).
 *
 * Raw statuses ARE the normalised words (`picked_up`, `in_transit`, `delivered`, ...); `settled` marks COD paid
 * out; anything else → problem `unknown`.
 *
 * Booking (no HTTP): consignment `FK` + 10 hex chars of sha256(provider|invoice) (same invoice → same parcel),
 * tracking code = consignment, delivery fee ৳ 60, status `booked`. Markers in the note, item description, recipient
 * name or address change the outcome:
 *   `fake:reject`  → courier_rejected ("Fake courier rejected the address.", field recipient_address);
 *   `fake:timeout` → the parcel IS created, then provider_unavailable (findByInvoice() finds it: reconcile path);
 *   `fake:down`    → provider_unavailable, nothing created.
 * Credentials: any value starting with "invalid" → credentials_invalid (field = that key); "unavailable" →
 * provider_unavailable. Steadfast reports a balance of ৳ 12,345.
 *
 * Moving a parcel: advance($shipment, $status, …) stores the new state (status() returns it from then on) and
 * returns the StatusUpdate; webhookPayload()/webhookHeaders() build a signed fake webhook call for the same change.
 * State lives in TenantCache under "couriers:fake:{provider}:…" for 30 days.
 */
final class FakeCourier implements CourierDriver
{
    public const DELIVERY_FEE = 6000;

    public const BALANCE = 1234500;

    private const TTL = 30 * 86400;

    public function __construct(
        private readonly string $provider,
        private readonly TenantCache $cache,
    ) {}

    public function provider(): string
    {
        return $this->provider;
    }

    public static function statusMap(): array
    {
        $map = [];
        foreach (Shipment::COURIER_STATUSES as $status) {
            $map[$status] = NormalisedStatus::of($status);
        }
        $map['settled'] = new NormalisedStatus(null, null, true);

        return $map;
    }

    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        return self::statusMap()[strtolower(trim($rawStatus))] ?? NormalisedStatus::unknown();
    }

    public function capabilities(): array
    {
        return match ($this->provider) {
            CourierAccount::STEADFAST => ['bulk', 'webhook'],
            CourierAccount::PATHAO => ['bulk', 'areas', 'webhook'],
            default => ['bulk', 'areas'],
        };
    }

    public function supportsWebhooks(): bool
    {
        return $this->provider !== CourierAccount::REDX;
    }

    public function checkCredentials(CourierAccount $account): CredentialCheck
    {
        foreach ((array) $account->credentials as $key => $value) {
            $value = strtolower((string) $value);
            if (str_starts_with($value, 'invalid')) {
                throw new CourierException(CourierException::CREDENTIALS_INVALID, 'Fake courier rejected the credentials.', (string) $key);
            }
            if (str_starts_with($value, 'unavailable')) {
                throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Fake courier is unavailable.');
            }
        }

        return new CredentialCheck(true, $this->provider === CourierAccount::STEADFAST ? self::BALANCE : null);
    }

    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult
    {
        $text = strtolower(implode(' ', [$request->note, $request->itemDescription, $request->recipientName, $request->recipientAddress]));
        if (str_contains($text, 'fake:reject')) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Fake courier rejected the address.', 'recipient_address');
        }
        if (str_contains($text, 'fake:down')) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Fake courier is unavailable.');
        }
        if ($this->provider !== CourierAccount::STEADFAST && $request->areaId === null && $request->zoneId === null) {
            throw new CourierException(CourierException::COURIER_REJECTED, 'Choose the courier’s delivery area for this address.', 'area');
        }

        $consignment = self::consignmentFor($this->provider, $request->invoice);
        $now = CarbonImmutable::now()->startOfSecond();
        $this->cache->put($this->key("invoice:{$request->invoice}"), $consignment, self::TTL);
        $this->putParcel($consignment, [
            'invoice' => $request->invoice,
            'status' => Shipment::BOOKED,
            'cod_amount' => $request->codAmount,
            'cod_collected_amount' => null,
            'description' => 'Parcel booked',
            'location' => null,
            'updated_at' => $now->toIso8601ZuluString(),
        ]);
        if (str_contains($text, 'fake:timeout')) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Fake courier timed out (the parcel was created).');
        }

        return $this->result($consignment);
    }

    public function bookBulk(CourierAccount $account, array $requests): array
    {
        $out = [];
        foreach ($requests as $key => $request) {
            $shipment = new Shipment;
            $shipment->id = $request->invoice;
            try {
                $out[$key] = $this->book($shipment, $account, $request);
            } catch (CourierException $e) {
                $out[$key] = $e;
            }
        }

        return $out;
    }

    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate
    {
        $parcel = $shipment->consignment_id !== null ? $this->parcel($shipment->consignment_id) : null;
        if ($parcel === null) {
            // Unknown to the fake (e.g. cache cleared): report what we already have.
            $raw = in_array($shipment->status, Shipment::COURIER_STATUSES, true) ? $shipment->status : Shipment::BOOKED;

            return StatusUpdate::from($this->normalise($raw), $raw, CarbonImmutable::now()->startOfSecond());
        }

        return $this->updateFrom($parcel);
    }

    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult
    {
        $consignment = $this->cache->get($this->key("invoice:{$invoice}"));

        return is_string($consignment) && $this->parcel($consignment) !== null ? $this->result($consignment) : null;
    }

    public function cancel(Shipment $shipment, CourierAccount $account): void
    {
        throw new CourierException(CourierException::CANCEL_UNSUPPORTED, 'This courier has no cancel API.');
    }

    /**
     * Auth like the real courier: Steadfast `Authorization: Bearer {secret}`, Pathao `X-PATHAO-Signature: {secret}`
     * (either header is accepted for both). RedX: refused (polling only).
     * Payload: `{ event_id?, event?, consignment_id, invoice?, status, occurred_at?, description?, location?,
     * cod_collected_amount? (paisa) }`; `event: "webhook_integration"` → null (ack only).
     */
    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData
    {
        if (! $this->supportsWebhooks()) {
            throw new CourierException(CourierException::WEBHOOK_UNAUTHORIZED, 'This courier has no webhooks.');
        }
        $auth = self::header($headers, 'Authorization');
        $bearer = $auth !== null && preg_match('/^Bearer\s+(\S+)$/i', trim($auth), $m) === 1 ? $m[1] : null;
        $presented = $bearer ?? self::header($headers, 'X-PATHAO-Signature');
        if (! $account->webhookSecretMatches($presented)) {
            throw new CourierException(CourierException::WEBHOOK_UNAUTHORIZED, 'Fake webhook secret missing or wrong.');
        }
        if (($payload['event'] ?? null) === 'webhook_integration') {
            return null;
        }

        $consignment = is_scalar($payload['consignment_id'] ?? null) ? (string) $payload['consignment_id'] : null;
        $invoice = is_scalar($payload['invoice'] ?? null) ? (string) $payload['invoice'] : null;
        $raw = is_string($payload['status'] ?? null) ? strtolower($payload['status']) : null;
        $occurred = is_string($payload['occurred_at'] ?? null) ? CarbonImmutable::parse($payload['occurred_at'])->utc() : CarbonImmutable::now()->startOfSecond();
        $eventId = is_string($payload['event_id'] ?? null) && $payload['event_id'] !== ''
            ? $payload['event_id']
            : hash('sha256', implode('|', [$consignment, $invoice, $raw, $occurred->toIso8601ZuluString()]));
        $scrubbed = CourierPayload::scrub($payload);
        $update = $raw === null ? null : StatusUpdate::from(
            $this->normalise($raw),
            $raw,
            $occurred,
            is_string($payload['description'] ?? null) ? $payload['description'] : null,
            is_string($payload['location'] ?? null) ? $payload['location'] : null,
            is_int($payload['cod_collected_amount'] ?? null) ? $payload['cod_collected_amount'] : null,
            $scrubbed,
        );

        return new WebhookEventData($eventId, $consignment, $invoice, is_string($payload['event'] ?? null) ? $payload['event'] : 'status', $update, $scrubbed);
    }

    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        $data = match ($this->provider) {
            CourierAccount::PATHAO => [
                'city' => [null => [['1', 'Dhaka'], ['2', 'Chattogram']]],
                'zone' => ['1' => [['11', 'Dhanmondi'], ['12', 'Mirpur'], ['13', 'Gulshan']], '2' => [['21', 'Panchlaish'], ['22', 'Kotwali']]],
                'area' => ['11' => [['111', 'Dhanmondi 27'], ['112', 'Jigatola']], '12' => [['121', 'Mirpur 10'], ['122', 'Pallabi']],
                    '13' => [['131', 'Gulshan 1']], '21' => [['211', 'GEC']], '22' => [['221', 'Anderkilla']]],
            ],
            CourierAccount::REDX => [
                'area' => [null => [['1001', 'Dhanmondi'], ['1002', 'Mirpur'], ['1003', 'Gulshan'], ['2001', 'Panchlaish'], ['2002', 'Kotwali']]],
            ],
            default => [],
        };
        $rows = $data[$level][$this->provider === CourierAccount::REDX || $level === 'city' ? null : (string) $parentId] ?? [];

        return array_map(fn (array $r) => new CourierArea($r[0], $r[1], $level, $level === 'city' || $this->provider === CourierAccount::REDX ? null : $parentId), $rows);
    }

    public function pickupStores(CourierAccount $account): array
    {
        return match ($this->provider) {
            CourierAccount::PATHAO => [new PickupStore('9001', 'Fake Pathao store', 'House 1, Road 2, Dhanmondi')],
            CourierAccount::REDX => [new PickupStore('7001', 'Fake RedX pickup', 'House 1, Road 2, Dhanmondi')],
            default => [],
        };
    }

    // ---------------------------------------------------------------- test/dev controls

    /**
     * Move a fake parcel (couriers:fake-advance, the testing endpoint, tests). `$status` is a normalised word (or
     * `settled`). For `delivered` the collected amount defaults to the parcel's COD; for `partially_delivered` to
     * half of it. Returns the StatusUpdate that status() reports from now on (apply it with ShipmentSync).
     */
    public function advance(Shipment $shipment, string $status, ?int $codCollectedAmount = null, ?string $description = null, ?string $location = null, ?CarbonImmutable $at = null): StatusUpdate
    {
        $consignment = $shipment->consignment_id ?? throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, 'Shipment has no consignment id.');
        $parcel = $this->parcel($consignment) ?? ['invoice' => $shipment->id, 'cod_amount' => $shipment->cod_amount];
        $cod = (int) ($parcel['cod_amount'] ?? $shipment->cod_amount);
        $codCollectedAmount ??= match ($status) {
            Shipment::DELIVERED => $cod,
            Shipment::PARTIALLY_DELIVERED => intdiv($cod, 2),
            default => $parcel['cod_collected_amount'] ?? null,
        };
        $parcel = array_merge($parcel, [
            'status' => strtolower($status),
            'cod_collected_amount' => $codCollectedAmount,
            'description' => $description ?? ucfirst(str_replace('_', ' ', strtolower($status))),
            'location' => $location,
            'updated_at' => ($at ?? CarbonImmutable::now()->startOfSecond())->utc()->toIso8601ZuluString(),
        ]);
        $this->putParcel($consignment, $parcel);

        return $this->updateFrom($parcel);
    }

    /** JSON body of a fake webhook for the parcel's current state (or $status). Send with webhookHeaders(). */
    public function webhookPayload(Shipment $shipment, ?string $status = null): array
    {
        $parcel = $shipment->consignment_id !== null ? $this->parcel($shipment->consignment_id) : null;

        return array_filter([
            'consignment_id' => $shipment->consignment_id,
            'invoice' => $shipment->id,
            'status' => $status ?? ($parcel['status'] ?? $shipment->status),
            'occurred_at' => $parcel['updated_at'] ?? CarbonImmutable::now()->startOfSecond()->toIso8601ZuluString(),
            'description' => $parcel['description'] ?? null,
            'location' => $parcel['location'] ?? null,
            'cod_collected_amount' => $parcel['cod_collected_amount'] ?? null,
        ], fn ($v) => $v !== null);
    }

    /** @return array<string, string> headers the fake (and the real courier) authenticates with */
    public static function webhookHeaders(string $provider, string $secret): array
    {
        return $provider === CourierAccount::PATHAO ? ['X-PATHAO-Signature' => $secret] : ['Authorization' => 'Bearer '.$secret];
    }

    public static function consignmentFor(string $provider, string $invoice): string
    {
        return 'FK'.strtoupper(substr(hash('sha256', $provider.'|'.$invoice), 0, 10));
    }

    // ---------------------------------------------------------------- internals

    private function updateFrom(array $parcel): StatusUpdate
    {
        $raw = (string) $parcel['status'];

        return StatusUpdate::from(
            $this->normalise($raw),
            $raw,
            CarbonImmutable::parse((string) $parcel['updated_at'])->utc(),
            is_string($parcel['description'] ?? null) ? $parcel['description'] : null,
            is_string($parcel['location'] ?? null) ? $parcel['location'] : null,
            is_int($parcel['cod_collected_amount'] ?? null) ? $parcel['cod_collected_amount'] : null,
            ['status' => $raw, 'updated_at' => $parcel['updated_at']],
        );
    }

    private function result(string $consignment): BookingResult
    {
        return new BookingResult(
            consignmentId: $consignment,
            trackingCode: $consignment,
            trackingUrl: null,
            deliveryFeeAmount: self::DELIVERY_FEE,
            codChargeAmount: null,
            providerStatus: Shipment::BOOKED,
            raw: ['consignment_id' => $consignment, 'status' => Shipment::BOOKED, '_fake' => true],
        );
    }

    private function parcel(string $consignment): ?array
    {
        $p = $this->cache->get($this->key("parcel:{$consignment}"));

        return is_array($p) ? $p : null;
    }

    private function putParcel(string $consignment, array $parcel): void
    {
        $this->cache->put($this->key("parcel:{$consignment}"), $parcel, self::TTL);
    }

    private function key(string $suffix): string
    {
        return "couriers:fake:{$this->provider}:{$suffix}";
    }

    private static function header(array $headers, string $name): ?string
    {
        foreach ($headers as $key => $value) {
            if (strtolower((string) $key) === strtolower($name)) {
                $value = is_array($value) ? ($value[0] ?? null) : $value;

                return is_string($value) ? $value : null;
            }
        }

        return null;
    }
}
