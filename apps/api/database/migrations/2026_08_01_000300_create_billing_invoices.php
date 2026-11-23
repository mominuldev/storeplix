<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-7-CONTRACT §5.1 000300: Storeplix invoices to merchants (P7-7, P7-15). One open invoice per tenant; one live
 * renewal invoice per subscription period. Immutable after issue except the status fields. RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('billing_invoices', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('subscription_id');
            $table->string('number', 20)->unique();
            $table->string('kind', 16);
            $table->string('status', 8);
            $table->foreignUlid('plan_id')->constrained('plans')->restrictOnDelete();
            $table->string('interval', 8);
            $table->char('currency', 3)->default('BDT');
            $table->bigInteger('subtotal_amount');
            $table->bigInteger('tax_amount');
            $table->bigInteger('total_amount');
            $table->integer('tax_rate_bps');
            $table->bigInteger('credit_amount')->default(0);
            $table->jsonb('lines');
            $table->jsonb('bill_to');
            $table->timestampTz('period_start')->nullable();
            $table->timestampTz('period_end')->nullable();
            $table->timestampTz('issued_at');
            $table->timestampTz('due_at');
            $table->timestampTz('paid_at')->nullable();
            $table->timestampTz('voided_at')->nullable();
            $table->string('void_reason', 16)->nullable();
            $table->boolean('paid_late')->default(false);
            $table->char('paid_payment_id', 26)->nullable();
            $table->jsonb('reminders')->default('[]');
            $table->string('pdf_path', 255)->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('idempotency_key', 64)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'issued_at']);
            $table->index(['status', 'due_at']);
            $table->foreign(['tenant_id', 'subscription_id'])->references(['tenant_id', 'id'])->on('subscriptions')->cascadeOnDelete();
        });

        DB::statement("CREATE UNIQUE INDEX billing_invoices_one_open ON billing_invoices (tenant_id) WHERE status = 'open'");
        DB::statement('CREATE UNIQUE INDEX billing_invoices_idempotency ON billing_invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
        DB::statement("CREATE UNIQUE INDEX billing_invoices_renewal_period ON billing_invoices (subscription_id, period_start) WHERE kind = 'renewal' AND status <> 'void'");

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "billing_invoices_kind_check CHECK (kind IN ('new','upgrade','renewal'))",
                "billing_invoices_status_check CHECK (status IN ('open','paid','void'))",
                "billing_invoices_interval_check CHECK (interval IN ('month','year'))",
                "billing_invoices_currency_check CHECK (currency = 'BDT')",
                'billing_invoices_amounts_check CHECK (total_amount > 0 AND subtotal_amount + tax_amount = total_amount)',
                "billing_invoices_void_reason_check CHECK (void_reason IS NULL OR void_reason IN ('superseded','expired','unpaid','cancelled','manual'))",
            ] as $check) {
                $db->statement("ALTER TABLE billing_invoices ADD CONSTRAINT {$check}");
            }
            RlsPolicies::enable($db, 'billing_invoices');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('billing_invoices');
    }
};
