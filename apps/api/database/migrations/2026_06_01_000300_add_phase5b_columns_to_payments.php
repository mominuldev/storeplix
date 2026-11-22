<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000300 (5b-2): online charges, test charges, gateway refunds. order_id becomes nullable
 * (test charges only). payment_link_id gets its FK in 000500; return_request_id (added here, or already by 001200
 * on databases that ran 5b-5 first) gets its FK in 001200. RefundMethod gains `gateway` (P5B-24).
 */
return new class extends Migration
{
    public function up(): void
    {
        $hasReturnRequest = Schema::hasColumn('payments', 'return_request_id');

        Schema::table('payments', function (Blueprint $table) use ($hasReturnRequest) {
            $table->string('purpose', 16)->default('order');
            $table->char('gateway_account_id', 26)->nullable();
            $table->char('payment_link_id', 26)->nullable();
            $table->string('provider_trx_id', 64)->nullable();
            $table->bigInteger('refunded_amount')->default(0);
            $table->timestampTz('expires_at')->nullable();
            $table->string('failure_code', 48)->nullable();
            $table->smallInteger('attempt')->default(1);
            if (! $hasReturnRequest) {
                $table->char('return_request_id', 26)->nullable();
                $table->index(['tenant_id', 'store_id', 'return_request_id']);
            }
            $table->index(['tenant_id', 'status', 'expires_at']);
            $table->index(['tenant_id', 'store_id', 'gateway_account_id']);
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement('ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL');
            $db->statement('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check');
            foreach ([
                "payments_method_check CHECK (method IS NULL OR method IN ('cash','bkash_personal','nagad_personal','bank','other','gateway'))",
                "payments_purpose_check CHECK (purpose IN ('order','advance','link','exchange','test'))",
                'payments_refunded_amount_check CHECK (refunded_amount >= 0 AND refunded_amount <= amount)',
                "payments_order_required_check CHECK (purpose = 'test' OR order_id IS NOT NULL)",
                'payments_attempt_check CHECK (attempt >= 1)',
                'payments_gateway_account_fk FOREIGN KEY (tenant_id, store_id, gateway_account_id) REFERENCES payment_gateway_accounts (tenant_id, store_id, id)',
            ] as $constraint) {
                $db->statement("ALTER TABLE payments ADD CONSTRAINT {$constraint}");
            }
        } else {
            Schema::table('payments', function (Blueprint $table) {
                $table->ulid('order_id')->nullable()->change();
            });
        }

        // P5B-20: one gateway transaction can't pay two charges; one open online attempt per order.
        $db->statement("CREATE UNIQUE INDEX payments_provider_trx_unique ON payments (store_id, provider, provider_trx_id) WHERE provider_trx_id IS NOT NULL AND type = 'charge'");
        $db->statement("CREATE UNIQUE INDEX payments_open_online_charge_unique ON payments (order_id) WHERE type = 'charge' AND status = 'pending' AND provider IN ('bkash','sslcommerz')");
    }

    public function down(): void
    {
        $db = DB::connection();
        $db->statement('DROP INDEX IF EXISTS payments_open_online_charge_unique');
        $db->statement('DROP INDEX IF EXISTS payments_provider_trx_unique');
        // Test charges have no order: they can't survive the NOT NULL restore.
        $db->table('payments')->whereNull('order_id')->delete();
        if ($db->getDriverName() === 'pgsql') {
            foreach (['payments_gateway_account_fk', 'payments_attempt_check', 'payments_order_required_check', 'payments_refunded_amount_check', 'payments_purpose_check', 'payments_method_check'] as $name) {
                $db->statement("ALTER TABLE payments DROP CONSTRAINT IF EXISTS {$name}");
            }
            $db->statement("UPDATE payments SET method = 'other' WHERE method = 'gateway'");
            $db->statement("ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IS NULL OR method IN ('cash','bkash_personal','nagad_personal','bank','other'))");
            $db->statement('ALTER TABLE payments ALTER COLUMN order_id SET NOT NULL');
        } else {
            Schema::table('payments', function (Blueprint $table) {
                $table->ulid('order_id')->nullable(false)->change();
            });
        }
        $hasReturns = Schema::hasTable('return_requests');
        Schema::table('payments', function (Blueprint $table) use ($hasReturns) {
            $table->dropIndex(['tenant_id', 'status', 'expires_at']);
            $table->dropIndex(['tenant_id', 'store_id', 'gateway_account_id']);
            $columns = ['purpose', 'gateway_account_id', 'payment_link_id', 'provider_trx_id', 'refunded_amount', 'expires_at', 'failure_code', 'attempt'];
            if (! $hasReturns) {
                $table->dropIndex(['tenant_id', 'store_id', 'return_request_id']);
                $columns[] = 'return_request_id';
            }
            $table->dropColumn($columns);
        });
    }
};
