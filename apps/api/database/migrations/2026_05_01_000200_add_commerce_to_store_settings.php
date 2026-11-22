<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: checkout, order numbering and notification settings (P5-9, P5-16, P5-26). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->boolean('cod_enabled')->default(true);
            $table->bigInteger('free_delivery_over_amount')->nullable();
            $table->string('order_prefix', 6)->nullable();
            $table->boolean('notify_new_order_email')->default(true);
            $table->jsonb('customer_sms')->default('{"order_placed":true,"order_confirmed":false,"order_shipped":true,"order_cancelled":true}');
            $table->string('sms_language', 2)->default('bn');
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE store_settings ADD CONSTRAINT store_settings_free_delivery_check CHECK (free_delivery_over_amount IS NULL OR free_delivery_over_amount BETWEEN 100 AND 1000000000)');
            DB::statement("ALTER TABLE store_settings ADD CONSTRAINT store_settings_order_prefix_check CHECK (order_prefix IS NULL OR order_prefix ~ '^[A-Z]{1,6}$')");
            DB::statement("ALTER TABLE store_settings ADD CONSTRAINT store_settings_sms_language_check CHECK (sms_language IN ('bn','en'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS store_settings_free_delivery_check');
            DB::statement('ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS store_settings_order_prefix_check');
            DB::statement('ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS store_settings_sms_language_check');
        }
        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn(['cod_enabled', 'free_delivery_over_amount', 'order_prefix', 'notify_new_order_email', 'customer_sms', 'sms_language']);
        });
    }
};
