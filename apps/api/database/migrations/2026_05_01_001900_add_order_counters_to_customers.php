<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: delivered / returned counters (P5-22). Written only by OrderService. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('customers', function (Blueprint $table) {
            $table->integer('delivered_orders_count')->default(0);
            $table->integer('returned_orders_count')->default(0);
        });
    }

    public function down(): void
    {
        Schema::table('customers', function (Blueprint $table) {
            $table->dropColumn(['delivered_orders_count', 'returned_orders_count']);
        });
    }
};
