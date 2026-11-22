<?php

namespace App\Domain\Pricing;

/**
 * Pure pricing (P5-4, P5-9, P5-12): line availability, subtotal, coupon discount with exact largest-remainder
 * allocation, shipping after free-delivery rules, and totals. No database access: callers pass plain data, so the
 * storefront cart, checkout, manual orders and the quote all price through the same code.
 *
 * Line input:
 *   key (any), variant_id, product_id, category_ids (list), quantity, price (paisa), compare_at (?int),
 *   purchasable (bool: product sellable and variant enabled), tracked, backorder, available (on_hand − committed),
 *   threshold (low-stock threshold)
 * Coupon input (or null):
 *   type (percentage|fixed|free_shipping), percent_bps, amount, max_discount_amount, applies_to (all|categories|products),
 *   product_ids (list, applies_to = products), category_ids (list incl. descendants, applies_to = categories)
 */
final class CartPricer
{
    /**
     * @param  list<array<string, mixed>>  $lines
     * @param  array<string, mixed>|null  $coupon
     * @return array{lines: list<array<string, mixed>>, subtotal: int, eligible_subtotal: int, discount: int, compare_savings: int, has_issues: bool, priced_count: int}
     */
    public static function price(array $lines, ?array $coupon = null): array
    {
        $out = [];
        $subtotal = 0;
        $eligibleSubtotal = 0;
        $compareSavings = 0;
        $hasIssues = false;
        $priced = 0;
        foreach ($lines as $i => $line) {
            $quantity = (int) $line['quantity'];
            $price = (int) $line['price'];
            $compare = isset($line['compare_at']) && $line['compare_at'] !== null && (int) $line['compare_at'] > $price ? (int) $line['compare_at'] : null;
            $limited = ($line['tracked'] ?? false) && ! ($line['backorder'] ?? false);
            $available = (int) ($line['available'] ?? 0);

            $issue = null;
            $maxQuantity = null;
            if (! ($line['purchasable'] ?? false)) {
                $issue = 'unavailable';
            } elseif ($limited && $available < $quantity) {
                $issue = 'insufficient_stock';
                $maxQuantity = max(0, $available);
            }
            $threshold = (int) ($line['threshold'] ?? 5);
            $lowStock = $limited && $available > 0 && $available <= $threshold ? $available : null;

            $amount = $price * $quantity;
            $eligible = $issue === null && $coupon !== null && $coupon['type'] !== 'free_shipping' && self::eligible($line, $coupon);
            if ($issue === null) {
                $subtotal += $amount;
                $priced++;
                if ($compare !== null) {
                    $compareSavings += ($compare - $price) * $quantity;
                }
                if ($eligible) {
                    $eligibleSubtotal += $amount;
                }
            } else {
                $hasIssues = true;
            }

            $out[] = [
                'key' => $line['key'] ?? $i,
                'index' => $i,
                'unit_price_amount' => $price,
                'compare_at_amount' => $compare,
                'line_amount' => $amount,
                'issue' => $issue,
                'max_quantity' => $maxQuantity,
                'low_stock' => $lowStock,
                'eligible' => $eligible,
                'discount_amount' => 0,
            ];
        }

        $discount = $coupon === null ? 0 : self::discount($coupon, $eligibleSubtotal);
        if ($discount > 0) {
            $shares = self::allocate($discount, array_map(fn ($l) => $l['eligible'] ? $l['line_amount'] : 0, $out));
            foreach ($shares as $i => $share) {
                $out[$i]['discount_amount'] = $share;
            }
        }

        return [
            'lines' => $out,
            'subtotal' => $subtotal,
            'eligible_subtotal' => $eligibleSubtotal,
            'discount' => $discount,
            'compare_savings' => $compareSavings,
            'has_issues' => $hasIssues,
            'priced_count' => $priced,
        ];
    }

    /** @param array<string, mixed> $line @param array<string, mixed> $coupon */
    public static function eligible(array $line, array $coupon): bool
    {
        return match ($coupon['applies_to'] ?? 'all') {
            'products' => in_array($line['product_id'] ?? null, $coupon['product_ids'] ?? [], true),
            'categories' => array_intersect($line['category_ids'] ?? [], $coupon['category_ids'] ?? []) !== [],
            default => true,
        };
    }

    /**
     * P5-12: percentage = floor(E × bps / 10 000), then the cap, then E. Fixed = min(amount, E). Free shipping = 0
     * (its value is the shipping charge, see shipping()).
     *
     * @param  array<string, mixed>  $coupon
     */
    public static function discount(array $coupon, int $eligibleSubtotal): int
    {
        if ($eligibleSubtotal <= 0) {
            return 0;
        }

        return match ($coupon['type']) {
            'percentage' => min(
                (int) bcdiv(bcmul((string) $eligibleSubtotal, (string) (int) $coupon['percent_bps']), '10000', 0),
                $coupon['max_discount_amount'] !== null ? (int) $coupon['max_discount_amount'] : PHP_INT_MAX,
                $eligibleSubtotal,
            ),
            'fixed' => min((int) $coupon['amount'], $eligibleSubtotal),
            default => 0,
        };
    }

    /**
     * Largest-remainder allocation of $total over $weights (P5-12): floor shares, then the leftover units go to the
     * largest remainders, ties to the lower index. Σ result = $total exactly. Zero weights get zero.
     *
     * @param  list<int>  $weights
     * @return list<int>
     */
    public static function allocate(int $total, array $weights): array
    {
        $sum = array_sum($weights);
        if ($sum <= 0 || $total <= 0) {
            return array_fill(0, count($weights), 0);
        }
        $shares = [];
        $remainders = [];
        $given = 0;
        foreach ($weights as $i => $w) {
            $product = bcmul((string) $total, (string) $w);
            $shares[$i] = (int) bcdiv($product, (string) $sum, 0);
            $remainders[$i] = bcmod($product, (string) $sum);
            $given += $shares[$i];
        }
        $order = array_keys($weights);
        usort($order, fn ($a, $b) => bccomp($remainders[$b], $remainders[$a]) ?: $a <=> $b);
        $left = $total - $given;
        foreach ($order as $i) {
            if ($left <= 0) {
                break;
            }
            if ($weights[$i] > 0) {
                $shares[$i]++;
                $left--;
            }
        }

        return $shares;
    }

    /**
     * Shipping after P5-9 (free delivery over the threshold, merchandise subtotal after discount) and a free-shipping
     * coupon. An override (manual orders) replaces the computed charge.
     *
     * @return array{shipping: int, shipping_discount: int, coupon_shipping_discount: int, free_by_threshold: bool}
     */
    public static function shipping(int $charge, ?int $freeOver, int $merchandiseAfterDiscount, bool $freeShippingCoupon, ?int $override = null): array
    {
        if ($override !== null) {
            return ['shipping' => $override, 'shipping_discount' => 0, 'coupon_shipping_discount' => 0, 'free_by_threshold' => false];
        }
        $byThreshold = $freeOver !== null && $merchandiseAfterDiscount >= $freeOver;
        if ($byThreshold) {
            return ['shipping' => 0, 'shipping_discount' => $charge, 'coupon_shipping_discount' => 0, 'free_by_threshold' => true];
        }
        if ($freeShippingCoupon) {
            return ['shipping' => 0, 'shipping_discount' => $charge, 'coupon_shipping_discount' => $charge, 'free_by_threshold' => false];
        }

        return ['shipping' => $charge, 'shipping_discount' => 0, 'coupon_shipping_discount' => 0, 'free_by_threshold' => false];
    }
}
