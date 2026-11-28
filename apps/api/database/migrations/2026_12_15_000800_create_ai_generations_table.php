<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.2 / §11: one row per AI job (product description, photo edit). [S], forced RLS. The credit charge and
 * this row are written in one transaction (P89D-34); U(store_id, requested_by, idempotency_key) maps a request's
 * Idempotency-Key to one generation. Product / media references are nullable and `ON DELETE SET NULL (column)` on
 * Postgres (the tenant column stays); outputs are kept 90 days (`ai:prune`).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('ai_generations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('kind', 24);
            $table->string('status', 12);
            $table->char('product_id', 26)->nullable();
            $table->char('source_media_id', 26)->nullable();
            $table->char('result_media_id', 26)->nullable();
            $table->char('original_media_id', 26)->nullable();
            $table->jsonb('input');
            $table->jsonb('output')->nullable();
            $table->smallInteger('credits');
            $table->string('charged_from', 10)->nullable();
            $table->boolean('refunded')->default(false);
            $table->string('provider', 24);
            $table->string('model', 64)->nullable();
            $table->jsonb('usage')->nullable();
            $table->jsonb('flags')->default('{}');
            $table->string('error_code', 24)->nullable();
            $table->foreignUlid('requested_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('idempotency_key', 64);
            $table->char('request_hash', 64);
            $table->timestampTz('finished_at')->nullable();
            $table->timestampTz('applied_at')->nullable();
            $table->timestampTz('undone_at')->nullable();
            $table->timestampTz('original_kept_until')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'requested_by', 'idempotency_key'], 'ai_generations_idempotency_unique');
            $table->index(['tenant_id', 'store_id', 'kind', 'created_at', 'id'], 'ai_generations_list_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement('DROP INDEX IF EXISTS ai_generations_list_index');
        $db->statement('CREATE INDEX ai_generations_list_index ON ai_generations (tenant_id, store_id, kind, created_at DESC, id DESC)');
        foreach ([
            "ai_generations ADD CONSTRAINT ai_generations_kind_check CHECK (kind IN ('product_description','photo_edit'))",
            "ai_generations ADD CONSTRAINT ai_generations_status_check CHECK (status IN ('queued','running','succeeded','failed','applied','undone'))",
            "ai_generations ADD CONSTRAINT ai_generations_charged_from_check CHECK (charged_from IS NULL OR charged_from IN ('allowance','bonus'))",
            'ai_generations ADD CONSTRAINT ai_generations_credits_check CHECK (credits >= 0)',
            'ai_generations ADD CONSTRAINT ai_generations_product_fk FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products (tenant_id, store_id, id) ON DELETE SET NULL (product_id)',
            'ai_generations ADD CONSTRAINT ai_generations_source_media_fk FOREIGN KEY (tenant_id, source_media_id) REFERENCES media (tenant_id, id) ON DELETE SET NULL (source_media_id)',
            'ai_generations ADD CONSTRAINT ai_generations_result_media_fk FOREIGN KEY (tenant_id, result_media_id) REFERENCES media (tenant_id, id) ON DELETE SET NULL (result_media_id)',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        RlsPolicies::enable($db, 'ai_generations');
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_generations');
    }
};
