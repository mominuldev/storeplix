<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: orders (ADR 0011). No soft delete; snapshots keep history when catalog rows go away. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('number', 24);
            $table->bigInteger('sequence');
            $table->string('status', 24);
            $table->string('payment_status', 24)->default('unpaid');
            $table->string('payment_method', 24);
            $table->string('created_via', 16);
            $table->string('channel', 16);
            $table->ulid('customer_id')->nullable();
            $table->string('customer_name', 120);
            $table->string('customer_phone', 13);
            $table->string('customer_email', 254)->nullable();
            $table->jsonb('shipping_address');
            $table->string('district_code', 32);
            $table->char('currency', 3);
            foreach (['subtotal', 'discount', 'shipping', 'shipping_discount', 'tax', 'total', 'paid', 'refunded'] as $money) {
                $table->bigInteger("{$money}_amount")->default(0);
            }
            $table->ulid('coupon_id')->nullable();
            $table->string('coupon_code', 32)->nullable();
            $table->char('shipping_zone_id', 26)->nullable();
            $table->string('shipping_zone_name', 60);
            $table->smallInteger('delivery_min_days')->nullable();
            $table->smallInteger('delivery_max_days')->nullable();
            $table->boolean('shipping_overridden')->default(false);
            $table->string('customer_note', 500)->nullable();
            $table->jsonb('tags')->default('[]');
            $table->integer('revision')->default(1);
            $table->string('idempotency_key', 64)->nullable();
            $table->char('confirmation_token_hash', 64)->nullable();
            $table->timestampTz('confirmation_expires_at')->nullable();
            $table->string('cancel_reason', 32)->nullable();
            $table->timestampTz('placed_at');
            foreach (['confirmed_at', 'shipped_at', 'delivered_at', 'returned_at', 'cancelled_at'] as $at) {
                $table->timestampTz($at)->nullable();
            }
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('ip', 45)->nullable();
            $table->string('user_agent', 255)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'number']);
            $table->unique(['store_id', 'sequence']);
            $table->index(['tenant_id', 'store_id', 'status', 'placed_at']);
            $table->index(['tenant_id', 'store_id', 'placed_at']);
            $table->index(['tenant_id', 'store_id', 'customer_id']);
            $table->index(['tenant_id', 'store_id', 'customer_phone']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'customer_id'])->references(['tenant_id', 'store_id', 'id'])->on('customers');
            $table->foreign(['tenant_id', 'store_id', 'coupon_id'])->references(['tenant_id', 'store_id', 'id'])->on('coupons');
        });

        DB::statement('CREATE UNIQUE INDEX orders_store_idempotency_unique ON orders (store_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX orders_confirmation_token_unique ON orders (confirmation_token_hash) WHERE confirmation_token_hash IS NOT NULL');

        if (DB::getDriverName() === 'pgsql') {
            foreach ([
                "orders_status_check CHECK (status IN ('pending_payment','pending','confirmed','ready_to_ship','shipped','delivered','returned','cancelled'))",
                "orders_payment_status_check CHECK (payment_status IN ('unpaid','partially_paid','paid','partially_refunded','refunded'))",
                "orders_payment_method_check CHECK (payment_method IN ('cod','bkash','sslcommerz'))",
                "orders_created_via_check CHECK (created_via IN ('storefront','dashboard'))",
                "orders_channel_check CHECK (channel IN ('website','facebook','instagram','whatsapp','phone','walk_in','landing_page','other'))",
                "orders_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN ('customer_request','fake_order','unreachable','out_of_stock','duplicate','other'))",
                'orders_money_check CHECK (subtotal_amount >= 0 AND discount_amount >= 0 AND shipping_amount >= 0 AND shipping_discount_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0 AND paid_amount >= 0 AND refunded_amount >= 0)',
                'orders_total_check CHECK (total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount)',
                'orders_discount_check CHECK (discount_amount <= subtotal_amount)',
                'orders_refund_check CHECK (refunded_amount <= paid_amount)',
            ] as $check) {
                DB::statement("ALTER TABLE orders ADD CONSTRAINT {$check}");
            }
            DB::statement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
            DB::statement('CREATE INDEX orders_customer_name_trgm ON orders USING GIN (customer_name gin_trgm_ops)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('orders');
    }
};
