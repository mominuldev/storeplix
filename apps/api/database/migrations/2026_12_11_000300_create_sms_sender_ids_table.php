<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.1, §8 (P89A-13 – P89A-16): masked sender ID requests. Store-scoped [S], forced RLS. One pending and
 * one approved row per store (partial uniques). A sender ID is unique case-insensitively among pending + approved rows
 * of EVERY shop: that index is deliberately global (not tenant-led) because a unique index is enforced regardless of
 * RLS; the violation is mapped to 409 `sender_id_taken`. The trade licence is a private `media` row
 * (purpose `sender_id_document`, no CHECK on media.purpose exists) referenced through (tenant_id, id) with RESTRICT.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('sms_sender_ids', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('sender_id', 11);
            $table->string('business_name', 120);
            $table->jsonb('uses');
            $table->string('note', 300)->nullable();
            $table->string('status', 12);
            $table->char('document_media_id', 26)->unique();
            $table->timestampTz('rights_confirmed_at');
            $table->foreignUlid('requested_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('requested_at');
            $table->foreignUlid('reviewed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('reviewed_at')->nullable();
            $table->string('decision_reason', 500)->nullable();
            $table->timestampTz('approved_at')->nullable();
            $table->timestampTz('ended_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'requested_at'], 'sms_sender_ids_store_index');
            $table->index(['status', 'requested_at'], 'sms_sender_ids_queue_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'document_media_id'])->references(['tenant_id', 'id'])->on('media');
        });
        DB::statement("CREATE UNIQUE INDEX sms_sender_ids_one_pending ON sms_sender_ids (store_id) WHERE status = 'pending'");
        DB::statement("CREATE UNIQUE INDEX sms_sender_ids_one_approved ON sms_sender_ids (store_id) WHERE status = 'approved'");
        DB::statement("CREATE UNIQUE INDEX sms_sender_ids_taken ON sms_sender_ids (lower(sender_id)) WHERE status IN ('pending','approved')");

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS sms_sender_ids_store_index');
            $db->statement('CREATE INDEX sms_sender_ids_store_index ON sms_sender_ids (tenant_id, store_id, requested_at DESC)');
            foreach ([
                "sms_sender_ids ADD CONSTRAINT sms_sender_ids_status_check CHECK (status IN ('pending','approved','rejected','cancelled','superseded','revoked'))",
                "sms_sender_ids ADD CONSTRAINT sms_sender_ids_pattern_check CHECK (sender_id ~ '^[A-Za-z0-9]{3,11}$' AND sender_id ~ '[A-Za-z]')",
                "sms_sender_ids ADD CONSTRAINT sms_sender_ids_uses_check CHECK (jsonb_typeof(uses) = 'array' AND jsonb_array_length(uses) BETWEEN 1 AND 3)",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'sms_sender_ids');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('sms_sender_ids');
    }
};
