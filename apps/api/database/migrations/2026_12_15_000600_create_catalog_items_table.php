<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.1 (P89D-27 – P89D-30): one feed item per variant and integration. product / variant ids are soft refs so
 * a deleted product can still be deleted remotely. `content_hash` skips unchanged items; `dirty_at` marks price / stock
 * / product changes for the 5-minute delta sync. Deleted on disconnect. [S], forced RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('catalog_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('store_integration_id');
            $table->char('product_id', 26);
            $table->char('variant_id', 26);
            $table->string('status', 10);
            $table->string('review_status', 12)->nullable();
            $table->string('excluded_reason', 20)->nullable();
            $table->jsonb('issues')->default('[]');
            $table->char('content_hash', 64)->nullable();
            $table->timestampTz('dirty_at')->nullable();
            $table->timestampTz('last_synced_at')->nullable();
            $table->timestampsTz();

            $table->unique(['store_integration_id', 'variant_id'], 'catalog_items_variant_unique');
            $table->index(['tenant_id', 'store_integration_id', 'status'], 'catalog_items_status_index');
            $table->index(['tenant_id', 'product_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_integration_id'])->references(['tenant_id', 'id'])->on('store_integrations')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement("ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_status_check CHECK (status IN ('pending','synced','error','excluded','deleting'))");
        $db->statement("ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_review_status_check CHECK (review_status IN ('approved','in_review','limited','disapproved'))");
        $db->statement('CREATE INDEX catalog_items_dirty_index ON catalog_items (store_integration_id, dirty_at) WHERE dirty_at IS NOT NULL');
        RlsPolicies::enable($db, 'catalog_items');
    }

    public function down(): void
    {
        Schema::dropIfExists('catalog_items');
    }
};
