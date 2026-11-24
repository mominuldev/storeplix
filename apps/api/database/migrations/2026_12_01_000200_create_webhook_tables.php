<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-4-CONTRACT §5.1 000200 (API-HOOKS): outbound webhooks. Store-scoped [S] tables with the composite store FK
 * (tenant_id, store_id) → stores(tenant_id, id); deliveries cascade with their endpoint (hard delete, §6.1). The signing
 * secret is IntegrationCredentials ciphertext (S109). RLS forced on all three (RlsTables::TENANT).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('webhook_endpoints', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('url', 2048);
            $table->string('description', 120)->nullable();
            $table->jsonb('events')->default('[]');
            $table->boolean('is_active')->default(true);
            $table->string('disabled_reason', 24)->nullable();
            $table->timestampTz('failing_since')->nullable();
            $table->timestampTz('last_delivery_at')->nullable();
            $table->smallInteger('last_status')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'is_active']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('webhook_secrets', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id')->unique();
            $table->text('secret_encrypted');
            $table->char('last_four', 4);
            $table->text('previous_secret_encrypted')->nullable();
            $table->timestampTz('previous_expires_at')->nullable();
            $table->timestampTz('rotated_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('webhook_deliveries', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('endpoint_id');
            $table->char('event_id', 26);
            $table->string('event_type', 40);
            $table->string('subject_type', 24)->nullable();
            $table->char('subject_id', 26)->nullable();
            $table->string('subject_label', 40)->nullable();
            $table->jsonb('payload');
            $table->string('status', 12)->default('pending');
            $table->smallInteger('attempts')->default(0);
            $table->timestampTz('next_attempt_at')->nullable();
            $table->timestampTz('last_attempt_at')->nullable();
            $table->smallInteger('response_status')->nullable();
            $table->string('response_body_excerpt', 1024)->nullable();
            $table->string('error_code', 32)->nullable();
            $table->integer('duration_ms')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->index(['status', 'next_attempt_at']);
            $table->index(['endpoint_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'endpoint_id'])
                ->references(['tenant_id', 'store_id', 'id'])->on('webhook_endpoints')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            // Newest-first delivery log (§6.1) reads the index backwards cheaply; keep it DESC as §5.1 lists it.
            $db->statement('DROP INDEX IF EXISTS webhook_deliveries_tenant_id_store_id_created_at_index');
            $db->statement('CREATE INDEX webhook_deliveries_tenant_id_store_id_created_at_index ON webhook_deliveries (tenant_id, store_id, created_at DESC)');
            foreach ([
                "webhook_endpoints ADD CONSTRAINT webhook_endpoints_disabled_reason_check CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual','failing'))",
                "webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check CHECK (jsonb_typeof(events) = 'array')",
                "webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending','retrying','succeeded','failed'))",
                'webhook_deliveries ADD CONSTRAINT webhook_deliveries_attempts_check CHECK (attempts >= 0)',
                "webhook_deliveries ADD CONSTRAINT webhook_deliveries_error_code_check CHECK (error_code IS NULL OR error_code IN ('timeout','connection_failed','url_not_allowed','http_error','plan','endpoint_disabled'))",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['webhook_endpoints', 'webhook_secrets', 'webhook_deliveries'] as $table) {
                RlsPolicies::enable($db, $table);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('webhook_deliveries');
        Schema::dropIfExists('webhook_secrets');
        Schema::dropIfExists('webhook_endpoints');
    }
};
