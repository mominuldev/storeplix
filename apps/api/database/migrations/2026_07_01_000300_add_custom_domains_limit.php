<?php

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;

/** PHASE-6-CONTRACT §3.3 (Q70): plans gain the `custom_domains` limit (Free 0, Starter 2, Growth 5). */
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
