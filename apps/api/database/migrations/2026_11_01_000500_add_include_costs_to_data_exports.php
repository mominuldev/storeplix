<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-3 SEC-M1: a product export carries `cost_price` only when the member who asked for it held `costs.view`
 * at that moment. Recorded on the row because the export runs later on the queue, without the member's context.
 * Existing rows default to false (no cost column), the safe reading.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('data_exports', function (Blueprint $table) {
            $table->boolean('include_costs')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('data_exports', function (Blueprint $table) {
            $table->dropColumn('include_costs');
        });
    }
};
