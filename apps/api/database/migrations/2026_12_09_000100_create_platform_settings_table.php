<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-1 amendment A1-2: platform settings (no tenant_id, no RLS; RlsTables::PLATFORM). Key/value rows, first key
 * `staff_two_factor_required`. The app role may only SELECT (sign-in and `me` read it); writes go through the admin
 * connection from the admin API (PlatformSettings::set).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('platform_settings', function (Blueprint $table) {
            $table->string('key', 64)->primary();
            $table->jsonb('value');
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('updated_at')->nullable();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql' && RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('REVOKE ALL ON platform_settings FROM '.RlsPolicies::APP_ROLE);
            $db->statement('GRANT SELECT ON platform_settings TO '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        Schema::dropIfExists('platform_settings');
    }
};
