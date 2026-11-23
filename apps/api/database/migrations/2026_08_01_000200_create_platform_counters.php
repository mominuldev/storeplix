<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-7-CONTRACT §5.1 000200: platform counters (no tenant_id, no RLS, B26). Keys `billing_invoice:{YYYY}` for the
 * gapless global invoice numbers; only InvoiceNumberAllocator writes it. The app role may SELECT, INSERT, UPDATE.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('platform_counters', function (Blueprint $table) {
            $table->string('key', 64)->primary();
            $table->bigInteger('value');
            $table->timestampTz('updated_at')->nullable();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql' && RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('REVOKE ALL ON platform_counters FROM '.RlsPolicies::APP_ROLE);
            $db->statement('GRANT SELECT, INSERT, UPDATE ON platform_counters TO '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('platform_counters');
    }
};
