<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.2, §5.3 (amends PHASE-7 §5): `billing_invoices.kind` gains `sms_credits` (an SMS credit pack: no plan,
 * no interval, `sms_credits` = pack credits; subscription_id stays the tenant's current subscription). One open
 * subscription invoice AND one open SMS-credit invoice per tenant: the partial unique U(tenant_id) WHERE open is split
 * by kind. CHECK (kind = 'sms_credits') = (plan_id IS NULL AND interval IS NULL AND sms_credits > 0) on Postgres.
 *
 * sqlite rebuilds the table to drop NOT NULL and loses partial-index predicates on the way, so the partial indexes are
 * dropped first and recreated afterwards (same definitions).
 */
return new class extends Migration
{
    private const PARTIALS = [
        'billing_invoices_idempotency' => 'CREATE UNIQUE INDEX billing_invoices_idempotency ON billing_invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
        'billing_invoices_renewal_period' => "CREATE UNIQUE INDEX billing_invoices_renewal_period ON billing_invoices (subscription_id, period_start) WHERE kind = 'renewal' AND status <> 'void'",
        'billing_invoices_paid_tenant_index' => "CREATE INDEX billing_invoices_paid_tenant_index ON billing_invoices (tenant_id, paid_at) WHERE status = 'paid'",
    ];

    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        DB::statement('DROP INDEX IF EXISTS billing_invoices_one_open');
        if ($pgsql) {
            $db = DB::connection();
            $db->statement('ALTER TABLE billing_invoices ALTER COLUMN plan_id DROP NOT NULL');
            $db->statement('ALTER TABLE billing_invoices ALTER COLUMN interval DROP NOT NULL');
            $db->statement('ALTER TABLE billing_invoices ADD COLUMN sms_credits integer NULL');
        } else {
            $existing = array_column(Schema::getIndexes('billing_invoices'), 'name');
            foreach (array_keys(self::PARTIALS) as $name) {
                DB::statement("DROP INDEX IF EXISTS {$name}");
            }
            Schema::table('billing_invoices', function (Blueprint $table) {
                $table->foreignUlid('plan_id')->nullable()->change();
                $table->string('interval', 8)->nullable()->change();
                $table->integer('sms_credits')->nullable();
            });
            foreach (self::PARTIALS as $name => $sql) {
                if (in_array($name, $existing, true)) {
                    DB::statement("DROP INDEX IF EXISTS {$name}");
                    DB::statement($sql);
                }
            }
        }
        DB::statement("CREATE UNIQUE INDEX billing_invoices_one_open ON billing_invoices (tenant_id) WHERE status = 'open' AND kind <> 'sms_credits'");
        DB::statement("CREATE UNIQUE INDEX billing_invoices_one_open_sms ON billing_invoices (tenant_id) WHERE status = 'open' AND kind = 'sms_credits'");

        if ($pgsql) {
            $db = DB::connection();
            foreach ([
                'billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_kind_check',
                "billing_invoices ADD CONSTRAINT billing_invoices_kind_check CHECK (kind IN ('new','upgrade','renewal','sms_credits'))",
                'billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_interval_check',
                "billing_invoices ADD CONSTRAINT billing_invoices_interval_check CHECK (interval IS NULL OR interval IN ('month','year'))",
                "billing_invoices ADD CONSTRAINT billing_invoices_sms_credits_check CHECK ((kind = 'sms_credits') = (plan_id IS NULL AND interval IS NULL AND sms_credits IS NOT NULL AND sms_credits > 0))",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); this rollback exists for test databases. It fails on purpose while
        // SMS-credit invoices exist (NOT NULL / CHECK), so money history is never rewritten.
        DB::statement('DROP INDEX IF EXISTS billing_invoices_one_open_sms');
        DB::statement('DROP INDEX IF EXISTS billing_invoices_one_open');
        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            foreach ([
                'billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_sms_credits_check',
                'billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_kind_check',
                "billing_invoices ADD CONSTRAINT billing_invoices_kind_check CHECK (kind IN ('new','upgrade','renewal'))",
                'billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_interval_check',
                "billing_invoices ADD CONSTRAINT billing_invoices_interval_check CHECK (interval IN ('month','year'))",
                'billing_invoices ALTER COLUMN plan_id SET NOT NULL',
                'billing_invoices ALTER COLUMN interval SET NOT NULL',
                'billing_invoices DROP COLUMN sms_credits',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
        } else {
            Schema::table('billing_invoices', function (Blueprint $table) {
                $table->dropColumn('sms_credits');
            });
        }
        DB::statement("CREATE UNIQUE INDEX billing_invoices_one_open ON billing_invoices (tenant_id) WHERE status = 'open'");
    }
};
