<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

/**
 * PHASE-8-4 §4.1 (Q129): the 10 subscribable events in UI order (Figma "Events you can send") plus `ping`, which only
 * "Send test event" produces and endpoints can't subscribe to.
 */
enum WebhookEventType: string
{
    case OrderCreated = 'order.created';
    case OrderConfirmed = 'order.confirmed';
    case OrderCancelled = 'order.cancelled';
    case OrderPaid = 'order.paid';
    case ShipmentUpdated = 'shipment.updated';
    case ShipmentDelivered = 'shipment.delivered';
    case ReturnReceived = 'return.received';
    case ProductUpdated = 'product.updated';
    case StockLow = 'stock.low';
    case CustomerCreated = 'customer.created';
    case Ping = 'ping';

    /** @return list<self> subscribable events, catalogue order */
    public static function subscribable(): array
    {
        return array_values(array_filter(self::cases(), fn (self $t) => $t !== self::Ping));
    }

    /** @return list<string> */
    public static function subscribableValues(): array
    {
        return array_map(fn (self $t) => $t->value, self::subscribable());
    }

    public function label(): string
    {
        return $this->value;
    }

    public function description(): string
    {
        return match ($this) {
            self::OrderCreated => 'An order was placed (storefront checkout, dashboard or exchange).',
            self::OrderConfirmed => 'An order moved to confirmed.',
            self::OrderCancelled => 'An order was cancelled.',
            self::OrderPaid => 'An order became fully paid (verified payment or collected COD).',
            self::ShipmentUpdated => 'A shipment changed status.',
            self::ShipmentDelivered => 'A shipment was delivered.',
            self::ReturnReceived => 'A returned parcel was received back.',
            self::ProductUpdated => 'A product was created or updated (dashboard, import or API).',
            self::StockLow => 'A variant’s stock on hand fell to its low-stock threshold.',
            self::CustomerCreated => 'A new customer was added.',
            self::Ping => 'Test event from “Send test event”.',
        };
    }

    /** subject_type column / payload builder key. */
    public function subjectType(): ?string
    {
        return match ($this) {
            self::OrderCreated, self::OrderConfirmed, self::OrderCancelled, self::OrderPaid => 'order',
            self::ShipmentUpdated, self::ShipmentDelivered => 'shipment',
            self::ReturnReceived => 'return_request',
            self::ProductUpdated => 'product',
            self::StockLow => 'inventory',
            self::CustomerCreated => 'customer',
            self::Ping => null,
        };
    }
}
