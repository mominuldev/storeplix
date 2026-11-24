<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Orders\Models\Order;
use Illuminate\Support\Str;

/**
 * Order placed → recovery exit + attribution (P86-14, P86-15). Idempotent: conditional UPDATEs and one conversion per
 * order (UNIQUE order_id).
 *  - open recovery runs of the same normalized phone that started at or before the order → `stopped/converted`;
 *  - the order is credited to the LAST message step `done` before it, among recovery runs of that phone whose window
 *    was still open when the order was placed (first message done before the order is implied).
 */
final class Conversions
{
    public function orderPlaced(string $orderId): void
    {
        $order = Order::query()->find($orderId);
        $phone = $order !== null ? MarketingAddress::normalize(Campaign::SMS, $order->customer_phone) : null;
        if ($order === null || $phone === null) {
            return;
        }
        $placed = $order->placed_at ?? $order->created_at;
        $automationIds = Automation::query()->where('store_id', $order->store_id)->where('recipe', 'checkout_recovery')->pluck('id');
        if ($automationIds->isEmpty()) {
            return;
        }
        $runs = AutomationRun::query()->whereIn('automation_id', $automationIds)->where('contact_address', $phone)
            ->where('started_at', '<=', $placed)->get(['id', 'automation_id', 'status', 'window_ends_at']);
        $engine = app(AutomationEngine::class);
        foreach ($runs as $run) {
            if (in_array($run->status, AutomationRun::OPEN, true)) {
                $engine->finish($run->id, AutomationRun::STOPPED, 'converted');
            }
        }
        $eligible = $runs->filter(fn (AutomationRun $r) => $r->window_ends_at !== null && $r->window_ends_at->gte($placed));
        if ($eligible->isEmpty()) {
            return;
        }
        $step = AutomationRunStep::query()->whereIn('run_id', $eligible->pluck('id')->all())
            ->where('action', AutomationRunStep::SEND_MESSAGE)->where('status', AutomationRunStep::DONE)
            ->where('executed_at', '<=', $placed)->orderByDesc('executed_at')->orderByDesc('step_index')->first(['id', 'run_id']);
        if ($step === null) {
            return;
        }
        $run = $eligible->firstWhere('id', $step->run_id);
        AutomationConversion::query()->insertOrIgnore([[
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $order->tenant_id,
            'store_id' => $order->store_id,
            'automation_id' => $run->automation_id,
            'run_id' => $run->id,
            'step_id' => $step->id,
            'order_id' => $order->id,
            'placed_at' => $placed,
            'created_at' => now(),
        ]]);
    }
}
