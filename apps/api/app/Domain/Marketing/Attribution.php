<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Marketing\Jobs\AttributeOrder;
use App\Domain\Marketing\Models\CampaignConversion;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * Campaign attribution (PHASE-8-5 §5.5, P85-21, Q144): an order placed by a recipient customer within 7 days after
 * that recipient was `sent` belongs to that campaign; the latest send wins; one row per order. Revenue is read later
 * from the order (cancelled excluded), so status changes need no bookkeeping here.
 */
final class Attribution
{
    /** Order-placed hook (one line in OrderPlacementService): queued after commit; never throws into checkout. */
    public static function orderPlaced(Order $order): void
    {
        try {
            $context = app(TenantContext::class);
            if ($order->customer_id === null || ! $context->has()) {
                return;
            }
            $tenantId = (string) $context->id();
            $orderId = (string) $order->id;
            DB::afterCommit(function () use ($tenantId, $orderId) {
                try {
                    dispatch((new AttributeOrder($orderId))->forTenant($tenantId));
                } catch (Throwable $e) {
                    report($e);
                }
            });
        } catch (Throwable $e) {
            report($e);
        }
    }

    public function attribute(string $orderId): void
    {
        $order = Order::query()->find($orderId);
        if ($order === null || $order->customer_id === null) {
            return;
        }
        $placed = $order->placed_at ?? $order->created_at;
        $recipient = CampaignRecipient::query()
            ->where('store_id', $order->store_id)
            ->where('customer_id', $order->customer_id)
            ->where('status', CampaignRecipient::SENT)
            ->where('sent_at', '>=', $placed->copy()->subDays((int) config('campaigns.attribution_days', 7)))
            ->where('sent_at', '<=', $placed)
            ->orderByDesc('sent_at')->orderByDesc('id')
            ->first();
        if ($recipient === null) {
            return;
        }
        CampaignConversion::query()->insertOrIgnore([[
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $order->tenant_id,
            'store_id' => $order->store_id,
            'campaign_id' => $recipient->campaign_id,
            'recipient_id' => $recipient->id,
            'order_id' => $order->id,
            'placed_at' => $placed,
            'created_at' => now(),
        ]]);
    }
}
