<?php

declare(strict_types=1);

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-7-CONTRACT §5.1 000100: yearly plan prices (P7-3) and the Phase 7 subscription columns (billing interval,
 * scheduled change, past_due grace, domain grace, end of a row, notices). Timestamps become timestamptz on Postgres.
 * Data fix: active Free rows without a period get now → +1 month.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('plans', function (Blueprint $table) {
            $table->bigInteger('price_yearly_amount')->nullable();
        });

        Schema::table('subscriptions', function (Blueprint $table) {
            $table->string('billing_interval', 8)->default('month');
            $table->foreignUlid('scheduled_plan_id')->nullable()->constrained('plans')->restrictOnDelete();
            $table->string('scheduled_interval', 8)->nullable();
            $table->timestampTz('past_due_at')->nullable();
            $table->timestampTz('grace_ends_at')->nullable();
            $table->timestampTz('domain_grace_ends_at')->nullable();
            $table->timestampTz('ended_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->timestampTz('plan_changed_at')->nullable();
            $table->string('ended_reason', 16)->nullable();
            $table->jsonb('notices')->default('{}');

            $table->index(['status', 'current_period_end']);
            $table->index(['status', 'trial_ends_at']);
        });

        // SQLite rebuilds the table for the new foreign key and loses the partial predicate of the "one current row"
        // index (P7-2 needs expired rows next to the current one): recreate it everywhere (idempotent).
        DB::statement('DROP INDEX IF EXISTS subscriptions_one_current');
        DB::statement("CREATE UNIQUE INDEX subscriptions_one_current ON subscriptions (tenant_id) WHERE status IN ('trialing','active','past_due')");

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach (['created_at', 'updated_at'] as $column) {
                $db->statement("ALTER TABLE plans ALTER COLUMN {$column} TYPE timestamptz USING {$column} AT TIME ZONE 'UTC'");
            }
            foreach (['trial_ends_at', 'current_period_start', 'current_period_end', 'created_at', 'updated_at'] as $column) {
                $db->statement("ALTER TABLE subscriptions ALTER COLUMN {$column} TYPE timestamptz USING {$column} AT TIME ZONE 'UTC'");
            }
        }

        // Data fix before the CHECKs.
        $free = DB::table('plans')->where('code', 'free')->value('id');
        if ($free !== null) {
            DB::table('subscriptions')->where('plan_id', $free)->where('status', 'active')->whereNull('current_period_end')
                ->update(['current_period_start' => now(), 'current_period_end' => now()->addMonth()]);
        }
        DB::table('subscriptions')->whereIn('status', ['expired', 'cancelled'])->whereNull('ended_at')->update(['ended_at' => DB::raw('updated_at')]);

        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                'plans_price_yearly_amount_check CHECK (price_yearly_amount IS NULL OR price_yearly_amount >= 0)',
            ] as $check) {
                $db->statement("ALTER TABLE plans ADD CONSTRAINT {$check}");
            }
            foreach ([
                "subscriptions_status_check CHECK (status IN ('trialing','active','past_due','cancelled','expired'))",
                "subscriptions_billing_interval_check CHECK (billing_interval IN ('month','year'))",
                "subscriptions_scheduled_interval_check CHECK (scheduled_interval IS NULL OR scheduled_interval IN ('month','year'))",
                "subscriptions_ended_reason_check CHECK (ended_reason IS NULL OR ended_reason IN ('unpaid','cancelled'))",
                "subscriptions_past_due_grace_check CHECK (status <> 'past_due' OR grace_ends_at IS NOT NULL)",
                "subscriptions_ended_check CHECK ((status IN ('expired','cancelled')) = (ended_at IS NOT NULL))",
            ] as $check) {
                $db->statement("ALTER TABLE subscriptions ADD CONSTRAINT {$check}");
            }
        }

        (new PlanSeeder)->run();
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); kept for local rollbacks.
        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach (['subscriptions_status_check', 'subscriptions_billing_interval_check', 'subscriptions_scheduled_interval_check',
                'subscriptions_ended_reason_check', 'subscriptions_past_due_grace_check', 'subscriptions_ended_check'] as $check) {
                $db->statement("ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS {$check}");
            }
            $db->statement('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_price_yearly_amount_check');
        }
        Schema::table('subscriptions', function (Blueprint $table) {
            $table->dropIndex(['status', 'current_period_end']);
            $table->dropIndex(['status', 'trial_ends_at']);
            $table->dropConstrainedForeignId('scheduled_plan_id');
            $table->dropColumn(['billing_interval', 'scheduled_interval', 'past_due_at', 'grace_ends_at', 'domain_grace_ends_at',
                'ended_at', 'cancelled_at', 'plan_changed_at', 'ended_reason', 'notices']);
        });
        Schema::table('plans', fn (Blueprint $table) => $table->dropColumn('price_yearly_amount'));
    }
};
