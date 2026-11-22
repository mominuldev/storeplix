<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: coupons (P5-11). `expired` / `used_up` are derived, never stored. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('coupons', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('code', 32);
            $table->string('type', 16);
            $table->integer('percent_bps')->nullable();
            $table->bigInteger('amount')->nullable();
            $table->bigInteger('max_discount_amount')->nullable();
            $table->string('applies_to', 16)->default('all');
            $table->bigInteger('min_subtotal_amount')->nullable();
            $table->integer('usage_limit')->nullable();
            $table->integer('usage_per_customer')->nullable();
            $table->boolean('first_order_only')->default(false);
            $table->timestampTz('starts_at');
            $table->timestampTz('ends_at')->nullable();
            $table->string('status', 16)->default('draft');
            $table->integer('used_count')->default(0);
            $table->integer('revision')->default(1);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'code']);
            $table->index(['tenant_id', 'store_id', 'status', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            foreach ([
                "coupons_type_check CHECK (type IN ('percentage','fixed','free_shipping'))",
                'coupons_percent_check CHECK (percent_bps IS NULL OR percent_bps BETWEEN 1 AND 10000)',
                'coupons_amount_check CHECK (amount IS NULL OR amount BETWEEN 1 AND 1000000000)',
                'coupons_max_discount_check CHECK (max_discount_amount IS NULL OR max_discount_amount >= 1)',
                "coupons_applies_to_check CHECK (applies_to IN ('all','categories','products'))",
                'coupons_min_subtotal_check CHECK (min_subtotal_amount IS NULL OR min_subtotal_amount >= 0)',
                'coupons_usage_limit_check CHECK (usage_limit IS NULL OR usage_limit >= 1)',
                'coupons_usage_per_customer_check CHECK (usage_per_customer IS NULL OR usage_per_customer >= 1)',
                'coupons_dates_check CHECK (ends_at IS NULL OR ends_at > starts_at)',
                "coupons_status_check CHECK (status IN ('draft','active','disabled'))",
                'coupons_used_count_check CHECK (used_count >= 0)',
                'coupons_code_check CHECK (code = upper(code))',
                "coupons_percentage_shape CHECK (type <> 'percentage' OR (percent_bps IS NOT NULL AND amount IS NULL))",
                "coupons_fixed_shape CHECK (type <> 'fixed' OR (amount IS NOT NULL AND percent_bps IS NULL AND max_discount_amount IS NULL))",
                "coupons_free_shipping_shape CHECK (type <> 'free_shipping' OR (amount IS NULL AND percent_bps IS NULL AND max_discount_amount IS NULL AND applies_to = 'all'))",
            ] as $check) {
                DB::statement("ALTER TABLE coupons ADD CONSTRAINT {$check}");
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('coupons');
    }
};
