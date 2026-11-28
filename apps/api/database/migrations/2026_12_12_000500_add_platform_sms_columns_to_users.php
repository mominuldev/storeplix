<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9B §3.2 (P89B-21, §3.3): per-user opt-out of Store Plix promotional SMS (source account | link) and the
 * once-only welcome SMS claim.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->timestampTz('platform_promo_sms_opted_out_at')->nullable();
            $table->string('platform_promo_sms_opt_out_source', 8)->nullable();
            $table->timestampTz('welcome_sms_at')->nullable();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE users ADD CONSTRAINT users_promo_sms_opt_out_source_check CHECK (platform_promo_sms_opt_out_source IS NULL OR platform_promo_sms_opt_out_source IN ('account','link'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_promo_sms_opt_out_source_check');
        }
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['platform_promo_sms_opted_out_at', 'platform_promo_sms_opt_out_source', 'welcome_sms_at']);
        });
    }
};
