<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.1 (ADR 0026): SMS credits. Tenant-level [T] tables with forced RLS.
 * - sms_credit_accounts: one row per tenant (created lazily by SmsCreditService::account()), the cached balance
 *   (CHECK >= 0, row-locked by every charge and credit write, §3.3) and the low-credit alert state (P89A-12).
 * - sms_credit_ledger: APPEND-ONLY (SELECT + INSERT policies, no UPDATE/DELETE grant, like audit_logs). Partial unique
 *   indexes make consume/refund idempotent per sms_message, a purchase grant unique per invoice and an admin adjust
 *   unique per Idempotency-Key.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('sms_credit_accounts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->unique()->constrained('tenants')->cascadeOnDelete();
            $table->bigInteger('balance')->default(0);
            $table->bigInteger('purchased_total')->default(0);
            $table->smallInteger('low_credit_threshold')->nullable();
            $table->timestampTz('low_alert_sent_at')->nullable();
            $table->timestampTz('last_purchase_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
        });

        Schema::create('sms_credit_ledger', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('type', 16);
            $table->integer('credits');
            $table->bigInteger('balance_after');
            $table->char('sms_message_id', 26)->nullable();
            $table->char('billing_invoice_id', 26)->nullable();
            $table->string('reason', 500)->nullable();
            $table->string('actor_type', 16);
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('idempotency_key', 100)->nullable();
            $table->char('request_hash', 64)->nullable();
            $table->timestampTz('created_at');

            $table->index(['tenant_id', 'created_at', 'id'], 'sms_credit_ledger_tenant_created_index');
            $table->index(['tenant_id', 'type', 'created_at'], 'sms_credit_ledger_tenant_type_index');
            $table->foreign(['tenant_id', 'billing_invoice_id'])->references(['tenant_id', 'id'])->on('billing_invoices');
        });
        DB::statement('CREATE UNIQUE INDEX sms_credit_ledger_message_unique ON sms_credit_ledger (sms_message_id, type) WHERE sms_message_id IS NOT NULL');
        DB::statement("CREATE UNIQUE INDEX sms_credit_ledger_purchase_unique ON sms_credit_ledger (billing_invoice_id) WHERE type = 'purchase'");
        DB::statement("CREATE UNIQUE INDEX sms_credit_ledger_adjust_unique ON sms_credit_ledger (tenant_id, idempotency_key) WHERE type = 'admin_adjust'");

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS sms_credit_ledger_tenant_created_index');
            $db->statement('CREATE INDEX sms_credit_ledger_tenant_created_index ON sms_credit_ledger (tenant_id, created_at DESC, id DESC)');
            foreach ([
                'sms_credit_accounts ADD CONSTRAINT sms_credit_accounts_balance_check CHECK (balance >= 0)',
                'sms_credit_accounts ADD CONSTRAINT sms_credit_accounts_purchased_check CHECK (purchased_total >= 0)',
                'sms_credit_accounts ADD CONSTRAINT sms_credit_accounts_threshold_check CHECK (low_credit_threshold IS NULL OR low_credit_threshold IN (100, 200, 500))',
                "sms_credit_ledger ADD CONSTRAINT sms_credit_ledger_type_check CHECK (type IN ('purchase','consume','refund','admin_adjust'))",
                "sms_credit_ledger ADD CONSTRAINT sms_credit_ledger_credits_check CHECK ((type IN ('purchase','refund') AND credits > 0) OR (type = 'consume' AND credits < 0) OR (type = 'admin_adjust' AND credits <> 0))",
                'sms_credit_ledger ADD CONSTRAINT sms_credit_ledger_balance_check CHECK (balance_after >= 0)',
                "sms_credit_ledger ADD CONSTRAINT sms_credit_ledger_actor_check CHECK (actor_type IN ('system','user','platform'))",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'sms_credit_accounts');
            RlsPolicies::enable($db, 'sms_credit_ledger');
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('REVOKE UPDATE, DELETE ON sms_credit_ledger FROM '.RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('sms_credit_ledger');
        Schema::dropIfExists('sms_credit_accounts');
    }
};
