<?php

namespace Database\Seeders;

use App\Domain\Billing\Models\Plan;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Schema;

/** Idempotent (updateOrCreate by code). Values from Figma Settings → Plan & billing 60:16361; sms_per_month P5-26 / Q33; custom_domains P6-7 / Q70; campaign_* P85-13 / Q140; price_yearly_amount P7-3 (10 × monthly); purchasing PHASE-8-8B §2.2 (Starter + Growth). */
class PlanSeeder extends Seeder
{
    public function run(): void
    {
        $starterFeatures = ['custom_domain', 'all_couriers', 'bulk_courier_booking', 'fake_order_guard', 'sms_automation', 'purchasing'];

        $plans = [
            [
                'code' => 'free', 'name' => 'Free', 'price_amount' => 0, 'price_yearly_amount' => null, 'sort' => 1,
                'limits' => ['orders_per_month' => 50, 'staff_seats' => 5, 'products' => 100, 'courier_connections' => 1, 'sms_per_month' => 200, 'custom_domains' => 0, 'campaign_sms_per_month' => 0, 'campaign_emails_per_month' => 0],
                'features' => [],
            ],
            [
                'code' => 'starter', 'name' => 'Starter', 'price_amount' => 49900, 'price_yearly_amount' => 499000, 'sort' => 2,
                'limits' => ['orders_per_month' => 500, 'staff_seats' => 5, 'products' => 1000, 'courier_connections' => null, 'sms_per_month' => 2000, 'custom_domains' => 2, 'campaign_sms_per_month' => 1000, 'campaign_emails_per_month' => 5000],
                'features' => $starterFeatures,
            ],
            [
                'code' => 'growth', 'name' => 'Growth', 'price_amount' => 149900, 'price_yearly_amount' => 1499000, 'sort' => 3,
                'limits' => ['orders_per_month' => null, 'staff_seats' => 15, 'products' => null, 'courier_connections' => null, 'sms_per_month' => null, 'custom_domains' => 5, 'campaign_sms_per_month' => 5000, 'campaign_emails_per_month' => 20000],
                'features' => [...$starterFeatures, 'custom_roles', 'multi_warehouse', 'pos', 'profit_reports', 'api_webhooks'],
            ],
        ];

        $hasYearly = Schema::hasColumn('plans', 'price_yearly_amount'); // seeded by migrations that predate Phase 7 too
        foreach ($plans as $plan) {
            if (! $hasYearly) {
                unset($plan['price_yearly_amount']);
            }
            Plan::query()->updateOrCreate(['code' => $plan['code']], $plan + ['currency' => 'BDT', 'interval' => 'month', 'is_active' => true]);
        }
    }
}
