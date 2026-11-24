<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Conditions;
use App\Domain\Automations\Engine\Subject;
use App\Domain\Stores\Models\Store;

/** `thank_you` "Thank-you message" (§3): delivered → optional wait → message. Dedupe `order:{id}`. */
final class ThankYou extends Recipe
{
    public function key(): string
    {
        return 'thank_you';
    }

    public function name(): string
    {
        return 'Thank-you message';
    }

    public function description(): string
    {
        return 'Thank buyers after their parcel is delivered.';
    }

    public function icon(): string
    {
        return 'heart';
    }

    public function trigger(): string
    {
        return 'order.delivered';
    }

    public function triggerDescription(): string
    {
        return 'A parcel of an order is delivered.';
    }

    public function triggerLabel(array $settings): string
    {
        return 'Delivered';
    }

    public function actionLabel(array $settings): string
    {
        return 'Thank-you '.self::channelWord($settings['message'] ?? [], false);
    }

    public function conditionFields(): array
    {
        return ['order.total_amount', 'order.payment_method', 'order.channel', 'customer.tag'];
    }

    public function mergeFields(): array
    {
        return ['{name}', '{order_no}', '{product}', '{shop_link}'];
    }

    public function subjectTypes(): array
    {
        return ['order'];
    }

    public function defaults(string $language): array
    {
        return [
            'delay_hours' => 0,
            'message' => [
                'channel' => 'sms', 'language' => $language, 'subject' => null,
                'body' => $language === 'bn' ? '{name}, অর্ডার {order_no} এর জন্য ধন্যবাদ! আবার কেনাকাটা করুন: {shop_link}'
                    : 'Hi {name}, thank you for your order {order_no}! We hope you love it. Shop again: {shop_link}',
            ],
            'conditions' => [],
        ];
    }

    protected function rules(): array
    {
        return [
            '' => ['required', 'array:delay_hours,message,conditions'],
            'delay_hours' => ['required', 'integer:strict', 'min:0', 'max:72'],
            'conditions' => ['present', 'array', 'list', 'max:5'],
            'conditions.*' => ['required', 'array:field,op,value'],
            'conditions.*.field' => ['required', 'string'],
            'conditions.*.op' => ['required', 'string'],
            'conditions.*.value' => ['present'],
        ] + self::messageRules('message');
    }

    protected function finish(Store $store, array $settings): array
    {
        return [
            'delay_hours' => (int) $settings['delay_hours'],
            'message' => $this->message($store, $settings['message'], 'message', null),
            'conditions' => Conditions::validate($this->conditionFields(), $settings['conditions'], 'settings.conditions'),
        ];
    }

    public function conditions(array $settings): array
    {
        return array_values($settings['conditions'] ?? []);
    }

    public function flow(array $settings): array
    {
        return [
            ['kind' => 'wait', 'from' => 'start', 'hours' => (int) ($settings['delay_hours'] ?? 0)],
            ['kind' => 'send_message', 'index' => 1, 'message_step' => 1, 'enabled' => true, 'message' => $settings['message'] ?? [], 'coupon_id' => null],
        ];
    }

    public function schemaSteps(): array
    {
        return [
            ['kind' => 'wait', 'title' => 'Wait', 'description' => 'Optional delay after delivery.', 'optional' => true, 'message_step' => null],
            ['kind' => 'send_message', 'title' => 'Send thank-you SMS', 'description' => 'A short thank-you to the buyer.', 'optional' => false, 'message_step' => 1],
        ];
    }

    public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string
    {
        return 'order:'.$subject->id;
    }
}
