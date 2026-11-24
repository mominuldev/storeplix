<?php

declare(strict_types=1);

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;

/**
 * PHASE-8-5-CONTRACT §7.2 / P85-13 (amends PHASE-7 §2.1): plans gain `campaign_sms_per_month` (SMS parts; Free 0,
 * Starter 1,000, Growth 5,000) and `campaign_emails_per_month` (Free 0, Starter 5,000, Growth 20,000) through the
 * idempotent PlanSeeder (plan limits are written only by billing code; same as the 5a / Phase 6 limit migrations).
 * `sms_messages.purpose` gains the value `campaign` (no CHECK exists; documentation only).
 */
return new class extends Migration
{
    public function up(): void
    {
        (new PlanSeeder)->run();
    }

    public function down(): void
    {
        // Reference data only; the extra limit keys are harmless.
    }
};
