<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-6-CONTRACT §4.4 000200 / §7 (P86-12): the checkout contact on carts (phone captured on blur, never returned by
 * any storefront endpoint, deleted with the cart) and the abandoned-checkout detection mark (P86-13). The partial index
 * serves `automations:detect-abandoned`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('carts', function (Blueprint $table) {
            $table->string('contact_phone', 13)->nullable();
            $table->string('contact_name', 80)->nullable();
            $table->string('contact_email', 254)->nullable();
            $table->timestampTz('contact_captured_at')->nullable();
            $table->timestampTz('recovery_detected_at')->nullable();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("CREATE INDEX carts_recovery_candidates_index ON carts (store_id, last_activity_at) WHERE status = 'active' AND contact_phone IS NOT NULL AND recovery_detected_at IS NULL");
        } else {
            Schema::table('carts', fn (Blueprint $table) => $table->index(['store_id', 'last_activity_at'], 'carts_recovery_candidates_index'));
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP INDEX IF EXISTS carts_recovery_candidates_index');
        } else {
            Schema::table('carts', fn (Blueprint $table) => $table->dropIndex('carts_recovery_candidates_index'));
        }
        Schema::table('carts', function (Blueprint $table) {
            $table->dropColumn(['contact_phone', 'contact_name', 'contact_email', 'contact_captured_at', 'recovery_detected_at']);
        });
    }
};
