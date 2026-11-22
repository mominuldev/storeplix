<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000500 (5b-2): merchant payment links (P5B-22). The token is stored as sha256 (lookup) and
 * encrypted (Copy link / Resend), never in plain text. One active link per order. RLS forced. Adds the
 * payments.payment_link_id FK.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payment_links', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->char('token_hash', 64)->unique();
            $table->text('token_encrypted');
            $table->string('amount_kind', 16);
            $table->integer('percent_bps')->nullable();
            $table->bigInteger('amount');
            $table->string('provider', 16);
            $table->string('status', 16)->default('active');
            $table->timestampTz('expires_at');
            $table->boolean('cancel_if_unpaid');
            $table->jsonb('sent_via')->default('[]');
            $table->timestampTz('paid_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'status', 'expires_at']);
            $table->index(['tenant_id', 'store_id', 'order_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
        });

        DB::statement("CREATE UNIQUE INDEX payment_links_active_order_unique ON payment_links (order_id) WHERE status = 'active'");

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "payment_links_amount_kind_check CHECK (amount_kind IN ('delivery_charge','percent','full','custom'))",
                "payment_links_status_check CHECK (status IN ('active','paid','expired','cancelled'))",
                "payment_links_provider_check CHECK (provider IN ('bkash','sslcommerz'))",
                'payment_links_amount_check CHECK (amount > 0)',
                'payment_links_percent_check CHECK (percent_bps IS NULL OR percent_bps BETWEEN 1 AND 10000)',
            ] as $check) {
                $db->statement("ALTER TABLE payment_links ADD CONSTRAINT {$check}");
            }
            $db->statement('ALTER TABLE payments ADD CONSTRAINT payments_payment_link_fk FOREIGN KEY (tenant_id, store_id, payment_link_id) REFERENCES payment_links (tenant_id, store_id, id)');
            RlsPolicies::enable($db, 'payment_links');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_link_fk');
        }
        Schema::dropIfExists('payment_links');
    }
};
