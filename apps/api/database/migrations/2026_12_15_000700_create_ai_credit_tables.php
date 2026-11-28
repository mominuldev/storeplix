<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.2 (P89D-33/34/35): AI credits. Tenant-level [T] tables with forced RLS.
 * - ai_credit_accounts: one row per tenant (lazily created by AiCreditCharger::lockAccount(), INSERT … ON CONFLICT DO
 *   NOTHING + SELECT … FOR UPDATE) holding the staff-granted bonus balance (CHECK >= 0). The monthly plan allowance is
 *   not stored: used = Σ allowance consumes + refunds of the period in the ledger.
 * - ai_credit_ledger: APPEND-ONLY (SELECT + INSERT policies, no UPDATE / DELETE grant, like sms_credit_ledger). Partial
 *   unique indexes make consume / refund unique per generation and an admin adjust unique per Idempotency-Key.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('ai_credit_accounts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->unique()->constrained('tenants')->cascadeOnDelete();
            $table->integer('bonus_balance')->default(0);
            $table->timestampTz('last_adjusted_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
        });

        Schema::create('ai_credit_ledger', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('type', 16);
            $table->string('source', 10)->nullable();
            $table->integer('credits');
            $table->integer('bonus_after');
            $table->char('period', 7);
            $table->char('ai_generation_id', 26)->nullable();
            $table->string('reason', 500)->nullable();
            $table->string('actor_type', 16);
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('idempotency_key', 100)->nullable();
            $table->char('request_hash', 64)->nullable();
            $table->timestampTz('created_at');

            $table->index(['tenant_id', 'period', 'type'], 'ai_credit_ledger_period_index');
            $table->index(['tenant_id', 'created_at', 'id'], 'ai_credit_ledger_tenant_created_index');
        });
        DB::statement('CREATE UNIQUE INDEX ai_credit_ledger_generation_unique ON ai_credit_ledger (ai_generation_id, type) WHERE ai_generation_id IS NOT NULL');
        DB::statement("CREATE UNIQUE INDEX ai_credit_ledger_adjust_unique ON ai_credit_ledger (tenant_id, idempotency_key) WHERE type = 'admin_adjust'");

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement('DROP INDEX IF EXISTS ai_credit_ledger_tenant_created_index');
        $db->statement('CREATE INDEX ai_credit_ledger_tenant_created_index ON ai_credit_ledger (tenant_id, created_at DESC, id DESC)');
        foreach ([
            'ai_credit_accounts ADD CONSTRAINT ai_credit_accounts_bonus_check CHECK (bonus_balance >= 0)',
            "ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_type_check CHECK (type IN ('consume','refund','admin_adjust'))",
            "ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_source_check CHECK ((type = 'admin_adjust' AND source IS NULL) OR (type <> 'admin_adjust' AND source IN ('allowance','bonus')))",
            "ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_credits_check CHECK ((type = 'consume' AND credits < 0) OR (type = 'refund' AND credits > 0) OR (type = 'admin_adjust' AND credits <> 0))",
            'ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_bonus_check CHECK (bonus_after >= 0)',
            "ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_period_check CHECK (period ~ '^[0-9]{4}-[0-9]{2}$')",
            "ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_actor_check CHECK (actor_type IN ('system','user','platform'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        RlsPolicies::enable($db, 'ai_credit_accounts');
        RlsPolicies::enable($db, 'ai_credit_ledger');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('REVOKE UPDATE, DELETE ON ai_credit_ledger FROM '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_credit_ledger');
        Schema::dropIfExists('ai_credit_accounts');
    }
};
