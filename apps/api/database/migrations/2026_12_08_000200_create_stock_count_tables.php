<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.2 (part B): stock counts of one location and their lines. Both store-scoped [S] with the composite
 * store FK and forced RLS (RlsTables::TENANT, 87 after Phase 8.8c). One open count per location: partial UNIQUE
 * (store_id, location_id) WHERE status = 'in_progress' (P88C-11). The optional category survives as NULL when the
 * category is deleted (`ON DELETE SET NULL (category_id)` on Postgres). A line stores `expected` = the location's
 * on_hand when it was (last) counted; finish applies counted − expected (`applied_delta`).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('stock_counts', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('location_id', 26);
            $table->string('name', 80);
            $table->char('category_id', 26)->nullable();
            $table->string('status', 12)->default('in_progress');
            $table->boolean('zero_uncounted')->nullable();
            $table->integer('lines_count')->default(0);
            $table->integer('counted_count')->default(0);
            $table->foreignUlid('started_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('started_at');
            $table->foreignUlid('finished_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('finished_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->foreignUlid('cancelled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'status', 'started_at'], 'stock_counts_list_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
            if (! $pgsql) {
                $table->foreign('category_id')->references('id')->on('categories')->nullOnDelete();
            }
        });

        Schema::create('stock_count_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('stock_count_id', 26);
            $table->char('variant_id', 26);
            $table->integer('counted')->nullable();
            $table->integer('expected')->nullable();
            $table->timestampTz('counted_at')->nullable();
            $table->foreignUlid('counted_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('applied_delta')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['stock_count_id', 'variant_id']);
            $table->index(['tenant_id', 'store_id', 'variant_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'stock_count_id'])->references(['tenant_id', 'store_id', 'id'])->on('stock_counts')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants');
        });

        $db = DB::connection();
        $db->statement("CREATE UNIQUE INDEX stock_counts_one_open ON stock_counts (store_id, location_id) WHERE status = 'in_progress'");

        if ($pgsql) {
            $db->statement('DROP INDEX IF EXISTS stock_counts_list_index');
            $db->statement('CREATE INDEX stock_counts_list_index ON stock_counts (tenant_id, store_id, status, started_at DESC)');
            foreach ([
                "stock_counts ADD CONSTRAINT stock_counts_status_check CHECK (status IN ('in_progress','completed','cancelled'))",
                'stock_counts ADD CONSTRAINT stock_counts_progress_check CHECK (lines_count >= 0 AND counted_count >= 0 AND counted_count <= lines_count)',
                'stock_counts ADD CONSTRAINT stock_counts_revision_check CHECK (revision >= 1)',
                'stock_counts ADD CONSTRAINT stock_counts_category_fk FOREIGN KEY (tenant_id, store_id, category_id) REFERENCES categories (tenant_id, store_id, id) ON DELETE SET NULL (category_id)',
                'stock_count_items ADD CONSTRAINT stock_count_items_counted_check CHECK ((counted IS NULL OR counted BETWEEN 0 AND 1000000) AND (expected IS NULL OR expected >= 0))',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'stock_counts');
            RlsPolicies::enable($db, 'stock_count_items');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('stock_count_items');
        Schema::dropIfExists('stock_counts');
    }
};
