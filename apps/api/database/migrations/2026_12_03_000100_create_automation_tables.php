<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-6-CONTRACT §4.4 000100: automations, their runs, run steps and recovery conversions. Store-scoped [S] tables
 * with the composite store FK (tenant_id, store_id) → stores(tenant_id, id). Nullable references that must survive the
 * referenced row (customer, run, step) use `ON DELETE SET NULL (column)` on Postgres; sqlite gets a single-column FK.
 * RLS forced on all four (RlsTables::TENANT). Also: `audit_logs.actor_type` gains `automation` (P86-20).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('automations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('recipe', 24);
            $table->string('name', 80);
            $table->string('status', 8)->default('draft');
            $table->jsonb('settings');
            $table->timestampTz('last_run_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'recipe']);
            $table->index(['tenant_id', 'store_id', 'status']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('automation_runs', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('automation_id');
            $table->string('trigger', 24);
            $table->string('dedupe_key', 120);
            $table->string('subject_type', 16);
            $table->char('subject_id', 26);
            $table->ulid('customer_id')->nullable();
            $table->string('contact_address', 254)->nullable();
            $table->string('status', 10)->default('running');
            $table->string('outcome_reason', 32)->nullable();
            $table->jsonb('outcome_detail')->nullable();
            $table->smallInteger('next_step')->default(0);
            $table->timestampTz('resume_at')->nullable();
            $table->char('recovery_code_hash', 64)->nullable()->unique();
            $table->timestampTz('window_ends_at')->nullable();
            $table->jsonb('context');
            $table->timestampTz('started_at');
            $table->timestampTz('finished_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['automation_id', 'dedupe_key']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->index(['tenant_id', 'store_id', 'automation_id', 'created_at']);
            $table->index(['store_id', 'contact_address', 'status']);
            $table->index(['status', 'resume_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'automation_id'])->references(['tenant_id', 'store_id', 'id'])->on('automations')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('customer_id')->references('id')->on('customers')->nullOnDelete();
            }
        });

        Schema::create('automation_run_steps', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('run_id');
            $table->smallInteger('step_index');
            $table->string('action', 16);
            $table->string('status', 8);
            $table->string('reason', 32)->nullable();
            $table->string('channel', 8)->nullable();
            $table->string('address', 254)->nullable();
            $table->smallInteger('parts')->default(0);
            $table->char('unsubscribe_code_hash', 64)->nullable()->unique();
            $table->string('provider_message_id', 128)->nullable();
            $table->jsonb('detail')->nullable();
            $table->timestampTz('executed_at');
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['run_id', 'step_index']);
            $table->index(['tenant_id', 'store_id', 'channel', 'address', 'executed_at']);
            $table->index(['tenant_id', 'store_id', 'executed_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'run_id'])->references(['tenant_id', 'store_id', 'id'])->on('automation_runs')->cascadeOnDelete();
        });

        Schema::create('automation_conversions', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('automation_id');
            $table->ulid('run_id')->nullable();
            $table->ulid('step_id')->nullable();
            $table->ulid('order_id')->unique();
            $table->timestampTz('placed_at');
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'placed_at']);
            $table->index(['tenant_id', 'store_id', 'automation_id']);
            $table->index('run_id');
            $table->index('step_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'automation_id'])->references(['tenant_id', 'store_id', 'id'])->on('automations')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('run_id')->references('id')->on('automation_runs')->nullOnDelete();
                $table->foreign('step_id')->references('id')->on('automation_run_steps')->nullOnDelete();
            }
        });

        if ($pgsql) {
            $db = DB::connection();
            // Newest-first lists and the frequency cap read these backwards; keep them DESC as §4.4 lists them.
            foreach ([
                'automation_runs_tenant_id_store_id_created_at_index' => 'automation_runs (tenant_id, store_id, created_at DESC)',
                'automation_runs_tenant_id_store_id_automation_id_created_at_index' => 'automation_runs (tenant_id, store_id, automation_id, created_at DESC)',
                'automation_run_steps_tenant_id_store_id_channel_address_executed_at_index' => 'automation_run_steps (tenant_id, store_id, channel, address, executed_at DESC)',
            ] as $name => $definition) {
                $db->statement("DROP INDEX IF EXISTS {$name}");
                $db->statement("CREATE INDEX {$name} ON {$definition}");
            }
            // §4.4 partial indexes: due waiting runs (resume-due) and open runs by contact (exit matching, dedupe).
            $db->statement('DROP INDEX IF EXISTS automation_runs_status_resume_at_index');
            $db->statement("CREATE INDEX automation_runs_waiting_resume_at_index ON automation_runs (resume_at) WHERE status = 'waiting'");
            $db->statement('DROP INDEX IF EXISTS automation_runs_store_id_contact_address_status_index');
            $db->statement("CREATE INDEX automation_runs_open_contact_index ON automation_runs (store_id, contact_address) WHERE status IN ('running','waiting')");
            foreach ([
                "automations ADD CONSTRAINT automations_recipe_check CHECK (recipe IN ('checkout_recovery','thank_you','vip_tag','return_flag','low_stock'))",
                "automations ADD CONSTRAINT automations_status_check CHECK (status IN ('draft','on','off'))",
                "automations ADD CONSTRAINT automations_settings_check CHECK (jsonb_typeof(settings) = 'object')",
                "automation_runs ADD CONSTRAINT automation_runs_subject_type_check CHECK (subject_type IN ('order','cart','return','inventory'))",
                "automation_runs ADD CONSTRAINT automation_runs_status_check CHECK (status IN ('running','waiting','completed','skipped','stopped','failed'))",
                "automation_runs ADD CONSTRAINT automation_runs_context_check CHECK (jsonb_typeof(context) = 'object')",
                'automation_runs ADD CONSTRAINT automation_runs_customer_fk FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES customers (tenant_id, store_id, id) ON DELETE SET NULL (customer_id)',
                "automation_run_steps ADD CONSTRAINT automation_run_steps_action_check CHECK (action IN ('send_message','add_tag','notify_team'))",
                "automation_run_steps ADD CONSTRAINT automation_run_steps_status_check CHECK (status IN ('sending','done','skipped','failed','unknown'))",
                "automation_run_steps ADD CONSTRAINT automation_run_steps_channel_check CHECK (channel IS NULL OR channel IN ('sms','email'))",
                'automation_run_steps ADD CONSTRAINT automation_run_steps_parts_check CHECK (parts >= 0)',
                'automation_conversions ADD CONSTRAINT automation_conversions_run_fk FOREIGN KEY (tenant_id, store_id, run_id) REFERENCES automation_runs (tenant_id, store_id, id) ON DELETE SET NULL (run_id)',
                'automation_conversions ADD CONSTRAINT automation_conversions_step_fk FOREIGN KEY (tenant_id, store_id, step_id) REFERENCES automation_run_steps (tenant_id, store_id, id) ON DELETE SET NULL (step_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['automations', 'automation_runs', 'automation_run_steps', 'automation_conversions'] as $table) {
                RlsPolicies::enable($db, $table);
            }

            // P86-20: config-level audit rows may name the automation as the actor.
            $db->statement('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check');
            $db->statement("ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user','system','platform_user','api_key','automation'))");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::table('audit_logs')->where('actor_type', 'automation')->update(['actor_type' => 'system']);
            DB::statement('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check');
            DB::statement("ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user','system','platform_user','api_key'))");
        }
        Schema::dropIfExists('automation_conversions');
        Schema::dropIfExists('automation_run_steps');
        Schema::dropIfExists('automation_runs');
        Schema::dropIfExists('automations');
    }
};
