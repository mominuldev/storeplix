<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Customers\CustomerRisk;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use Illuminate\Validation\ValidationException;

/**
 * The fixed condition list (PHASE-8-6 §5): `{field, op, value}`, all must hold, ≤ 5, evaluated on the subject at run
 * time. Unknown field/op → 422. Results feed `outcome_detail.conditions` and the dry run.
 */
final class Conditions
{
    /** field → allowed ops */
    public const OPS = [
        'order.total_amount' => ['gt', 'lt'],
        'order.payment_method' => ['is'],
        'order.channel' => ['in'],
        'customer.tag' => ['has', 'not_has'],
        'customer.delivered_orders_count' => ['gte'],
        'customer.risk' => ['is_not'],
    ];

    /**
     * Validates a merchant-written list against the recipe's allowed fields; returns it normalized.
     *
     * @param  list<string>  $allowed
     * @param  mixed  $conditions  passed the shape rules (list of {field, op, value})
     * @return list<array{field: string, op: string, value: mixed}>
     */
    public static function validate(array $allowed, mixed $conditions, string $path): array
    {
        $out = [];
        foreach ((array) $conditions as $i => $c) {
            $field = (string) ($c['field'] ?? '');
            $op = (string) ($c['op'] ?? '');
            $value = $c['value'] ?? null;
            $at = "{$path}.{$i}";
            if (! in_array($field, $allowed, true)) {
                throw ValidationException::withMessages(["{$at}.field" => ['This condition is not available for this recipe.']]);
            }
            if (! in_array($op, self::OPS[$field], true)) {
                throw ValidationException::withMessages(["{$at}.op" => ['Choose a valid comparison.']]);
            }
            $value = match ($field) {
                'order.total_amount' => is_int($value) && $value >= 0 ? $value : self::bad("{$at}.value", 'Enter an amount of 0 or more.'),
                'order.payment_method' => in_array($value, ['cod', 'online'], true) ? $value : self::bad("{$at}.value", 'Choose cash on delivery or online.'),
                'order.channel' => is_array($value) && $value !== [] && array_is_list($value) && array_diff($value, Order::CHANNELS) === []
                    ? array_values(array_unique($value)) : self::bad("{$at}.value", 'Choose at least one order channel.'),
                'customer.tag' => is_string($value) && trim($value) !== '' && mb_strlen(trim($value)) <= 40 && preg_match('/[\x00-\x1F\x7F]/', $value) !== 1
                    ? trim($value) : self::bad("{$at}.value", 'Enter a tag (up to 40 characters).'),
                'customer.delivered_orders_count' => is_int($value) && $value >= 2 && $value <= 50 ? $value : self::bad("{$at}.value", 'Enter a number from 2 to 50.'),
                'customer.risk' => $value === 'risky' ? $value : self::bad("{$at}.value", 'Only risky customers can be skipped.'),
            };
            $out[] = ['field' => $field, 'op' => $op, 'value' => $value];
        }

        return $out;
    }

    /**
     * @param  list<array{field: string, op: string, value: mixed}>  $conditions
     * @return array{passed: bool, results: list<array{field: string, label: string, passed: bool, detail: string|null}>}
     */
    public static function evaluate(array $conditions, Subject $subject): array
    {
        $results = [];
        foreach ($conditions as $c) {
            [$passed, $detail] = self::one($c, $subject);
            $results[] = ['field' => $c['field'], 'label' => self::label($c, $subject), 'passed' => $passed, 'detail' => $detail];
        }

        return ['passed' => ! in_array(false, array_column($results, 'passed'), true), 'results' => $results];
    }

    /** @param array{field: string, op: string, value: mixed} $c @return array{0: bool, 1: string|null} */
    private static function one(array $c, Subject $subject): array
    {
        $order = $subject->order;
        $customer = $subject->customer;
        $tags = array_map(fn ($t) => mb_strtolower((string) $t), (array) ($customer?->tags ?? []));

        return match ($c['field']) {
            'order.total_amount' => $order === null ? [false, 'No order'] : [
                $c['op'] === 'gt' ? $order->total_amount > (int) $c['value'] : $order->total_amount < (int) $c['value'],
                'Order total '.Money::bdt((int) $order->total_amount),
            ],
            'order.payment_method' => $order === null ? [false, 'No order'] : [
                ($order->payment_method === 'cod' ? 'cod' : 'online') === $c['value'],
                $order->payment_method === 'cod' ? 'Cash on delivery' : 'Paid online',
            ],
            'order.channel' => $order === null ? [false, 'No order'] : [in_array($order->channel, (array) $c['value'], true), 'Channel '.$order->channel],
            'customer.tag' => match (true) {
                $customer === null => [$c['op'] === 'not_has', 'No customer'],
                default => [
                    $c['op'] === 'has' ? in_array(mb_strtolower((string) $c['value']), $tags, true) : ! in_array(mb_strtolower((string) $c['value']), $tags, true),
                    in_array(mb_strtolower((string) $c['value']), $tags, true) ? 'Has the tag' : 'Does not have the tag',
                ],
            },
            'customer.delivered_orders_count' => $customer === null ? [false, 'No customer'] : [
                (int) $customer->delivered_orders_count >= (int) $c['value'],
                (int) $customer->delivered_orders_count.' delivered '.((int) $customer->delivered_orders_count === 1 ? 'order' : 'orders'),
            ],
            // P86-11: "Skip risky customers" applies when the phone matches a customer; an unknown contact passes.
            'customer.risk' => $customer === null ? [true, 'Not a customer yet'] : [
                CustomerRisk::of($customer) !== CustomerRisk::RISKY,
                'Risk: '.CustomerRisk::of($customer),
            ],
            default => [false, null],
        };
    }

    /** @param array{field: string, op: string, value: mixed} $c */
    private static function label(array $c, Subject $subject): string
    {
        $v = $c['value'];

        return match ($c['field']) {
            'order.total_amount' => 'Order total '.($c['op'] === 'gt' ? 'above ' : 'below ').Money::bdt((int) $v),
            'order.payment_method' => 'Payment is '.($v === 'cod' ? 'cash on delivery' : 'online'),
            'order.channel' => 'Order channel is '.implode(', ', (array) $v),
            'customer.tag' => 'Customer '.($c['op'] === 'has' ? 'has' : "doesn't have").' tag "'.$v.'"',
            'customer.delivered_orders_count' => 'Customer has '.(int) $v.'+ delivered orders',
            'customer.risk' => 'Customer is not risky',
            default => $c['field'],
        };
    }

    private static function bad(string $key, string $message): never
    {
        throw ValidationException::withMessages([$key => [$message]]);
    }
}
