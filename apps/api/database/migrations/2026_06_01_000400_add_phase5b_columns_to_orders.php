<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000400 (built with 5b-5/5b-4; the 5b-2 columns are included so the contract row lands once):
 * payment hold end, post-delivery return status, exchange source order, printed flags; wider cancel reasons.
 * Also U(tenant_id, store_id, id) on order_items, so return_items can reference order lines with the store-scoped FK.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('orders', function (Blueprint $table) {
            $table->timestampTz('payment_expires_at')->nullable();
            $table->string('return_status', 24)->default('none');
            $table->char('source_order_id', 26)->nullable();
            $table->timestampTz('invoice_printed_at')->nullable();
            $table->timestampTz('label_printed_at')->nullable();
            $table->index(['tenant_id', 'store_id', 'invoice_printed_at']);
            $table->index(['tenant_id', 'store_id', 'label_printed_at']);
        });
        Schema::table('order_items', function (Blueprint $table) {
            $table->unique(['tenant_id', 'store_id', 'id']);
        });

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE orders ADD CONSTRAINT orders_return_status_check CHECK (return_status IN ('none','requested','partially_returned','returned'))");
            DB::statement('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancel_reason_check');
            DB::statement("ALTER TABLE orders ADD CONSTRAINT orders_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN ('customer_request','fake_order','unreachable','out_of_stock','duplicate','other','payment_timeout','payment_link_expired'))");
            DB::statement('ALTER TABLE orders ADD CONSTRAINT orders_source_order_fk FOREIGN KEY (tenant_id, store_id, source_order_id) REFERENCES orders (tenant_id, store_id, id)');
            DB::statement("CREATE INDEX orders_payment_hold_idx ON orders (tenant_id, status, payment_expires_at) WHERE status = 'pending_payment'");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP INDEX IF EXISTS orders_payment_hold_idx');
            DB::statement('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_order_fk');
            DB::statement('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_return_status_check');
            // Rows with the 5b reasons would violate the 5a CHECK: map them to "other" first.
            DB::statement("UPDATE orders SET cancel_reason = 'other' WHERE cancel_reason IN ('payment_timeout','payment_link_expired')");
            DB::statement('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancel_reason_check');
            DB::statement("ALTER TABLE orders ADD CONSTRAINT orders_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN ('customer_request','fake_order','unreachable','out_of_stock','duplicate','other'))");
        }
        Schema::table('order_items', function (Blueprint $table) {
            $table->dropUnique(['tenant_id', 'store_id', 'id']);
        });
        Schema::table('orders', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'store_id', 'invoice_printed_at']);
            $table->dropIndex(['tenant_id', 'store_id', 'label_printed_at']);
            $table->dropColumn(['payment_expires_at', 'return_status', 'source_order_id', 'invoice_printed_at', 'label_printed_at']);
        });
    }
};
