<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.1 / §5.7: per integration, store-timezone day and canonical event: browser (beacon) count and server
 * sent / failed / skipped. Upserted with increments (ON CONFLICT … DO UPDATE SET x = x + excluded.x). 90 days. [S].
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tracking_daily_stats', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('store_integration_id');
            $table->date('date');
            $table->string('event_name', 16);
            $table->integer('browser_count')->default(0);
            $table->integer('server_sent')->default(0);
            $table->integer('server_failed')->default(0);
            $table->integer('server_skipped')->default(0);
            $table->timestampTz('last_at')->nullable();

            $table->unique(['store_integration_id', 'date', 'event_name'], 'tracking_daily_stats_unique');
            $table->index(['tenant_id', 'store_integration_id', 'date']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_integration_id'])->references(['tenant_id', 'id'])->on('store_integrations')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            RlsPolicies::enable(DB::connection(), 'tracking_daily_stats');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('tracking_daily_stats');
    }
};
