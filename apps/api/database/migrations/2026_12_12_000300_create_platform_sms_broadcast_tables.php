<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9B §3.1, §7 (P89B-17 – P89B-22): promotional broadcasts and their per-recipient rows. `tenant_id` on the
 * recipients is the SUBJECT (the merchant the SMS went to), not an RLS owner: both tables are platform-only (no grant
 * to the app role; RlsTables::PLATFORM_SUBJECT). Recipients are pruned after 13 months; `to` is nulled after 90 days.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('platform_sms_broadcasts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('name', 80);
            $table->text('body_bn');
            $table->text('body_en');
            $table->jsonb('audience');
            $table->string('status', 10)->default('draft');
            $table->timestampTz('scheduled_at')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('finished_at')->nullable();
            $table->jsonb('estimate')->nullable();
            $table->integer('recipients_count')->default(0);
            $table->integer('sent_count')->default(0);
            $table->integer('failed_count')->default(0);
            $table->integer('skipped_count')->default(0);
            $table->char('provider_id', 26)->nullable();
            $table->string('sender_id', 11)->nullable();
            $table->string('failure_reason', 40)->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('confirmed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('cancelled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('confirmed_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->index(['status', 'scheduled_at']);
        });
        DB::statement('CREATE INDEX platform_sms_broadcasts_created_index ON platform_sms_broadcasts (created_at DESC)');

        Schema::create('platform_sms_broadcast_recipients', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('broadcast_id')->constrained('platform_sms_broadcasts')->cascadeOnDelete();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->foreignUlid('user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('to', 15)->nullable();
            $table->char('language', 2);
            $table->string('status', 8)->default('pending');
            $table->string('skip_reason', 20)->nullable();
            $table->smallInteger('parts')->nullable();
            $table->char('opt_out_code_hash', 64)->nullable()->unique();
            $table->char('sms_message_id', 26)->nullable();
            $table->timestampTz('sent_at')->nullable();
            $table->timestampsTz();

            $table->unique(['broadcast_id', 'tenant_id']);
            $table->index(['tenant_id', 'status', 'created_at']);
            $table->index(['broadcast_id', 'status']);
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "platform_sms_broadcasts ADD CONSTRAINT platform_sms_broadcasts_status_check CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed'))",
                'platform_sms_broadcasts ADD CONSTRAINT platform_sms_broadcasts_body_bn_check CHECK (char_length(body_bn) BETWEEN 1 AND 480)',
                'platform_sms_broadcasts ADD CONSTRAINT platform_sms_broadcasts_body_en_check CHECK (char_length(body_en) BETWEEN 1 AND 480)',
                "platform_sms_broadcast_recipients ADD CONSTRAINT platform_sms_broadcast_recipients_status_check CHECK (status IN ('pending','sent','failed','skipped'))",
                "platform_sms_broadcast_recipients ADD CONSTRAINT platform_sms_broadcast_recipients_skip_check CHECK (skip_reason IS NULL OR skip_reason IN ('opted_out','no_verified_phone','weekly_cap','suspended','duplicate'))",
                "platform_sms_broadcast_recipients ADD CONSTRAINT platform_sms_broadcast_recipients_language_check CHECK (language IN ('bn','en'))",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                foreach (['platform_sms_broadcasts', 'platform_sms_broadcast_recipients'] as $table) {
                    $db->statement("REVOKE ALL ON {$table} FROM ".RlsPolicies::APP_ROLE);
                }
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('platform_sms_broadcast_recipients');
        Schema::dropIfExists('platform_sms_broadcasts');
    }
};
