<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: shipments (manual in 5a; courier providers in 5b). One live shipment per order. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shipments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->string('provider', 16)->default('manual');
            $table->string('carrier_name', 60)->nullable();
            $table->string('tracking_code', 64)->nullable();
            $table->string('tracking_url', 500)->nullable();
            $table->string('status', 24);
            $table->bigInteger('cod_amount')->default(0);
            $table->timestampTz('shipped_at')->nullable();
            $table->timestampTz('delivered_at')->nullable();
            $table->timestampTz('returned_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
        });

        DB::statement("CREATE UNIQUE INDEX shipments_one_live_per_order ON shipments (order_id) WHERE status <> 'cancelled'");

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE shipments ADD CONSTRAINT shipments_provider_check CHECK (provider IN ('manual','steadfast','pathao','redx'))");
            DB::statement("ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN ('shipped','delivered','returned','cancelled'))");
            DB::statement('ALTER TABLE shipments ADD CONSTRAINT shipments_cod_check CHECK (cod_amount >= 0)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('shipments');
    }
};
