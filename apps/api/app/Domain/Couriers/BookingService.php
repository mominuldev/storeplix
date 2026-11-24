<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\BookingRequest;
use App\Domain\Couriers\Drivers\BookingResult;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\CourierAreaMapping;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\OrderStateMachine;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Courier booking (PHASE-5B P5B-33…P5B-35, P5B-39…P5B-41, §6.4). No lock is ever held across the courier call:
 *  1. transaction 1 locks the order, checks state + "no active shipment" (also the partial unique index), and writes
 *     the shipment as `booking` (invoice = shipment id, P5B-34);
 *  2. the courier is called outside any transaction;
 *  3. transaction 2 writes `booked` + consignment/tracking/fees and moves the order `confirmed → ready_to_ship`.
 * Rejection → `booking_failed` + 422 `courier_rejected`. Timeout / unknown outcome → stays `booking` (201) and
 * `couriers:reconcile-bookings` finds the parcel by invoice or gives up after 10 minutes.
 */
class BookingService
{
    public const RECONCILE_GIVE_UP_MINUTES = 10;

    public const LABELS = ['steadfast' => 'Steadfast', 'pathao' => 'Pathao', 'redx' => 'RedX'];

    public function __construct(
        private readonly CourierManager $couriers,
        private readonly AuditLogger $audit,
        private readonly AreaMapper $areas,
    ) {}

    /**
     * POST /orders/{order}/shipments. Returns [shipment, replayed].
     *
     * @param  array{provider: string, pickup_location_id?: string|null, cod_amount?: int|null, weight_grams?: int|null, item_description?: string|null, note?: string|null, delivery_type?: int|null, area?: array{city_id?: string|null, zone_id?: string|null, area_id?: string|null}|null, remember_area?: bool}  $input
     */
    public function book(Store $store, Order $order, array $input, ?User $user, ?PermissionSet $permissions, ?string $idempotencyKey): Shipment
    {
        $account = $this->connectedAccount($store, $input['provider']);
        $override = array_key_exists('cod_amount', $input) && $input['cod_amount'] !== null;
        if ($override && ! ($permissions?->has(Permission::OrdersRefund) ?? false)) {
            // S33: only owners/admins may change what the rider collects.
            throw new ApiException(403, 'forbidden', 'You do not have permission to change the COD amount.');
        }

        [$shipment, $request, $fresh] = DB::transaction(function () use ($store, $order, $input, $account, $user, $idempotencyKey, $override) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($idempotencyKey !== null) {
                $existing = Shipment::query()->where('store_id', $store->id)->where('idempotency_key', $idempotencyKey)->first();
                if ($existing !== null) {
                    return [$existing, null, false];
                }
            }
            $this->assertBookable($o);
            if ($override && ((int) $input['cod_amount'] < 0 || (int) $input['cod_amount'] > $o->total_amount)) {
                throw ValidationException::withMessages(['cod_amount' => ['The COD amount must be between 0 and the order total.']]);
            }
            $area = $this->area($account, $o, $input['area'] ?? null, 'area');
            $shipment = $this->newShipment($o, $account, $input, $user, $idempotencyKey, null);
            if ($override) {
                $shipment->cod_amount = (int) $input['cod_amount'];
                $shipment->cod_overridden = $shipment->cod_amount !== $o->dueAmount();
            }
            $this->save($shipment);
            if (($input['remember_area'] ?? false) && $area !== null && ($input['area'] ?? null) !== null) {
                $this->remember($account, $o, $area);
            }
            OrderTimeline::record($o, 'shipment', $user, null, ['action' => 'booking', 'shipment_id' => $shipment->id, 'provider' => $account->provider]);

            return [$shipment, $this->request($o, $shipment, $account, $input, $area), true];
        });

        if (! $fresh) {
            return $shipment;
        }
        if ($shipment->cod_overridden) {
            $this->audit->log('shipment.cod_overridden', $shipment, ['order_id' => $order->id, 'cod_amount' => $shipment->cod_amount, 'due_amount' => $order->dueAmount()], $user);
        }

        return $this->call($shipment, $account, $request);
    }

    /** Courier call (outside any transaction) + transaction 2. */
    public function call(Shipment $shipment, CourierAccount $account, BookingRequest $request): Shipment
    {
        try {
            $result = $this->couriers->driver($account->provider)->book($shipment, $account, $request);
        } catch (CourierException $e) {
            if ($e->errorCode === CourierException::PROVIDER_UNAVAILABLE) {
                Log::warning('couriers.booking_unknown', ['shipment_id' => $shipment->id, 'provider' => $account->provider]);

                return $shipment->refresh(); // stays `booking`; couriers:reconcile-bookings finishes it
            }
            $this->fail($shipment, CourierException::sanitise($e->getMessage()));

            throw new ApiException($e->httpStatus() === 502 ? 422 : $e->httpStatus(), $e->errorCode === CourierException::NOT_CONNECTED ? 'gateway_not_connected' : 'courier_rejected',
                CourierException::sanitise($e->getMessage()), $e->field !== null ? [$e->field => [CourierException::sanitise($e->getMessage())]] : null);
        } catch (Throwable $e) {
            report($e);

            return $shipment->refresh(); // outcome unknown: reconcile by invoice
        }

        return $this->markBooked($shipment, $result, 'system');
    }

    /** Transaction 2 (also used by reconcile and bulk). Idempotent: only a `booking` row moves. */
    public function markBooked(Shipment $shipment, BookingResult $result, string $source = 'system'): Shipment
    {
        return DB::transaction(function () use ($shipment, $result, $source) {
            /** @var Order $o */
            $o = Order::query()->whereKey($shipment->order_id)->lockForUpdate()->firstOrFail();
            /** @var Shipment $s */
            $s = Shipment::query()->whereKey($shipment->id)->lockForUpdate()->firstOrFail();
            if ($s->status !== 'booking') {
                return $s;
            }
            $now = now();
            $s->forceFill([
                'status' => 'booked',
                'consignment_id' => mb_substr($result->consignmentId, 0, 64),
                'tracking_code' => mb_substr($result->trackingCode, 0, 64),
                'tracking_url' => $result->trackingUrl,
                'delivery_fee_amount' => $result->deliveryFeeAmount,
                'cod_charge_amount' => $result->codChargeAmount,
                'provider_status' => $result->providerStatus !== null ? mb_substr($result->providerStatus, 0, 48) : null,
                'booked_at' => $now,
                'last_event_at' => $now,
                'raw' => $result->raw !== [] ? $result->raw : null,
                'failure_reason' => null,
            ])->save();
            WebhookEvents::shipment($s);
            $event = new ShipmentEvent;
            $event->forceFill([
                'store_id' => $s->store_id, 'shipment_id' => $s->id, 'status' => 'booked',
                'provider_status' => $s->provider_status, 'description' => 'Booked with '.(self::LABELS[$s->provider] ?? $s->provider),
                'location' => null, 'source' => $source, 'occurred_at' => $now,
            ])->save();
            if ($o->status === Order::CONFIRMED) {
                OrderStateMachine::assert($o->status, Order::READY_TO_SHIP);
                $o->status = Order::READY_TO_SHIP;
                $o->revision++;
                $o->save();
                OrderTimeline::record($o, 'status_changed', null, null, ['shipment_id' => $s->id, 'provider' => $s->provider], Order::CONFIRMED, Order::READY_TO_SHIP, 'system');
            }
            OrderTimeline::record($o, 'shipment', null, null, [
                'action' => 'booked', 'shipment_id' => $s->id, 'provider' => $s->provider, 'consignment_id' => $s->consignment_id, 'tracking_code' => $s->tracking_code,
            ], actorType: 'system');

            return $s;
        });
    }

    /** A rejected booking frees the order (the partial unique index ignores booking_failed). */
    public function fail(Shipment $shipment, string $reason): Shipment
    {
        return DB::transaction(function () use ($shipment, $reason) {
            /** @var Shipment $s */
            $s = Shipment::query()->whereKey($shipment->id)->lockForUpdate()->firstOrFail();
            if ($s->status !== 'booking') {
                return $s;
            }
            $s->forceFill(['status' => 'booking_failed', 'failure_reason' => mb_substr($reason, 0, 255)])->save();
            WebhookEvents::shipment($s);
            $event = new ShipmentEvent;
            $event->forceFill([
                'store_id' => $s->store_id, 'shipment_id' => $s->id, 'status' => 'booking_failed', 'provider_status' => null,
                'description' => mb_substr($reason, 0, 255), 'location' => null, 'source' => 'system', 'occurred_at' => now(),
            ])->save();
            $order = Order::query()->findOrFail($s->order_id);
            OrderTimeline::record($order, 'shipment', null, $reason, ['action' => 'booking_failed', 'shipment_id' => $s->id, 'provider' => $s->provider], actorType: 'system');

            return $s;
        });
    }

    /**
     * couriers:reconcile-bookings (P5B-33): a `booking` row older than a minute is looked up by our invoice; found →
     * booked; not found after 10 minutes → booking_failed; courier down → try again next run.
     */
    public function reconcile(Shipment $shipment): Shipment
    {
        if ($shipment->status !== 'booking') {
            return $shipment;
        }
        $account = CourierAccount::query()->whereKey($shipment->courier_account_id)->first();
        if ($account === null) {
            return $this->fail($shipment, 'The courier account was disconnected.');
        }
        try {
            $found = $this->couriers->driver($account->provider)->findByInvoice($shipment->id, $account);
        } catch (CourierException $e) {
            Log::info('couriers.reconcile_deferred', ['shipment_id' => $shipment->id, 'code' => $e->errorCode]);

            return $shipment;
        }
        if ($found !== null) {
            return $this->markBooked($shipment, $found, 'system');
        }
        if ($shipment->created_at !== null && $shipment->created_at->lte(now()->subMinutes(self::RECONCILE_GIVE_UP_MINUTES))) {
            return $this->fail($shipment, 'The courier has no record of this parcel. Book it again.');
        }

        return $shipment;
    }

    /** POST /shipments/{shipment}/cancel (P5B-41): only while `booked`; the driver may not support it. */
    public function cancel(Shipment $shipment, ?string $reason, ?User $user): Shipment
    {
        $this->assertCancellable($shipment);
        $account = CourierAccount::query()->whereKey($shipment->courier_account_id)->first()
            ?? throw new ApiException(422, 'gateway_not_connected', 'This courier is not connected.');
        try {
            $this->couriers->driver($account->provider)->cancel($shipment, $account);
        } catch (CourierException $e) {
            if ($e->errorCode === CourierException::CANCEL_UNSUPPORTED) {
                $label = self::LABELS[$shipment->provider] ?? $shipment->provider;
                throw new ApiException(409, 'courier_cancel_unsupported', "Cancel it in the {$label} panel, then mark it cancelled here.");
            }
            if ($e->errorCode === CourierException::PROVIDER_UNAVAILABLE) {
                throw new ApiException(502, 'provider_unavailable', 'The courier is not answering. Try again in a few minutes.');
            }
            throw new ApiException(422, 'courier_rejected', CourierException::sanitise($e->getMessage()));
        }

        return $this->cancelled($shipment, $reason, $user, 'cancelled');
    }

    /** POST /shipments/{shipment}/mark-cancelled: recorded after cancelling in the courier panel; only from `booked`. */
    public function markCancelled(Shipment $shipment, ?string $note, ?User $user): Shipment
    {
        $this->assertCancellable($shipment);

        return $this->cancelled($shipment, $note, $user, 'marked_cancelled');
    }

    private function cancelled(Shipment $shipment, ?string $note, ?User $user, string $action): Shipment
    {
        return DB::transaction(function () use ($shipment, $note, $user, $action) {
            /** @var Order $o */
            $o = Order::query()->whereKey($shipment->order_id)->lockForUpdate()->firstOrFail();
            /** @var Shipment $s */
            $s = Shipment::query()->whereKey($shipment->id)->lockForUpdate()->firstOrFail();
            $this->assertCancellable($s);
            $now = now();
            $s->forceFill(['status' => 'cancelled', 'cancelled_at' => $now, 'problem' => null])->save();
            WebhookEvents::shipment($s);
            $event = new ShipmentEvent;
            $event->forceFill([
                'store_id' => $s->store_id, 'shipment_id' => $s->id, 'status' => 'cancelled', 'provider_status' => null,
                'description' => $note !== null ? mb_substr($note, 0, 255) : ($action === 'cancelled' ? 'Cancelled with the courier' : 'Marked cancelled'),
                'location' => null, 'source' => 'user', 'occurred_at' => $now,
            ])->save();
            // P5B-36: cancelled before pickup → the order stays (or goes back to) ready_to_ship.
            OrderTimeline::record($o, 'shipment', $user, $note, ['action' => $action, 'shipment_id' => $s->id, 'provider' => $s->provider]);

            return $s;
        });
    }

    private function assertCancellable(Shipment $s): void
    {
        if ($s->provider === 'manual' || $s->status !== 'booked') {
            throw new ApiException(409, 'invalid_state_transition', 'Only a booked parcel that has not been picked up can be cancelled.');
        }
    }

    public function assertBookable(Order $o): void
    {
        if (! in_array($o->status, [Order::CONFIRMED, Order::READY_TO_SHIP], true)) {
            throw new ApiException(409, 'invalid_state_transition', 'Only confirmed or packed orders can be booked with a courier.');
        }
        if (Shipment::query()->where('order_id', $o->id)->whereNotIn('status', ['cancelled', 'booking_failed'])->exists()) {
            throw new ApiException(409, 'shipment_booked', 'This order already has an active shipment.');
        }
    }

    public function connectedAccount(Store $store, string $provider): CourierAccount
    {
        $account = CourierAccount::query()->where('store_id', $store->id)->where('provider', $provider)->first();
        if ($account === null || ! $account->isConnected()) {
            throw new ApiException(422, 'gateway_not_connected', (self::LABELS[$provider] ?? $provider).' is not connected. Connect it under Integrations first.');
        }

        return $account;
    }

    /**
     * A new `booking` row (not saved). COD = due (P5B-35); invoice = the shipment id (P5B-34).
     *
     * @param  array<string, mixed>  $input
     */
    public function newShipment(Order $o, CourierAccount $account, array $input, ?User $user, ?string $idempotencyKey, ?string $batchId): Shipment
    {
        $settings = $account->resolvedSettings();
        if (($input['pickup_location_id'] ?? null) !== null
            && ! PickupLocation::query()->where('store_id', $o->store_id)->whereKey(strtolower((string) $input['pickup_location_id']))->exists()) {
            throw ValidationException::withMessages(['pickup_location_id' => ['Unknown pickup location.']]);
        }
        $shipment = new Shipment;
        $shipment->id = strtolower((string) Str::ulid());
        $shipment->forceFill([
            'store_id' => $o->store_id,
            'order_id' => $o->id,
            'provider' => $account->provider,
            'courier_account_id' => $account->id,
            'carrier_name' => self::LABELS[$account->provider] ?? $account->provider,
            'status' => 'booking',
            'cod_amount' => $o->dueAmount(),
            'cod_overridden' => false,
            'weight_grams' => (int) ($input['weight_grams'] ?? $settings['default_weight_grams'] ?? 500),
            'attempts' => 1,
            'idempotency_key' => $idempotencyKey,
            'batch_id' => $batchId,
            'created_by' => $user?->getKey(),
        ]);

        return $shipment;
    }

    /** Insert; the partial unique index is the final guard against a concurrent second booking. */
    public function save(Shipment $shipment): void
    {
        try {
            DB::transaction(fn () => $shipment->save());
        } catch (QueryException $e) {
            if (in_array((string) $e->getCode(), ['23505', '23000'], true)) {
                throw new ApiException(409, 'shipment_booked', 'This order already has an active shipment.');
            }
            throw $e;
        }
    }

    /**
     * Courier area for Pathao/RedX (P5B-39): the dialog's choice, else the remembered mapping. Steadfast takes free
     * text. Missing → 422 on `$field` (bulk: the caller turns it into `area_unmapped`).
     *
     * @param  array{city_id?: string|null, zone_id?: string|null, area_id?: string|null}|null  $input
     * @return array{city_id: ?string, zone_id: ?string, area_id: ?string, label?: string|null}|null
     */
    public function area(CourierAccount $account, Order $o, ?array $input, string $field): ?array
    {
        if ($account->provider === CourierAccount::STEADFAST) {
            return null;
        }
        $chosen = $input !== null ? [
            'city_id' => isset($input['city_id']) ? (string) $input['city_id'] : null,
            'zone_id' => isset($input['zone_id']) ? (string) $input['zone_id'] : null,
            'area_id' => isset($input['area_id']) ? (string) $input['area_id'] : null,
        ] : $this->mapping($account, $o)?->toArea();
        $complete = $chosen !== null && ($account->provider === CourierAccount::PATHAO
            ? ($chosen['city_id'] ?? null) !== null && ($chosen['zone_id'] ?? null) !== null
            : ($chosen['area_id'] ?? null) !== null);
        if (! $complete) {
            throw ValidationException::withMessages([$field => ['Choose the courier’s delivery area for this address.']]);
        }

        return $chosen;
    }

    public function mapping(CourierAccount $account, Order $o): ?CourierAreaMapping
    {
        return $this->areas->mapping($account, (string) ($o->shipping_address['district_code'] ?? $o->district_code ?? ''), (string) ($o->shipping_address['thana_code'] ?? ''));
    }

    /** @param array{city_id: ?string, zone_id: ?string, area_id: ?string} $area */
    private function remember(CourierAccount $account, Order $o, array $area): void
    {
        $label = trim(($o->shipping_address['thana'] ?? '').', '.($o->shipping_address['district'] ?? ''), ', ');
        $this->areas->remember($account, (string) ($o->shipping_address['district_code'] ?? $o->district_code ?? ''), (string) ($o->shipping_address['thana_code'] ?? ''), $area, $label);
    }

    /**
     * @param  array<string, mixed>  $input
     * @param  array{city_id: ?string, zone_id: ?string, area_id: ?string}|null  $area
     */
    public function request(Order $o, Shipment $s, CourierAccount $account, array $input, ?array $area): BookingRequest
    {
        $settings = $account->resolvedSettings();
        $address = $o->shipping_address ?? [];
        $items = OrderItem::query()->where('order_id', $o->id)->orderBy('position')->get(['product_name', 'variant_title', 'quantity']);
        $description = trim((string) ($input['item_description'] ?? ''));
        if ($description === '') {
            $description = self::describe((string) ($settings['parcel_description'] ?? '{items}'), $items->all(), $o->number);
        }
        $line = trim(implode(', ', array_filter([(string) ($address['address_line'] ?? ''), (string) ($address['area'] ?? '')])));

        return new BookingRequest(
            invoice: $s->id,
            recipientName: (string) $o->customer_name,
            recipientPhone: (string) $o->customer_phone,
            recipientAddress: $line,
            district: (string) ($address['district'] ?? ''),
            thana: (string) ($address['thana'] ?? ''),
            codAmount: (int) $s->cod_amount,
            weightGrams: (int) ($s->weight_grams ?? 500),
            itemDescription: $description,
            note: self::note($input['note'] ?? null, $o->number),
            orderNumber: $o->number,
            cityId: $area['city_id'] ?? null,
            zoneId: $area['zone_id'] ?? null,
            areaId: $area['area_id'] ?? null,
            areaName: $area['label'] ?? null,
            deliveryType: (int) ($input['delivery_type'] ?? $settings['delivery_type'] ?? 48),
            itemType: (int) ($settings['item_type'] ?? 2),
            itemQuantity: max(1, (int) $items->sum('quantity')),
            providerStoreId: match ($account->provider) {
                CourierAccount::PATHAO => isset($settings['pathao_store_id']) ? (string) $settings['pathao_store_id'] : null,
                CourierAccount::REDX => isset($settings['redx_pickup_store_id']) ? (string) $settings['redx_pickup_store_id'] : null,
                default => null,
            },
            storeId: $o->store_id,
            pickupLocationId: isset($input['pickup_location_id']) ? strtolower((string) $input['pickup_location_id']) : $account->pickup_location_id,
            declaredValueAmount: (int) $o->total_amount,
            recipientEmail: $o->customer_email,
        );
    }

    /** P5B-32 parcel description template: `{items}` ("2× Shirt (M), 1× Cap"), `{order_no}`; ≤ 120 chars. */
    public static function describe(string $template, array $items, string $orderNumber): string
    {
        $list = implode(', ', array_map(function ($i) {
            $name = trim((string) $i->product_name.((string) $i->variant_title !== '' ? ' ('.$i->variant_title.')' : ''));

            return $i->quantity.'× '.$name;
        }, $items));
        $text = strtr($template !== '' ? $template : '{items}', ['{items}' => $list, '{order_no}' => $orderNumber]);
        $text = trim((string) preg_replace('/\s+/u', ' ', strip_tags($text)));

        return mb_substr($text !== '' ? $text : 'Order '.$orderNumber, 0, 120);
    }

    /** The order number travels in the note (P5B-34), ≤ 255. */
    public static function note(?string $note, string $orderNumber): string
    {
        $note = trim((string) $note);

        return mb_substr('Order '.$orderNumber.($note !== '' ? ' · '.$note : ''), 0, 255);
    }
}
