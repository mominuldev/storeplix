<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8-CONTRACT §4 (P88-2): the hold FLAG on orders (no new order status) — `guard_hold` ∈ call_first, advance,
 * checking, null + `guard_hold_at`; a partial index for `filter[guard_hold]`, `meta.counts.held` and the
 * `fraud:resolve-stale` sweep. order_events.type gains `guard` (the CHECK is re-created as in 2026_06_01_001800).
 */
return new class extends Migration
{
    private const TYPES = "'placed','status_changed','note','edited','payment','refund','shipment','notification','coupon_released','payment_link','items_edited','return','document'";

    public function up(): void
    {
        Schema::table('orders', function (Blueprint $table) {
            $table->string('guard_hold', 12)->nullable();
            $table->timestampTz('guard_hold_at')->nullable();
        });
        DB::statement('CREATE INDEX orders_guard_hold_index ON orders (tenant_id, store_id, guard_hold) WHERE guard_hold IS NOT NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE orders ADD CONSTRAINT orders_guard_hold_check CHECK (guard_hold IS NULL OR guard_hold IN ('call_first','advance','checking'))");
            DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_type_check');
            DB::statement('ALTER TABLE order_events ADD CONSTRAINT order_events_type_check CHECK (type IN ('.self::TYPES.",'guard'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            // order_events are append-only history: the narrower CHECK is re-added NOT VALID so `guard` rows survive.
            DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_type_check');
            DB::statement('ALTER TABLE order_events ADD CONSTRAINT order_events_type_check CHECK (type IN ('.self::TYPES.')) NOT VALID');
            DB::statement('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_guard_hold_check');
        }
        DB::statement('DROP INDEX IF EXISTS orders_guard_hold_index');
        Schema::table('orders', function (Blueprint $table) {
            $table->dropColumn(['guard_hold', 'guard_hold_at']);
        });
    }
};
