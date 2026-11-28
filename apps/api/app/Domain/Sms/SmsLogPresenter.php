<?php

declare(strict_types=1);

namespace App\Domain\Sms;

use App\Domain\Automations\Models\Automation;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Orders\Models\Order;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Sms\Models\SmsMessage;
use Illuminate\Support\Collection;

/**
 * SmsLogEntry (PHASE-8-9A §9, P89A-21, S217): masked phone, link-free preview (never for checkout codes, null after the
 * retention), only `provider_error` / `no_credits`, references resolved inside the tenant (deleted subject → null).
 * The raw provider `error` and the full number are never returned.
 */
final class SmsLogPresenter
{
    /**
     * @param  Collection<int, SmsMessage>  $rows
     * @return list<array<string, mixed>>
     */
    public static function many(Collection $rows): array
    {
        $ids = fn (string $type) => $rows->where('reference_type', $type)->pluck('reference_id')->filter()->unique()->values()->all();
        $orders = Order::query()->whereIn('id', $ids('order'))->pluck('number', 'id');
        $sales = PosSale::query()->whereIn('id', $ids('pos_sale'))->pluck('order_id', 'id');
        $saleOrders = Order::query()->whereIn('id', $sales->values()->all())->pluck('number', 'id');
        $campaigns = Campaign::query()->whereIn('id', $ids('campaign'))->pluck('name', 'id');
        $automations = Automation::query()->whereIn('id', $ids('automation'))->pluck('name', 'id');
        $conversations = InboxConversation::query()->whereIn('id', $ids('conversation'))->pluck('contact_name', 'id'); // PHASE-8-8E
        $previewSince = now()->subDays((int) config('sms.preview_days', 90));

        return $rows->map(function (SmsMessage $m) use ($orders, $sales, $saleOrders, $campaigns, $automations, $conversations, $previewSince) {
            $label = match ($m->reference_type) {
                'order' => $orders[$m->reference_id] ?? null,
                'pos_sale' => isset($sales[$m->reference_id]) ? ($saleOrders[$sales[$m->reference_id]] ?? null) : null,
                'campaign' => $campaigns[$m->reference_id] ?? null,
                'automation' => $automations[$m->reference_id] ?? null,
                'conversation' => $conversations[$m->reference_id] ?? null,
                default => null,
            };
            $error = in_array($m->error_code, [SmsMessage::PROVIDER_ERROR, SmsMessage::NO_CREDITS], true) ? $m->error_code
                : ($m->status === SmsMessage::FAILED ? SmsMessage::PROVIDER_ERROR : ($m->status === SmsMessage::SKIPPED ? SmsMessage::NO_CREDITS : null));

            return [
                'id' => $m->id,
                'created_at' => $m->created_at->toIso8601ZuluString(),
                'to_masked' => SmsPreview::maskPhone($m->to),
                'purpose' => $m->purpose,
                'kind' => $m->kind ?? SmsPurposes::kindOf($m->purpose),
                'status' => $m->status,
                'parts' => $m->parts,
                'charged_from' => $m->charged_from,
                'sender_id' => $m->sender_id,
                'body_preview' => $m->purpose === SmsPurposes::CHECKOUT_OTP || $m->created_at->lt($previewSince) ? null : $m->body_preview,
                'error_code' => $error,
                'reference' => $label !== null ? ['type' => $m->reference_type, 'id' => $m->reference_id, 'label' => (string) $label] : null,
            ];
        })->values()->all();
    }
}
