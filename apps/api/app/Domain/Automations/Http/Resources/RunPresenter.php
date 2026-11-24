<?php

declare(strict_types=1);

namespace App\Domain\Automations\Http\Resources;

use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationConversion;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Collection;

/**
 * AutomationRun / AutomationRunStep (§9.2, C9). Addresses are always masked (S131); the contact name needs
 * `customers.view` (else null, never 403); `context` is whitelisted (no names) and the image id becomes a URL.
 */
final class RunPresenter
{
    private const CONTEXT_KEYS = ['order_number', 'order_total_amount', 'cart_line_count', 'cart_total_amount', 'first_product_name',
        'return_number', 'product_name', 'variant_name', 'on_hand', 'currency'];

    private const DETAIL_KEYS = ['recipients', 'tag', 'coupon_code', 'message_step'];

    /**
     * @param  Collection<int, AutomationRun>  $runs
     * @return list<array<string, mixed>>
     */
    public static function many(Collection $runs, bool $names): array
    {
        if ($runs->isEmpty()) {
            return [];
        }
        $ids = $runs->pluck('id')->all();
        $automations = Automation::query()->whereIn('id', $runs->pluck('automation_id')->unique()->all())->get(['id', 'recipe', 'name'])->keyBy('id');
        $steps = AutomationRunStep::query()->whereIn('run_id', $ids)->orderBy('step_index')->get()->groupBy('run_id');
        $conversions = AutomationConversion::query()->whereIn('run_id', $ids)->get(['run_id', 'order_id']);
        $orders = Order::query()->whereIn('id', $conversions->pluck('order_id')->all())->get(['id', 'number', 'total_amount'])->keyBy('id');
        $byRun = [];
        foreach ($conversions as $c) {
            if (($o = $orders[$c->order_id] ?? null) !== null) {
                $byRun[$c->run_id] = ['order' => ['id' => $o->id, 'number' => $o->number, 'total_amount' => (int) $o->total_amount]];
            }
        }
        $mediaIds = $runs->map(fn (AutomationRun $r) => $r->context['first_product_image_media_id'] ?? null)->filter()->unique()->values()->all();
        $media = $mediaIds === [] ? collect() : Media::query()->whereIn('id', $mediaIds)->get()->keyBy('id');

        return $runs->map(fn (AutomationRun $r) => self::run($r, $automations[$r->automation_id] ?? null, $steps[$r->id] ?? collect(), $byRun[$r->id] ?? null, $media, $names))->values()->all();
    }

    /**
     * @param  Collection<int, AutomationRunStep>  $steps
     * @param  Collection<string, Media>  $media
     * @param  array<string, mixed>|null  $conversion
     * @return array<string, mixed>
     */
    private static function run(AutomationRun $r, ?Automation $a, Collection $steps, ?array $conversion, Collection $media, bool $names): array
    {
        $ctx = (array) $r->context;
        $context = array_intersect_key($ctx, array_flip(self::CONTEXT_KEYS));
        if (array_key_exists('first_product_image_media_id', $ctx)) {
            $context['first_product_image_url'] = MediaPresenter::url($media[$ctx['first_product_image_media_id']] ?? null, ['w320']);
        }
        $person = $r->subject_type !== 'inventory';

        return [
            'id' => $r->id,
            'automation' => ['id' => $r->automation_id, 'recipe' => $a?->recipe, 'name' => $a?->name],
            'trigger' => $r->trigger,
            'status' => $r->status,
            'outcome_reason' => $r->outcome_reason,
            'outcome_detail' => self::outcomeDetail($r),
            'subject' => ['type' => $r->subject_type, 'id' => $r->subject_id, 'label' => self::label($r)],
            'contact' => $person ? [
                'masked_address' => $r->contact_address !== null ? self::mask($r->contact_address) : null,
                'name' => $names ? ($ctx['contact_name'] ?? null) : null,
            ] : null,
            'context' => (object) $context,
            'steps' => $steps->map(fn (AutomationRunStep $s) => self::step($s))->values()->all(),
            'started_at' => UserRef::iso($r->started_at),
            'resume_at' => UserRef::iso($r->resume_at),
            'finished_at' => UserRef::iso($r->finished_at),
            'conversion' => $conversion,
        ];
    }

    /** Only the per-condition results leave the API (field, label, passed, detail); null otherwise. @return array<string, mixed>|null */
    private static function outcomeDetail(AutomationRun $r): ?array
    {
        $conditions = ((array) $r->outcome_detail)['conditions'] ?? null;
        if (! is_array($conditions)) {
            return null;
        }

        return ['conditions' => array_values(array_map(fn ($c) => [
            'field' => (string) ($c['field'] ?? ''),
            'label' => (string) ($c['label'] ?? ''),
            'passed' => (bool) ($c['passed'] ?? false),
            'detail' => isset($c['detail']) ? (string) $c['detail'] : null,
        ], array_filter($conditions, 'is_array')))];
    }

    /** @return array<string, mixed> */
    public static function step(AutomationRunStep $s): array
    {
        $detail = $s->detail !== null ? array_intersect_key((array) $s->detail, array_flip(self::DETAIL_KEYS)) : null;

        return [
            'index' => (int) $s->step_index,
            'action' => $s->action,
            'status' => $s->status,
            'reason' => $s->reason,
            'channel' => $s->channel,
            'masked_address' => $s->address !== null && $s->channel !== null ? MarketingAddress::mask($s->channel, $s->address) : null,
            'parts' => (int) $s->parts,
            'detail' => $detail === null || $detail === [] ? null : $detail,
            'executed_at' => UserRef::iso($s->executed_at),
        ];
    }

    public static function mask(string $address): string
    {
        return MarketingAddress::mask(str_contains($address, '@') ? 'email' : 'sms', $address);
    }

    private static function label(AutomationRun $r): string
    {
        $ctx = (array) $r->context;

        return match ($r->subject_type) {
            'order' => (string) ($ctx['order_number'] ?? 'Order'),
            'cart' => 'Cart · '.(int) ($ctx['cart_line_count'] ?? 0).' '.((int) ($ctx['cart_line_count'] ?? 0) === 1 ? 'item' : 'items'),
            'return' => (string) ($ctx['return_number'] ?? 'Return'),
            'inventory' => isset($ctx['variant_name']) ? ($ctx['product_name'] ?? 'Product').' · '.$ctx['variant_name'] : (string) ($ctx['product_name'] ?? 'Product'),
            default => $r->subject_type,
        };
    }
}
