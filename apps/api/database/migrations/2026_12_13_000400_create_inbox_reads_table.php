<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-8-8E §3 (P88E-9): per-member read position of a conversation (never moves backwards). [S], forced RLS. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inbox_reads', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('conversation_id');
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->char('last_read_message_id', 26);
            $table->timestampTz('read_at');

            $table->unique(['tenant_id', 'id']);
            $table->unique(['conversation_id', 'user_id']);
            $table->index(['tenant_id', 'user_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'conversation_id'])->references(['tenant_id', 'id'])->on('inbox_conversations')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            RlsPolicies::enable(DB::connection(), 'inbox_reads');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('inbox_reads');
    }
};
