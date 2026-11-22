<?php

namespace Database\Seeders;

use App\Domain\Billing\Models\Plan;
use Illuminate\Database\Seeder;

/** Idempotent (updateOrCreate by code). Values from Figma Settings → Plan & billing 60:16361; sms_per_month P5-26 / Q33; custom_domains P6-7 / Q70. */
class PlanSeeder extends Seeder
{
    public function run(): void
    {
        $starterFeatures = ['custom_domain', 'all_couriers', 'bulk_courier_booking', 'fake_order_guard', 'sms_automation'];

        $plans = [
            [
                'code' => 'free', 'name' => 'Free', 'price_amount' => 0, 'sort' => 1,
                'limits' => ['orders_per_month' => 50, 'staff_seats' => 5, 'products' => 100, 'courier_connections' => 1, 'sms_per_month' => 200, 'custom_domains' => 0],
                'features' => [],
            ],
            [
                'code' => 'starter', 'name' => 'Starter', 'price_amount' => 49900, 'sort' => 2,
                'limits' => ['orders_per_month' => 500, 'staff_seats' => 5, 'products' => 1000, 'courier_connections' => null, 'sms_per_month' => 2000, 'custom_domains' => 2],
                'features' => $starterFeatures,
            ],
            [
                'code' => 'growth', 'name' => 'Growth', 'price_amount' => 149900, 'sort' => 3,
                'limits' => ['orders_per_month' => null, 'staff_seats' => 15, 'products' => null, 'courier_connections' => null, 'sms_per_month' => null, 'custom_domains' => 5],
                'features' => [...$starterFeatures, 'custom_roles', 'multi_warehouse', 'pos', 'profit_reports', 'api_webhooks'],
            ],
        ];

        foreach ($plans as $plan) {
            Plan::query()->updateOrCreate(['code' => $plan['code']], $plan + ['currency' => 'BDT', 'interval' => 'month', 'is_active' => true]);
        }
    }
}
