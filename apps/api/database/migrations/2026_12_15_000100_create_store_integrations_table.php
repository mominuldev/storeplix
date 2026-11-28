<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.1 (P89D-3): one registry row per (store, provider) for the tracking, feed and AI integrations. Typed
 * `settings` (validated per provider in code), encrypted write-only `credentials` (IntegrationCredentials, rotated by
 * integrations:rotate-key), last-4 hints, attention reasons, revision lock. Store-scoped [S], forced RLS. The row is
 * kept on disconnect (status `disconnected`, credentials null).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('store_integrations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 24);
            $table->string('status', 16);
            $table->jsonb('settings');
            $table->text('credentials')->nullable();
            $table->jsonb('credentials_hint')->default('{}');
            $table->jsonb('attention')->default('[]');
            $table->timestampTz('token_expires_at')->nullable();
            $table->timestampTz('last_verified_at')->nullable();
            $table->string('last_error_code', 32)->nullable();
            $table->foreignUlid('connected_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('connected_at')->nullable();
            $table->timestampTz('disconnected_at')->nullable();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'provider'], 'store_integrations_store_provider_unique');
            $table->index(['tenant_id', 'provider', 'status'], 'store_integrations_provider_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement("ALTER TABLE store_integrations ADD CONSTRAINT store_integrations_provider_check CHECK (provider IN ('meta_pixel','ga4','tiktok_pixel','gtm_server','meta_catalog','google_merchant','ai_writer','ai_photos'))");
        $db->statement("ALTER TABLE store_integrations ADD CONSTRAINT store_integrations_status_check CHECK (status IN ('setup_required','connected','needs_attention','error','disconnected'))");
        RlsPolicies::enable($db, 'store_integrations');
    }

    public function down(): void
    {
        Schema::dropIfExists('store_integrations');
    }
};
