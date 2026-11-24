<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8C §3.2 (part B): stock transfers `TR-{n}` between two locations of a store, and their lines. Both
 * store-scoped [S] with the composite store FK and forced RLS (RlsTables::TENANT, 87 after Phase 8.8c). Locations and
 * variants are referenced through (tenant_id, store_id, id), so a transfer can never point into another store or tenant
 * (S187). Locations are never hard-deleted once they have ledger rows (RESTRICT); variants are soft-deleted only.
 * Status machine P88C-9: draft → in_transit → received | cancelled (from draft or in_transit).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('stock_transfers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->integer('sequence');
            $table->string('number', 12);
            $table->char('from_location_id', 26);
            $table->char('to_location_id', 26);
            $table->string('status', 12)->default('draft');
            $table->string('note', 500)->nullable();
            $table->timestampTz('sent_at')->nullable();
            $table->foreignUlid('sent_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('received_at')->nullable();
            $table->foreignUlid('received_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('cancelled_at')->nullable();
            $table->foreignUlid('cancelled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('items_count')->default(0);
            $table->integer('units_sent')->default(0);
            $table->integer('units_received')->default(0);
            $table->integer('units_short')->default(0);
            $table->integer('revision')->default(1);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'number']);
            $table->index(['tenant_id', 'store_id', 'status', 'created_at'], 'stock_transfers_list_index');
            $table->index(['tenant_id', 'store_id', 'from_location_id']);
            $table->index(['tenant_id', 'store_id', 'to_location_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'from_location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'to_location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
        });

        Schema::create('stock_transfer_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('stock_transfer_id', 26);
            $table->char('variant_id', 26);
            $table->integer('quantity');
            $table->integer('quantity_received')->nullable();
            $table->smallInteger('position')->default(0);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['stock_transfer_id', 'variant_id']);
            $table->index(['tenant_id', 'store_id', 'variant_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'stock_transfer_id'])->references(['tenant_id', 'store_id', 'id'])->on('stock_transfers')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants');
        });

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS stock_transfers_list_index');
            $db->statement('CREATE INDEX stock_transfers_list_index ON stock_transfers (tenant_id, store_id, status, created_at DESC)');
            foreach ([
                'stock_transfers ADD CONSTRAINT stock_transfers_route_check CHECK (from_location_id <> to_location_id)',
                "stock_transfers ADD CONSTRAINT stock_transfers_status_check CHECK (status IN ('draft','in_transit','received','cancelled'))",
                'stock_transfers ADD CONSTRAINT stock_transfers_units_check CHECK (items_count >= 0 AND units_sent >= 0 AND units_received >= 0 AND units_short >= 0 AND units_received + units_short <= units_sent)',
                'stock_transfers ADD CONSTRAINT stock_transfers_revision_check CHECK (revision >= 1)',
                'stock_transfer_items ADD CONSTRAINT stock_transfer_items_quantity_check CHECK (quantity BETWEEN 1 AND 100000 AND (quantity_received IS NULL OR (quantity_received >= 0 AND quantity_received <= quantity)))',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'stock_transfers');
            RlsPolicies::enable($db, 'stock_transfer_items');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('stock_transfer_items');
        Schema::dropIfExists('stock_transfers');
    }
};
