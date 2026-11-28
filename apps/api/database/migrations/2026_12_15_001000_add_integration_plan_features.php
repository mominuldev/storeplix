<?php

declare(strict_types=1);

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;

/**
 * PHASE-8-9D §2 / P89D-40 / P89D-33 (amends PHASE-7 §2.1): features `product_feeds` (Starter, Growth) and
 * `server_side_tagging` (Growth), limit `ai_credits_per_month` (Free 20 · Starter 300 · Growth 1,500), written to the
 * existing plan rows through the idempotent PlanSeeder (same as the earlier plan migrations).
 */
return new class extends Migration
{
    public function up(): void
    {
        (new PlanSeeder)->run();
    }

    public function down(): void
    {
        // Reference data only; the extra feature and limit keys are harmless.
    }
};
