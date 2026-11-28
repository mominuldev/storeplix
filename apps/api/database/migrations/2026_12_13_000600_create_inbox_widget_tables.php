<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8E §3, §9 (P88E-10/11/12): website chat sessions (opaque token stored as sha256, HMAC code, the first message
 * held in `pending_message` until verified) and the reply-SMS magic links (code stored as sha256, 7 days, ≤ 20 uses).
 * Both [S], forced RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('inbox_widget_sessions', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('token_hash', 64)->unique();
            $table->string('name', 80);
            $table->string('phone', 15);
            $table->string('status', 10);
            $table->char('code_hash', 64)->nullable();
            $table->timestampTz('code_sent_at')->nullable();
            $table->smallInteger('code_attempts')->default(0);
            $table->smallInteger('code_sends')->default(0);
            $table->jsonb('pending_message')->nullable();
            $table->timestampTz('verified_at')->nullable();
            $table->ulid('conversation_id')->nullable();
            $table->char('ip_hash', 64);
            $table->timestampTz('last_seen_at');
            $table->timestampTz('expires_at');
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'phone', 'created_at']);
            $table->index(['expires_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('conversation_id')->references('id')->on('inbox_conversations')->nullOnDelete();
            }
        });

        Schema::create('inbox_magic_links', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('conversation_id');
            $table->char('code_hash', 64)->unique();
            $table->smallInteger('uses')->default(0);
            $table->timestampTz('expires_at');
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['expires_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'conversation_id'])->references(['tenant_id', 'id'])->on('inbox_conversations')->cascadeOnDelete();
        });

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('ALTER TABLE inbox_widget_sessions ADD CONSTRAINT inbox_widget_sessions_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES inbox_conversations (tenant_id, id) ON DELETE SET NULL (conversation_id)');
            $db->statement("ALTER TABLE inbox_widget_sessions ADD CONSTRAINT inbox_widget_sessions_status_check CHECK (status IN ('pending','verified','unverified'))");
            $db->statement('ALTER TABLE inbox_magic_links ADD CONSTRAINT inbox_magic_links_uses_check CHECK (uses BETWEEN 0 AND 20)');
            RlsPolicies::enable($db, 'inbox_widget_sessions');
            RlsPolicies::enable($db, 'inbox_magic_links');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('inbox_magic_links');
        Schema::dropIfExists('inbox_widget_sessions');
    }
};
