<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Phase 5 §2: ledger reasons order_shipped / order_returned and reference type `order` (P5-5).
 * The reason CHECK exists on Postgres only (sqlite has none), so only Postgres needs the drop / re-add.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check');
            DB::statement("ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('initial','received','correction','damaged','lost','returned','import','other','order_shipped','order_returned'))");
        }
    }

    public function down(): void
    {
        // Map the Phase 5 reasons onto the old set first (ledger rows are kept, never deleted), so the narrower
        // CHECK can be re-added on a database that already holds orders.
        DB::table('inventory_movements')->where('reason', 'order_returned')->update(['reason' => 'returned']);
        DB::table('inventory_movements')->where('reason', 'order_shipped')->update(['reason' => 'other']);

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_reason_check');
            DB::statement("ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_reason_check CHECK (reason IN ('initial','received','correction','damaged','lost','returned','import','other'))");
        }
    }
};
