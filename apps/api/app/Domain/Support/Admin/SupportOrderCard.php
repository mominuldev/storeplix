<?php

declare(strict_types=1);

namespace App\Domain\Support\Admin;

use App\Domain\Help\HelpPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Cache;

/**
 * The limited live order card staff see on a ticket (PHASE-8-9C P89C-20, S256): number, placed_at, status, payment,
 * totals, item count + first item name, courier + latest tracking status, customer first name + district — never phone,
 * email or street. Only while the ticket is not closed. Read inside the ticket's tenant
 * (`// cross-tenant: support ticket related order`), audited `support_ticket.order_viewed` at most once per staff per
 * ticket per day.
 */
final class SupportOrderCard
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array<string, mixed>|null AdminSupportOrderCard */
    public function for(SupportTicket $ticket, User $staff): ?array
    {
        if ($ticket->isClosed() || $ticket->order_id === null) {
            return null;
        }

        // cross-tenant: support ticket related order
        return $this->context->run($ticket->tenant_id, function () use ($ticket, $staff) {
            $order = Order::query()->find($ticket->order_id);
            if (! $order instanceof Order) {
                return null;
            }
            $items = OrderItem::query()->where('order_id', $order->id)->orderBy('id')->get(['product_name', 'quantity']);
            $shipment = Shipment::query()->where('order_id', $order->id)->orderByDesc('created_at')->orderByDesc('id')->first(['provider', 'status']);
            $address = is_array($order->shipping_address) ? $order->shipping_address : [];
            $first = preg_split('/\s+/u', trim((string) $order->customer_name)) ?: [];

            $day = now()->toDateString();
            if (Cache::add("support:order-viewed:{$staff->id}:{$ticket->id}:{$day}", 1, now()->addDay())) {
                $this->audit->log('support_ticket.order_viewed', $ticket, ['reference' => $ticket->reference(), 'order_id' => $order->id], $staff, platform: true);
            }

            return [
                'id' => $order->id,
                'number' => $order->number,
                'placed_at' => HelpPresenter::ts($order->placed_at),
                'status' => $order->status,
                'payment_status' => $order->payment_status,
                'payment_method' => $order->payment_method,
                'total_amount' => (int) $order->total_amount,
                'paid_amount' => (int) $order->paid_amount,
                'due_amount' => max(0, (int) $order->total_amount - (int) $order->paid_amount + (int) $order->refunded_amount),
                'currency' => $order->currency,
                'items_count' => (int) $items->sum('quantity'),
                'first_item_name' => $items->first()?->product_name,
                'courier' => $shipment === null ? null : ['provider' => (string) $shipment->provider, 'status' => $shipment->status],
                'customer' => [
                    'first_name' => ($first[0] ?? '') !== '' ? (string) $first[0] : null,
                    'district' => isset($address['district']) && is_string($address['district']) ? $address['district'] : null,
                ],
            ];
        });
    }
}
