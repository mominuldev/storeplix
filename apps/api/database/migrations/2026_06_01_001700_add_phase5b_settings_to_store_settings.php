<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 001700: advance-payment rule (5b-2), VAT display + BIN and invoice footer (5b-4, P5B-56),
 * and the new customer SMS toggles `payment_link` / `order_updated` (backfilled on, as the defaults).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->string('cod_advance', 16)->default('none');
            $table->string('tax_display', 16)->default('none');
            $table->integer('tax_rate_bps')->default(0);
            $table->string('tax_bin', 16)->nullable();
            $table->string('invoice_footer', 300)->nullable();
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE store_settings ADD CONSTRAINT store_settings_cod_advance_check CHECK (cod_advance IN ('none','delivery_charge'))");
            DB::statement("ALTER TABLE store_settings ADD CONSTRAINT store_settings_tax_display_check CHECK (tax_display IN ('none','included'))");
            DB::statement('ALTER TABLE store_settings ADD CONSTRAINT store_settings_tax_rate_check CHECK (tax_rate_bps BETWEEN 0 AND 2500)');
        }

        // Backfill: existing toggles keep their values; the two new events default to on. Row by row through the
        // query builder (jsonb on Postgres, text on sqlite). Runs as the owner (migrations bypass RLS).
        DB::table('store_settings')->select(['id', 'customer_sms'])->orderBy('id')->chunk(200, function ($rows) {
            foreach ($rows as $row) {
                $sms = json_decode((string) $row->customer_sms, true) ?: [];
                $sms += ['payment_link' => true, 'order_updated' => true];
                DB::table('store_settings')->where('id', $row->id)->update(['customer_sms' => json_encode($sms)]);
            }
        });
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            foreach (['cod_advance', 'tax_display', 'tax_rate'] as $c) {
                DB::statement("ALTER TABLE store_settings DROP CONSTRAINT IF EXISTS store_settings_{$c}_check");
            }
        }
        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn(['cod_advance', 'tax_display', 'tax_rate_bps', 'tax_bin', 'invoice_footer']);
        });
    }
};
