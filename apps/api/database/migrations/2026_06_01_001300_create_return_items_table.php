<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-5B-CONTRACT §3 001300 (5b-5): returned lines (amount = floor(line total × qty / line qty)). RLS forced. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('return_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('return_request_id');
            $table->ulid('order_item_id');
            $table->smallInteger('quantity');
            $table->char('exchange_variant_id', 26)->nullable();
            $table->string('exchange_variant_title', 130)->nullable();
            $table->smallInteger('restocked_quantity')->default(0);
            $table->bigInteger('amount');
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'return_request_id']);
            $table->index(['tenant_id', 'store_id', 'order_item_id']);
            $table->foreign(['tenant_id', 'store_id', 'return_request_id'])->references(['tenant_id', 'store_id', 'id'])->on('return_requests')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_item_id'])->references(['tenant_id', 'store_id', 'id'])->on('order_items');
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement('ALTER TABLE return_items ADD CONSTRAINT return_items_quantity_check CHECK (quantity BETWEEN 1 AND 99)');
            $db->statement('ALTER TABLE return_items ADD CONSTRAINT return_items_restocked_check CHECK (restocked_quantity BETWEEN 0 AND quantity)');
            $db->statement('ALTER TABLE return_items ADD CONSTRAINT return_items_amount_check CHECK (amount >= 0)');
            RlsPolicies::enable($db, 'return_items');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('return_items');
    }
};
