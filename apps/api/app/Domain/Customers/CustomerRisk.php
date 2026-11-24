<?php

declare(strict_types=1);

namespace App\Domain\Customers;

use App\Domain\Customers\Models\Customer;
use App\Domain\FraudGuard\RiskTier;

/**
 * @deprecated PHASE-8-8 P88-3: replaced by {@see RiskTier} (one risk everywhere, P88-4 rule). Thin alias kept for one
 *             release; removed in 8.8b. `classify()` uses the default thresholds; `of()` the customer's store thresholds.
 */
final class CustomerRisk
{
    public const GOOD = RiskTier::GOOD;

    public const CAREFUL = RiskTier::CAREFUL;

    public const RISKY = RiskTier::RISKY;

    public static function classify(int $delivered, int $returned): string
    {
        return RiskTier::classify($delivered, $returned);
    }

    public static function of(Customer $customer): string
    {
        return RiskTier::forCustomer($customer);
    }

    /** SQL condition: the customer is `risky` (default thresholds). */
    public static function riskySql(string $prefix = ''): string
    {
        return RiskTier::sql(RiskTier::RISKY, null, $prefix);
    }

    /** SQL condition: the customer is `careful` (default thresholds). */
    public static function carefulSql(string $prefix = ''): string
    {
        return RiskTier::sql(RiskTier::CAREFUL, null, $prefix);
    }
}
