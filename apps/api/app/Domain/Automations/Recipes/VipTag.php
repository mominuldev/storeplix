<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Stores\Models\Store;

/**
 * `vip_tag` "Tag VIP buyers" (§3): delivered + the customer reached n deliveries and doesn't have the tag → add the tag
 * → optional message with a coupon. Dedupe `customer:{id}` (once per customer while the automation exists) for a run
 * whose conditions hold; an evaluation whose conditions fail is logged per delivery (`order:{id}`), so it never blocks
 * the customer's later qualifying delivery.
 */
final class VipTag extends Recipe
{
    public function key(): string
    {
        return 'vip_tag';
    }

    public function name(): string
    {
        return 'Tag VIP buyers';
    }

    public function description(): string
    {
        return 'Tag repeat buyers as VIP after a number of deliveries and send them a coupon.';
    }

    public function icon(): string
    {
        return 'star';
    }

    public function trigger(): string
    {
        return 'order.delivered';
    }

    public function triggerDescription(): string
    {
        return 'A parcel is delivered and the buyer reached the number of delivered orders.';
    }

    public function triggerLabel(array $settings): string
    {
        return self::ordinal((int) ($settings['min_delivered'] ?? 5)).' delivery';
    }

    public function actionLabel(array $settings): string
    {
        $tag = 'Tag '.trim((string) ($settings['tag'] ?? 'VIP'));

        return ($settings['message']['enabled'] ?? false) ? $tag.' + coupon' : $tag;
    }

    public function conditionFields(): array
    {
        return ['customer.delivered_orders_count'];
    }

    public function mergeFields(): array
    {
        return ['{name}', '{coupon}', '{shop_link}'];
    }

    public function subjectTypes(): array
    {
        return ['order'];
    }

    public function defaults(string $language): array
    {
        return [
            'min_delivered' => 5,
            'tag' => 'VIP',
            'message' => [
                'enabled' => true, 'channel' => 'sms', 'language' => $language, 'subject' => null,
                'body' => $language === 'bn' ? '{name}, আপনি এখন আমাদের VIP! পরের অর্ডারে কোড {coupon} ব্যবহার করুন: {shop_link}'
                    : "Hi {name}, you're now a VIP! Use code {coupon} on your next order: {shop_link}",
            ],
            'coupon_id' => null,
        ];
    }

    protected function rules(): array
    {
        return [
            '' => ['required', 'array:min_delivered,tag,message,coupon_id'],
            'min_delivered' => ['required', 'integer:strict', 'min:2', 'max:50'],
            'tag' => self::tagRules(),
            'coupon_id' => ['present', 'nullable', 'string', 'size:26'],
        ] + self::messageRules('message', withEnabled: true);
    }

    protected function finish(Store $store, array $settings): array
    {
        $coupon = self::coupon($store, $settings['coupon_id'], 'coupon_id');

        return [
            'min_delivered' => (int) $settings['min_delivered'],
            'tag' => trim((string) $settings['tag']),
            'message' => ['enabled' => (bool) $settings['message']['enabled']] + $this->message($store, $settings['message'], 'message', $coupon),
            'coupon_id' => $coupon?->id,
        ];
    }

    public function incomplete(array $settings): array
    {
        if (! ($settings['message']['enabled'] ?? false)) {
            return [];
        }
        $missing = [];
        if (($settings['coupon_id'] ?? null) === null) {
            $missing[] = 'coupon_id';
        }
        if (! self::usesCoupon($settings['message'])) {
            $missing[] = 'message.body';
        }

        return $missing;
    }

    public function conditions(array $settings): array
    {
        return [
            ['field' => 'customer.delivered_orders_count', 'op' => 'gte', 'value' => (int) ($settings['min_delivered'] ?? 5)],
            // implicit (§3): the customer doesn't have the tag yet
            ['field' => 'customer.tag', 'op' => 'not_has', 'value' => (string) ($settings['tag'] ?? 'VIP')],
        ];
    }

    public function flow(array $settings): array
    {
        return [
            ['kind' => 'add_tag', 'index' => 1, 'tag' => (string) ($settings['tag'] ?? 'VIP')],
            ['kind' => 'send_message', 'index' => 2, 'message_step' => 1, 'enabled' => (bool) ($settings['message']['enabled'] ?? false), 'message' => $settings['message'] ?? [], 'coupon_id' => $settings['coupon_id'] ?? null],
        ];
    }

    public function schemaSteps(): array
    {
        return [
            ['kind' => 'add_tag', 'title' => 'Tag the customer', 'description' => 'Adds the tag to the customer.', 'optional' => false, 'message_step' => null],
            ['kind' => 'send_message', 'title' => 'Send a coupon', 'description' => 'A thank-you SMS with a coupon code.', 'optional' => true, 'message_step' => 1],
        ];
    }

    public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string
    {
        return $conditionsPassed && $subject->customer !== null ? 'customer:'.$subject->customer->id : 'order:'.$subject->id;
    }

    private static function ordinal(int $n): string
    {
        $suffix = match (true) {
            $n % 100 >= 11 && $n % 100 <= 13 => 'th',
            $n % 10 === 1 => 'st',
            $n % 10 === 2 => 'nd',
            $n % 10 === 3 => 'rd',
            default => 'th',
        };

        return $n.$suffix;
    }
}
