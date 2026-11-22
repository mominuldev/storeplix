<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: payments (COD charge rows and manual refunds in 5a; gateways in 5b). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->string('provider', 16);
            $table->string('type', 8);
            $table->string('status', 16);
            $table->bigInteger('amount');
            $table->char('currency', 3);
            $table->string('method', 24)->nullable();
            $table->string('reference', 64)->nullable();
            $table->string('note', 255)->nullable();
            $table->ulid('parent_payment_id')->nullable();
            $table->string('idempotency_key', 64)->nullable();
            $table->string('provider_payment_id', 128)->nullable();
            $table->jsonb('raw')->nullable();
            $table->timestampTz('verified_at')->nullable();
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'order_id']);
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders');
            $table->foreign(['tenant_id', 'store_id', 'parent_payment_id'])->references(['tenant_id', 'store_id', 'id'])->on('payments');
        });

        DB::statement('CREATE UNIQUE INDEX payments_store_idempotency_unique ON payments (store_id, idempotency_key) WHERE idempotency_key IS NOT NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cod','manual','bkash','sslcommerz'))");
            DB::statement("ALTER TABLE payments ADD CONSTRAINT payments_type_check CHECK (type IN ('charge','refund'))");
            DB::statement("ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('pending','succeeded','failed','cancelled'))");
            DB::statement('ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount > 0)');
            DB::statement("ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IS NULL OR method IN ('cash','bkash_personal','nagad_personal','bank','other'))");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('payments');
    }
};
