<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-8-9D §3.1 / §7.4: one row per feed sync run (full hourly, 5-minute deltas, manual). 90 days. [S], forced RLS. */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('catalog_sync_runs', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('store_integration_id');
            $table->string('kind', 8);
            $table->string('trigger', 16);
            $table->string('status', 8);
            $table->integer('items_sent')->default(0);
            $table->integer('items_failed')->default(0);
            $table->integer('items_deleted')->default(0);
            $table->string('error_code', 32)->nullable();
            $table->timestampTz('started_at');
            $table->timestampTz('finished_at')->nullable();

            $table->index(['tenant_id', 'store_integration_id', 'started_at', 'id'], 'catalog_sync_runs_list_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_integration_id'])->references(['tenant_id', 'id'])->on('store_integrations')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        foreach ([
            "catalog_sync_runs ADD CONSTRAINT catalog_sync_runs_kind_check CHECK (kind IN ('full','delta','manual'))",
            "catalog_sync_runs ADD CONSTRAINT catalog_sync_runs_trigger_check CHECK (trigger IN ('schedule','price_change','stock_change','product_change','manual','connect'))",
            "catalog_sync_runs ADD CONSTRAINT catalog_sync_runs_status_check CHECK (status IN ('running','done','partial','failed'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS catalog_sync_runs_list_index');
        $db->statement('CREATE INDEX catalog_sync_runs_list_index ON catalog_sync_runs (tenant_id, store_integration_id, started_at DESC, id DESC)');
        RlsPolicies::enable($db, 'catalog_sync_runs');
    }

    public function down(): void
    {
        Schema::dropIfExists('catalog_sync_runs');
    }
};
