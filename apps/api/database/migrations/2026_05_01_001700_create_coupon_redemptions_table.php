<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: one redemption per order (P5-13); released when the order is cancelled. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('coupon_redemptions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('coupon_id');
            $table->ulid('order_id')->unique();
            $table->string('customer_phone', 13);
            $table->bigInteger('discount_amount');
            $table->string('status', 16)->default('active');
            $table->timestampsTz();

            $table->index(['tenant_id', 'store_id', 'coupon_id', 'customer_phone', 'status']);
            $table->foreign(['tenant_id', 'store_id', 'coupon_id'])->references(['tenant_id', 'store_id', 'id'])->on('coupons');
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_status_check CHECK (status IN ('active','released'))");
            DB::statement('ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_discount_check CHECK (discount_amount >= 0)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('coupon_redemptions');
    }
};
