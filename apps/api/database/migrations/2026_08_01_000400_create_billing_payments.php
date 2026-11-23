<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-7-CONTRACT §5.1 000400: payments of Storeplix invoices through the PLATFORM gateway accounts (P7-9–P7-14).
 * One provider transaction can pay one invoice only (global partial unique). RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('billing_payments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('invoice_id');
            $table->string('provider', 16);
            $table->string('status', 12);
            $table->bigInteger('amount');
            $table->char('currency', 3)->default('BDT');
            $table->string('provider_payment_id', 64)->nullable();
            $table->string('provider_trx_id', 64)->nullable();
            $table->string('failure_code', 48)->nullable();
            $table->boolean('is_duplicate')->default(false);
            $table->jsonb('raw')->nullable();
            $table->timestampTz('expires_at');
            $table->timestampTz('verified_at')->nullable();
            $table->timestampTz('last_queried_at')->nullable();
            $table->foreignUlid('initiated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('idempotency_key', 64)->nullable();
            $table->string('reference', 120)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'invoice_id']);
            $table->index(['status', 'created_at']);
            $table->foreign(['tenant_id', 'invoice_id'])->references(['tenant_id', 'id'])->on('billing_invoices')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX billing_payments_provider_trx ON billing_payments (provider, provider_trx_id) WHERE provider_trx_id IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX billing_payments_idempotency ON billing_payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "billing_payments_provider_check CHECK (provider IN ('bkash','sslcommerz','manual'))",
                "billing_payments_status_check CHECK (status IN ('pending','succeeded','failed','cancelled'))",
                'billing_payments_amount_check CHECK (amount > 0)',
                "billing_payments_currency_check CHECK (currency = 'BDT')",
            ] as $check) {
                $db->statement("ALTER TABLE billing_payments ADD CONSTRAINT {$check}");
            }
            RlsPolicies::enable($db, 'billing_payments');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('billing_payments');
    }
};
