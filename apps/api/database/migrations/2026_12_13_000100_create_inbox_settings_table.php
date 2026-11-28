<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8E §3 (P88E-20): per-store Inbox channels. Store-scoped [S], forced RLS. Absent row = every channel off
 * (created lazily). `email_key` is globally unique: it routes inbound mail before any tenant is known.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inbox_settings', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id')->unique();
            $table->boolean('web_chat_enabled')->default(false);
            $table->boolean('order_messages_enabled')->default(false);
            $table->boolean('email_enabled')->default(false);
            $table->string('email_key', 12)->nullable()->unique();
            $table->timestampTz('email_key_rotated_at')->nullable();
            $table->string('widget_reply_time', 12)->default('minutes');
            $table->string('widget_hours', 40)->nullable();
            $table->string('widget_greeting', 200)->nullable();
            $table->integer('revision')->default(1);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            $db->statement("ALTER TABLE inbox_settings ADD CONSTRAINT inbox_settings_reply_time_check CHECK (widget_reply_time IN ('minutes','hour','day'))");
            $db->statement("ALTER TABLE inbox_settings ADD CONSTRAINT inbox_settings_email_key_check CHECK (email_key IS NULL OR email_key ~ '^[a-z2-7]{12}$')");
            RlsPolicies::enable($db, 'inbox_settings');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('inbox_settings');
    }
};
