<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9D §3.3 (P89D-44), forward-only: Nagad is the third gateway. The provider / payment-method CHECKs gain
 * `nagad` (Postgres only; sqlite has no CHECKs for these columns) and the "one open online attempt per order" partial
 * unique index (P5B-20, both drivers) covers Nagad charges too. `media.purpose` has no CHECK: `ai_photo` needs no change.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('DROP INDEX IF EXISTS payments_open_online_charge_unique');
        DB::statement("CREATE UNIQUE INDEX payments_open_online_charge_unique ON payments (order_id) WHERE type = 'charge' AND status = 'pending' AND provider IN ('bkash','sslcommerz','nagad')");

        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        $db = DB::connection();
        foreach ([
            'payment_gateway_accounts DROP CONSTRAINT IF EXISTS payment_gateway_accounts_provider_check',
            "payment_gateway_accounts ADD CONSTRAINT payment_gateway_accounts_provider_check CHECK (provider IN ('bkash','sslcommerz','nagad'))",
            'payments DROP CONSTRAINT IF EXISTS payments_provider_check',
            "payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cod','manual','bkash','sslcommerz','nagad'))",
            'payment_links DROP CONSTRAINT IF EXISTS payment_links_provider_check',
            "payment_links ADD CONSTRAINT payment_links_provider_check CHECK (provider IN ('bkash','sslcommerz','nagad'))",
            'webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check',
            "webhook_events ADD CONSTRAINT webhook_events_provider_check CHECK (provider IN ('bkash','sslcommerz','nagad','steadfast','pathao','redx'))",
            'orders DROP CONSTRAINT IF EXISTS orders_payment_method_check',
            "orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cod','bkash','sslcommerz','nagad','pos'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS payments_open_online_charge_unique');
        DB::statement("CREATE UNIQUE INDEX payments_open_online_charge_unique ON payments (order_id) WHERE type = 'charge' AND status = 'pending' AND provider IN ('bkash','sslcommerz')");
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        $db = DB::connection();
        foreach ([
            'payment_gateway_accounts DROP CONSTRAINT IF EXISTS payment_gateway_accounts_provider_check',
            "payment_gateway_accounts ADD CONSTRAINT payment_gateway_accounts_provider_check CHECK (provider IN ('bkash','sslcommerz')) NOT VALID",
            'payments DROP CONSTRAINT IF EXISTS payments_provider_check',
            "payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cod','manual','bkash','sslcommerz')) NOT VALID",
            'payment_links DROP CONSTRAINT IF EXISTS payment_links_provider_check',
            "payment_links ADD CONSTRAINT payment_links_provider_check CHECK (provider IN ('bkash','sslcommerz')) NOT VALID",
            'webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check',
            "webhook_events ADD CONSTRAINT webhook_events_provider_check CHECK (provider IN ('bkash','sslcommerz','steadfast','pathao','redx')) NOT VALID",
            'orders DROP CONSTRAINT IF EXISTS orders_payment_method_check',
            "orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cod','bkash','sslcommerz','pos')) NOT VALID",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
    }
};
