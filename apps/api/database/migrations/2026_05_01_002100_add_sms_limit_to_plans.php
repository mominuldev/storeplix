<?php

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;

/** Phase 5 (P5-26 / Q33): plans gain the `sms_per_month` limit (Free 200, Starter 2 000, Growth unlimited). */
return new class extends Migration
{
    public function up(): void
    {
        (new PlanSeeder)->run();
    }

    public function down(): void
    {
        // Reference data only; the extra limit key is harmless.
    }
};
