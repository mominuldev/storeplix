<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Carbon;

/**
 * `checkout_recovery` "Win back unfinished orders" (§3, §7): checkout left → step 1 message → wait "only if still no
 * order" → step 2 message (optional coupon) → exit when an order is placed or the window ends. The checkout contact may
 * get these ≤ 2 messages without prior consent (P86-11). Dedupe `checkout:{phone}:{first detection day, store tz}`.
 */
final class CheckoutRecovery extends Recipe
{
    public function key(): string
    {
        return 'checkout_recovery';
    }

    public function name(): string
    {
        return 'Win back unfinished orders';
    }

    public function description(): string
    {
        return 'Text shoppers who left checkout with items in their bag, with an optional coupon in the second reminder.';
    }

    public function icon(): string
    {
        return 'shopping-cart';
    }

    public function trigger(): string
    {
        return 'checkout.abandoned';
    }

    public function triggerDescription(): string
    {
        return 'A shopper typed their phone at checkout and left with items in the bag, or an online payment timed out.';
    }

    public function triggerLabel(array $settings): string
    {
        return 'Checkout left '.(int) ($settings['delay_minutes'] ?? 30).' min';
    }

    public function actionLabel(array $settings): string
    {
        return 'Reminder '.self::channelWord($settings['step1']['message'] ?? [], false);
    }

    public function isRecovery(): bool
    {
        return true;
    }

    public function conditionFields(): array
    {
        return ['customer.risk'];
    }

    public function mergeFields(): array
    {
        return ['{name}', '{cart_link}', '{product}', '{coupon}', '{shop_link}'];
    }

    public function subjectTypes(): array
    {
        return ['cart', 'order'];
    }

    public function defaults(string $language): array
    {
        $bn = $language === 'bn';

        return [
            'delay_minutes' => 30,
            'step1' => ['enabled' => true, 'message' => [
                'channel' => 'sms', 'language' => $language, 'subject' => null,
                'body' => $bn ? '{name}, আপনার ব্যাগে পণ্য রয়ে গেছে। অর্ডার শেষ করুন: {cart_link}'
                    : 'Hi {name}, you left something in your bag. Finish your order here: {cart_link}',
            ]],
            'wait_hours' => 24,
            'step2' => ['enabled' => true, 'coupon_id' => null, 'message' => [
                'channel' => 'sms', 'language' => $language, 'subject' => null,
                'body' => $bn ? '{name}, আপনার ব্যাগ এখনও অপেক্ষা করছে। অর্ডার শেষ করুন: {cart_link}'
                    : 'Hi {name}, your bag is still waiting. Complete your order: {cart_link}',
            ]],
            'exit_days' => 3,
            'skip_risky' => true,
        ];
    }

    protected function rules(): array
    {
        return [
            '' => ['required', 'array:delay_minutes,step1,wait_hours,step2,exit_days,skip_risky'],
            'delay_minutes' => ['required', 'integer:strict', 'min:15', 'max:180'],
            'step1' => ['required', 'array:enabled,message'],
            'step1.enabled' => ['required', 'boolean:strict'],
            'wait_hours' => ['required', 'integer:strict', 'min:6', 'max:48'],
            'step2' => ['required', 'array:enabled,coupon_id,message'],
            'step2.enabled' => ['required', 'boolean:strict'],
            'step2.coupon_id' => ['present', 'nullable', 'string', 'size:26'],
            'exit_days' => ['required', 'integer:strict', 'min:1', 'max:7'],
            'skip_risky' => ['required', 'boolean:strict'],
        ] + self::messageRules('step1.message') + self::messageRules('step2.message');
    }

    protected function finish(Store $store, array $settings): array
    {
        $coupon = self::coupon($store, $settings['step2']['coupon_id'], 'step2.coupon_id');

        return [
            'delay_minutes' => (int) $settings['delay_minutes'],
            'step1' => ['enabled' => (bool) $settings['step1']['enabled'], 'message' => $this->message($store, $settings['step1']['message'], 'step1.message', null)],
            'wait_hours' => (int) $settings['wait_hours'],
            'step2' => [
                'enabled' => (bool) $settings['step2']['enabled'],
                'coupon_id' => $coupon?->id,
                'message' => $this->message($store, $settings['step2']['message'], 'step2.message', $coupon),
            ],
            'exit_days' => (int) $settings['exit_days'],
            'skip_risky' => (bool) $settings['skip_risky'],
        ];
    }

    public function incomplete(array $settings): array
    {
        $missing = [];
        if (! ($settings['step1']['enabled'] ?? false) && ! ($settings['step2']['enabled'] ?? false)) {
            $missing[] = 'step1.enabled';
        }
        if (self::usesCoupon($settings['step1']['message'] ?? [])) {
            $missing[] = 'step1.message.body'; // step 1 has no coupon
        }
        if (($settings['step2']['enabled'] ?? false) && self::usesCoupon($settings['step2']['message'] ?? []) && ($settings['step2']['coupon_id'] ?? null) === null) {
            $missing[] = 'step2.coupon_id';
        }

        return $missing;
    }

    public function conditions(array $settings): array
    {
        return ($settings['skip_risky'] ?? true) ? [['field' => 'customer.risk', 'op' => 'is_not', 'value' => 'risky']] : [];
    }

    public function flow(array $settings): array
    {
        return [
            ['kind' => 'send_message', 'index' => 1, 'message_step' => 1, 'enabled' => (bool) ($settings['step1']['enabled'] ?? false), 'message' => $settings['step1']['message'] ?? [], 'coupon_id' => null],
            ['kind' => 'wait', 'from' => 'now', 'hours' => (int) ($settings['wait_hours'] ?? 24)],
            ['kind' => 'send_message', 'index' => 2, 'message_step' => 2, 'enabled' => (bool) ($settings['step2']['enabled'] ?? false), 'message' => $settings['step2']['message'] ?? [], 'coupon_id' => $settings['step2']['coupon_id'] ?? null],
            ['kind' => 'wait', 'until' => 'window'],
        ];
    }

    public function schemaSteps(): array
    {
        return [
            ['kind' => 'send_message', 'title' => 'Send SMS reminder', 'description' => 'First reminder with a link that restores the bag.', 'optional' => true, 'message_step' => 1],
            ['kind' => 'wait', 'title' => 'Wait', 'description' => 'Only if there is still no order.', 'optional' => false, 'message_step' => null],
            ['kind' => 'send_message', 'title' => 'SMS + coupon', 'description' => 'Second reminder, optionally with a coupon.', 'optional' => true, 'message_step' => 2],
            ['kind' => 'wait', 'title' => 'Stop when an order is placed', 'description' => 'The flow ends when an order is placed or the window ends.', 'optional' => false, 'message_step' => null],
        ];
    }

    public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string
    {
        $day = Carbon::now()->setTimezone((string) ($store->timezone ?: 'Asia/Dhaka'))->format('Y-m-d');

        return 'checkout:'.($subject->phone ?? $subject->type.':'.$subject->id).':'.$day;
    }
}
