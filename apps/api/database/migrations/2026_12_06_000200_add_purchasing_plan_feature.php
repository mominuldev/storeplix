<?php

declare(strict_types=1);

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-8B §2.2 / P88B-12 (amends PHASE-7 §2.1): the new plan feature `purchasing` on Starter and Growth, written
 * to the existing plan rows through the idempotent PlanSeeder (same as the earlier plan migrations).
 * `data_imports.type` gains `suppliers` (P88B-15; the CHECK exists on Postgres only).
 */
return new class extends Migration
{
    public function up(): void
    {
        (new PlanSeeder)->run();

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE data_imports DROP CONSTRAINT IF EXISTS data_imports_type_check');
            DB::statement("ALTER TABLE data_imports ADD CONSTRAINT data_imports_type_check CHECK (type IN ('products','customers','suppliers'))");
        }
    }

    public function down(): void
    {
        // Reference data only; the extra feature key and the wider CHECK are harmless.
    }
};
