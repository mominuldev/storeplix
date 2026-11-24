<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Resources;

use App\Domain\Marketing\Audience\AudienceDefinition;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Facades\DB;

/** Campaign / CampaignListItem / CampaignRecipient payloads (PHASE-8-5 §6.2, @storeplix/types). */
final class CampaignPresenter
{
    /** @return list<string> */
    public static function with(): array
    {
        return ['coupon', 'product', 'createdBy'];
    }

    /**
     * Attributed orders + revenue per campaign (P85-21: order total, cancelled excluded; evaluated at read time).
     *
     * @param  list<string>  $ids
     * @return array<string, array{orders: int, revenue_amount: int}>
     */
    public static function conversions(string $storeId, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $rows = DB::table('campaign_conversions as cc')->join('orders as o', 'o.id', '=', 'cc.order_id')
            ->where('cc.store_id', $storeId)->whereIn('cc.campaign_id', $ids)->where('o.status', '<>', 'cancelled')
            ->groupBy('cc.campaign_id')->selectRaw('cc.campaign_id, count(*) as n, coalesce(sum(o.total_amount), 0) as revenue')->get()->keyBy('campaign_id');
        $out = [];
        foreach ($ids as $id) {
            $out[$id] = ['orders' => (int) ($rows[$id]->n ?? 0), 'revenue_amount' => (int) ($rows[$id]->revenue ?? 0)];
        }

        return $out;
    }

    /**
     * @param  array<string, array{orders: int, revenue_amount: int}>  $conversions
     * @return array<string, mixed>
     */
    public static function listItem(Campaign $c, string $currency, array $conversions = []): array
    {
        $conv = $conversions[$c->id] ?? self::conversions($c->store_id, [$c->id])[$c->id];

        return [
            'id' => $c->id,
            'name' => $c->name,
            'channel' => $c->channel,
            'language' => $c->language,
            'status' => $c->status,
            'audience_label' => AudienceDefinition::label((array) $c->audience, $c->language),
            'coupon' => $c->coupon !== null ? ['id' => $c->coupon->id, 'code' => $c->coupon->code] : null,
            'product' => $c->product !== null ? ['id' => $c->product->id, 'name' => $c->product->name, 'slug' => $c->product->slug] : null,
            'scheduled_at' => UserRef::iso($c->scheduled_at),
            'started_at' => UserRef::iso($c->started_at),
            'completed_at' => UserRef::iso($c->completed_at),
            'cancelled_at' => UserRef::iso($c->cancelled_at),
            'failure_reason' => $c->failure_reason,
            'stats' => [
                'recipients' => (int) $c->recipients_count,
                'sent' => (int) $c->sent_count,
                'failed' => (int) $c->failed_count,
                'skipped' => (int) $c->skipped_count,
                'unsubscribed' => (int) $c->unsubscribed_count,
                'parts_sent' => (int) $c->parts_sent,
                'orders' => $conv['orders'],
                'revenue_amount' => $conv['revenue_amount'],
                'currency' => $currency,
            ],
            'created_by' => UserRef::of($c->createdBy),
            'created_at' => UserRef::iso($c->created_at),
            'updated_at' => UserRef::iso($c->updated_at),
            'revision' => (int) $c->revision,
        ];
    }

    /** @return array<string, mixed> */
    public static function campaign(Campaign $c, string $currency): array
    {
        $c->loadMissing(self::with());

        return self::listItem($c, $currency) + [
            'audience' => AudienceDefinition::present((array) $c->audience),
            'body' => $c->body,
            'subject' => $c->subject,
        ];
    }

    /**
     * @param  array<string, array{id: string, number: string, total_amount: int}>  $orders  by recipient id
     * @return array<string, mixed>
     */
    public static function recipient(CampaignRecipient $r, array $orders): array
    {
        return [
            'id' => $r->id,
            'customer' => $r->customer !== null ? ['id' => $r->customer->id, 'name' => $r->customer->name] : null,
            'masked_address' => MarketingAddress::mask($r->channel, $r->address),
            'status' => $r->status,
            'skip_reason' => $r->skip_reason,
            'error_code' => $r->error_code,
            'parts' => (int) $r->parts,
            'sent_at' => UserRef::iso($r->sent_at),
            'unsubscribed_at' => UserRef::iso($r->unsubscribed_at),
            'attributed_order' => $orders[$r->id] ?? null,
        ];
    }
}
