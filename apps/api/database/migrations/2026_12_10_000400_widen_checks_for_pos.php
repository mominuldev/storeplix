<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8D §3.2 (part A), forward-only:
 * - orders: `created_via` and `payment_method` gain `pos`; walk-in sentinels (empty phone / district, P88D-10) are
 *   allowed ONLY on till sales (`orders_pos_sentinels_check`, S205).
 * - payments: `pos_session_id` (the till session the money went into or out of) with a store-scoped FK and a partial
 *   index; method gains `card` (P88D-9).
 * - inventory_movements: reason gains `pos_sale` (P88D-6).
 * CHECKs and FKs on Postgres only (sqlite has none for these columns, as before).
 */
return new class extends Migration
{
    private const REASONS_8C = "'initial','received','correction','damaged','lost','returned','import','other','order_shipped','order_returned','transfer_out','transfer_in','count'";

    private const METHODS_5B = "'cash','bkash_personal','nagad_personal','bank','other','gateway'";

    public function up(): void
    {
        Schema::table('payments', function (Blueprint $table) {
            $table->char('pos_session_id', 26)->nullable();
        });
        DB::statement('CREATE INDEX payments_pos_session_index ON payments (tenant_id, store_id, pos_session_id) WHERE pos_session_id IS NOT NULL');

        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        $db = DB::connection();
        foreach ([
            'orders DROP CONSTRAINT IF EXISTS orders_created_via_check',
            "orders ADD CONSTRAINT orders_created_via_check CHECK (created_via IN ('storefront','dashboard','pos'))",
            'orders DROP CONSTRAINT IF EXISTS orders_payment_method_check',
            "orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cod','bkash','sslcommerz','pos'))",
            "orders ADD CONSTRAINT orders_pos_sentinels_check CHECK (created_via = 'pos' OR (customer_phone <> '' AND district_code <> ''))",
            'payments ADD CONSTRAINT payments_pos_session_fk FOREIGN KEY (tenant_id, store_id, pos_session_id) REFERENCES pos_sessions (tenant_id, store_id, id) ON DELETE RESTRICT',
            'payments DROP CONSTRAINT IF EXISTS payments_method_check',
            'payments ADD CONSTRAINT payments_method_check CHECK (method IS NULL OR method IN ('.self::METHODS_5B.",'card'))",
            'inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check',
            'inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('.self::REASONS_8C.",'pos_sale'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            // Ledger and payment rows are history: map the new values onto the old sets before narrowing the CHECKs.
            $db->statement("UPDATE inventory_movements SET reason = 'other' WHERE reason = 'pos_sale'");
            $db->statement("UPDATE payments SET method = 'other' WHERE method = 'card'");
            foreach ([
                'inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check',
                'inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('.self::REASONS_8C.'))',
                'payments DROP CONSTRAINT IF EXISTS payments_method_check',
                'payments ADD CONSTRAINT payments_method_check CHECK (method IS NULL OR method IN ('.self::METHODS_5B.'))',
                'payments DROP CONSTRAINT IF EXISTS payments_pos_session_fk',
                'orders DROP CONSTRAINT IF EXISTS orders_pos_sentinels_check',
                'orders DROP CONSTRAINT IF EXISTS orders_payment_method_check',
                "orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cod','bkash','sslcommerz')) NOT VALID",
                'orders DROP CONSTRAINT IF EXISTS orders_created_via_check',
                "orders ADD CONSTRAINT orders_created_via_check CHECK (created_via IN ('storefront','dashboard')) NOT VALID",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
        }
        DB::statement('DROP INDEX IF EXISTS payments_pos_session_index');
        Schema::table('payments', function (Blueprint $table) {
            $table->dropColumn('pos_session_id');
        });
    }
};
