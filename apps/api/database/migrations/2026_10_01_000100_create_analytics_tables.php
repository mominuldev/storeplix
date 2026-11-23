<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-2-CONTRACT §5.1 000100 (ADR 0016): nightly analytics snapshots.
 *  - `tenant_daily_metrics`: one row per tenant per Dhaka day (PK (tenant_id, day), no ULID). A tenant table: forced RLS
 *    with the standard policy, AND the app role's privileges revoked (only the admin (BYPASSRLS) connection reads/writes it, B27/B28).
 *  - `platform_daily_metrics`: one row per day (platform table, no RLS), app role revoked too.
 * sqlite gets the same tables without grants, RLS or CHECKs.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tenant_daily_metrics', function (Blueprint $table) {
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->date('day');
            $table->string('plan_code', 32)->nullable();
            $table->string('billing_interval', 8)->nullable();
            $table->string('subscription_status', 16)->nullable();
            $table->string('tenant_status', 16);
            $table->bigInteger('mrr_amount')->default(0);
            $table->boolean('is_comp')->default(false);
            $table->integer('orders_count')->default(0);
            $table->bigInteger('gmv_amount')->default(0);
            $table->char('currency', 3)->default('BDT');
            $table->string('source', 8);
            $table->timestampTz('snapshot_at')->nullable();
            $table->timestampTz('computed_at')->nullable();

            $table->primary(['tenant_id', 'day']);
        });
        DB::statement('CREATE INDEX tenant_daily_metrics_day_mrr_index ON tenant_daily_metrics (day, mrr_amount DESC)');
        DB::statement('CREATE INDEX tenant_daily_metrics_day_paying_index ON tenant_daily_metrics (day) WHERE mrr_amount > 0');

        Schema::create('platform_daily_metrics', function (Blueprint $table) {
            $table->date('day')->primary();
            foreach (['total', 'active', 'suspended', 'paying', 'trialing', 'comp', 'free', 'past_due', 'new'] as $count) {
                $table->integer($count.'_tenants');
            }
            $table->bigInteger('mrr_amount');
            $table->jsonb('mrr_by_plan')->default('{}');
            $table->jsonb('tenants_by_plan')->default('{}');
            $table->jsonb('paying_by_plan')->default('{}');
            $table->jsonb('yearly_by_plan')->default('{}');
            $table->integer('orders_count');
            $table->bigInteger('gmv_amount');
            $table->integer('non_bdt_orders_count')->default(0);
            $table->char('currency', 3)->default('BDT');
            $table->string('source', 8);
            $table->timestampTz('computed_at')->nullable();
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        foreach ([
            "tenant_daily_metrics_billing_interval_check CHECK (billing_interval IS NULL OR billing_interval IN ('month','year'))",
            "tenant_daily_metrics_subscription_status_check CHECK (subscription_status IS NULL OR subscription_status IN ('trialing','active','past_due'))",
            "tenant_daily_metrics_tenant_status_check CHECK (tenant_status IN ('active','suspended'))",
            'tenant_daily_metrics_mrr_check CHECK (mrr_amount >= 0)',
            'tenant_daily_metrics_orders_check CHECK (orders_count >= 0)',
            'tenant_daily_metrics_gmv_check CHECK (gmv_amount >= 0)',
            "tenant_daily_metrics_currency_check CHECK (currency = 'BDT')",
            "tenant_daily_metrics_source_check CHECK (source IN ('nightly','late','backfill'))",
            "tenant_daily_metrics_paying_check CHECK (mrr_amount = 0 OR (tenant_status = 'active' AND NOT is_comp))",
        ] as $check) {
            $db->statement("ALTER TABLE tenant_daily_metrics ADD CONSTRAINT {$check}");
        }
        foreach ([
            'platform_daily_metrics_partition_check CHECK (active_tenants = paying_tenants + trialing_tenants + comp_tenants + free_tenants)',
            'platform_daily_metrics_total_check CHECK (total_tenants = active_tenants + suspended_tenants)',
            "platform_daily_metrics_source_check CHECK (source IN ('nightly','late','backfill'))",
        ] as $check) {
            $db->statement("ALTER TABLE platform_daily_metrics ADD CONSTRAINT {$check}");
        }

        RlsPolicies::enable($db, 'tenant_daily_metrics');

        // S84: no request path reads these tables as the app role; only the admin (BYPASSRLS) connection does.
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('REVOKE ALL ON tenant_daily_metrics FROM '.RlsPolicies::APP_ROLE);
            $db->statement('REVOKE ALL ON platform_daily_metrics FROM '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        Schema::dropIfExists('platform_daily_metrics');
        Schema::dropIfExists('tenant_daily_metrics');
    }
};
