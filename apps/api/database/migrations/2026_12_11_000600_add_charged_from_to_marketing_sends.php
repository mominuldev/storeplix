<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.2, §4.5: campaign recipients and automation message steps record how the SMS was paid
 * (`charged_from` allowance | credits; null = before 8.9a = allowance, or an email). Credit-paid rows do not count
 * against the monthly campaign allowance (CampaignAllowance::used).
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['campaign_recipients', 'automation_run_steps'] as $table) {
            Schema::table($table, function (Blueprint $t) {
                $t->string('charged_from', 10)->nullable();
            });
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("ALTER TABLE {$table} ADD CONSTRAINT {$table}_charged_from_check CHECK (charged_from IS NULL OR charged_from IN ('allowance','credits'))");
            }
        }
    }

    public function down(): void
    {
        foreach (['campaign_recipients', 'automation_run_steps'] as $table) {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$table}_charged_from_check");
            }
            Schema::table($table, function (Blueprint $t) {
                $t->dropColumn('charged_from');
            });
        }
    }
};
