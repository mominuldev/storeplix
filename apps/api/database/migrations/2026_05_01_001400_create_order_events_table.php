<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: append-only order timeline (no updated_at), like inventory_movements. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('order_events', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->string('type', 24);
            $table->string('from_status', 24)->nullable();
            $table->string('to_status', 24)->nullable();
            $table->string('actor_type', 16);
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('body', 1000)->nullable();
            $table->jsonb('meta')->default('{}');
            $table->timestampTz('created_at')->useCurrent();

            $table->index(['tenant_id', 'store_id', 'order_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_type_check CHECK (type IN ('placed','status_changed','note','edited','payment','refund','shipment','notification','coupon_released'))");
            DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_actor_check CHECK (actor_type IN ('user','customer','system'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('order_events');
    }
};
