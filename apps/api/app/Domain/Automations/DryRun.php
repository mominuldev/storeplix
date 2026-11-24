<?php

declare(strict_types=1);

namespace App\Domain\Automations;

use App\Domain\Automations\Engine\AutomationEngine;
use App\Domain\Automations\Engine\Conditions;
use App\Domain\Automations\Engine\Subject;
use App\Domain\Automations\Engine\TeamRecipients;
use App\Domain\Automations\Messages\AutomationMessages;
use App\Domain\Automations\Models\Automation;
use App\Domain\Cart\Models\Cart;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Marketing\Suppressions;
use App\Domain\Orders\Models\Order;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Validation\ValidationException;

/**
 * "Test with an order" (P86-21, C8): evaluates the automation against one subject and returns what would happen —
 * condition results, rendered messages, would-skip reasons. Reads only: no writes, no provider calls, no allowance use
 * (S137). Messages render with sample codes.
 */
final class DryRun
{
    private const INPUTS = ['order_id' => 'order', 'cart_id' => 'cart', 'inventory_id' => 'inventory', 'return_id' => 'return'];

    /** @param array<string, mixed> $input @return array<string, mixed> AutomationDryRun */
    public static function run(Store $store, Automation $automation, array $input): array
    {
        $recipe = $automation->recipeDefinition();
        $given = array_filter(array_intersect_key($input, self::INPUTS), fn ($v) => $v !== null && $v !== '');
        if (count($given) > 1) {
            throw ValidationException::withMessages(['order_id' => ['Choose one subject.']]);
        }
        $type = null;
        $id = null;
        if ($given !== []) {
            $key = (string) array_key_first($given);
            $type = self::INPUTS[$key];
            $id = strtolower((string) $given[$key]);
            if (! in_array($type, $recipe->subjectTypes(), true)) {
                throw ValidationException::withMessages([$key => ['This recipe is tested with '.implode(' or ', $recipe->subjectTypes()).' subjects.']]);
            }
        } else {
            [$type, $id] = self::latest($store, $recipe->subjectTypes(), $automation->recipe);
        }
        $subject = $id !== null ? Subject::load($store, $type, $id) : null;
        if ($subject === null) {
            if ($given !== []) {
                throw ValidationException::withMessages([(string) array_key_first($given) => ['Not found in this store.']]);
            }

            return ['subject' => null, 'conditions' => [], 'steps' => []];
        }

        $settings = (array) $automation->settings;
        $evaluation = Conditions::evaluate($recipe->conditions($settings), $subject);
        $brand = StoreBrand::of($store);
        $steps = [];
        foreach ($recipe->flow($settings) as $step) {
            if ($step['kind'] === 'wait') {
                continue;
            }
            $steps[] = match ($step['kind']) {
                'send_message' => self::message($store, $brand, $recipe->isRecovery(), $subject, $step, $evaluation['passed']),
                'add_tag' => self::tag($subject, $step, $evaluation['passed']),
                'notify_team' => self::notify($step, $evaluation['passed']),
            };
        }

        return [
            'subject' => ['type' => $subject->type, 'id' => $subject->id, 'label' => $subject->label],
            'conditions' => array_map(fn ($r) => ['label' => $r['label'], 'passed' => $r['passed'], 'detail' => $r['detail']], $evaluation['results']),
            'steps' => $steps,
        ];
    }

    /** @param array<string, mixed> $step @return array<string, mixed> */
    private static function message(Store $store, StoreBrand $brand, bool $recovery, Subject $subject, array $step, bool $passed): array
    {
        $message = (array) $step['message'];
        $channel = (string) ($message['channel'] ?? 'sms');
        $address = $recovery ? $subject->address($channel, true) : $subject->address($channel, false);
        $coupon = AutomationEngine::couponFor($store, $message, $step['coupon_id'] ?? null);
        $customer = $subject->customer;
        $reason = match (true) {
            ! $passed || ! $step['enabled'] => null,
            ! $recovery && ($customer === null || ! ($customer->accepts_marketing || $customer->orders_count >= 1)) => 'not_eligible',
            $address === null => 'no_address',
            Suppressions::exists($store->id, $channel, $address) => 'opted_out',
            AutomationEngine::usesCoupon($message) && ($coupon === null || $coupon->displayStatus() !== 'active') => 'coupon_inactive',
            AutomationEngine::recentCount($channel, $address) >= (int) config('automations.frequency_cap', 2) => 'frequency_cap',
            default => null,
        };
        $rendered = AutomationMessages::render(
            $message, $brand, $subject->name ?? $customer?->name, CampaignRenderer::SAMPLE_CODE, $coupon?->code, $subject->product,
            $subject->order?->number, $recovery ? AutomationMessages::cartLink($brand, CampaignRenderer::SAMPLE_CODE) : null,
        );
        if ($reason === null && $passed && $step['enabled'] && ($tenant = app(TenantContext::class)->tenant()) !== null) {
            $summary = CampaignAllowance::summary($tenant, $channel, $rendered['parts']);
            if ($summary['limit'] !== null && $summary['limit'] < $summary['used'] + $rendered['parts']) {
                $reason = 'allowance';
            }
        }

        return [
            'index' => (int) $step['index'],
            'action' => 'send_message',
            'would' => $passed && $step['enabled'] && $reason === null ? 'send' : 'skip',
            'reason' => $reason,
            'rendered' => ['channel' => $channel, 'subject' => $rendered['subject'], 'text' => $rendered['text'], 'parts' => $rendered['parts']],
        ];
    }

    /** @param array<string, mixed> $step @return array<string, mixed> */
    private static function tag(Subject $subject, array $step, bool $passed): array
    {
        $tag = mb_strtolower(trim((string) $step['tag']));
        $tags = array_map(fn ($t) => mb_strtolower((string) $t), (array) ($subject->customer?->tags ?? []));
        $reason = match (true) {
            ! $passed => null,
            $subject->customer === null => 'no_customer',
            in_array($tag, $tags, true) => 'already_tagged',
            count($tags) >= 20 => 'tags_full',
            default => null,
        };

        return ['index' => (int) $step['index'], 'action' => 'add_tag', 'would' => $passed && $reason === null ? 'tag' : 'skip', 'reason' => $reason, 'rendered' => null];
    }

    /** @param array<string, mixed> $step @return array<string, mixed> */
    private static function notify(array $step, bool $passed): array
    {
        $reason = $passed && TeamRecipients::for(Permission::InventoryAdjust) === [] ? 'no_recipients' : null;

        return ['index' => (int) $step['index'], 'action' => 'notify_team', 'would' => $passed && $reason === null ? 'notify' : 'skip', 'reason' => $reason, 'rendered' => null];
    }

    /** @param list<string> $types @return array{0: string, 1: string|null} the latest matching subject */
    private static function latest(Store $store, array $types, string $recipe): array
    {
        foreach ($types as $type) {
            $id = match ($type) {
                'cart' => Cart::query()->where('store_id', $store->id)->whereNotNull('contact_phone')->orderByDesc('last_activity_at')->value('id'),
                'order' => Order::query()->where('store_id', $store->id)
                    ->when($recipe !== 'checkout_recovery', fn ($q) => $q->where('status', Order::DELIVERED))
                    ->orderByDesc('placed_at')->value('id'),
                'return' => ReturnRequest::query()->where('store_id', $store->id)->orderByDesc('created_at')->value('id'),
                'inventory' => Inventory::query()->where('store_id', $store->id)->orderBy('on_hand')->value('id'),
                default => null,
            };
            if ($id !== null) {
                return [$type, (string) $id];
            }
        }

        return [$types[0], null];
    }
}
