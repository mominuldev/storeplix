<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9B §3.1 (P89B-1 – P89B-8, ADR 0027): the platform SMS provider registry. Platform table (no tenant_id, no
 * RLS; RlsTables::PLATFORM). The app role may only SELECT (every queue worker routes with it); writes go through the
 * admin connection (PlatformDb). Credentials are integration-credentials ciphertext, never plaintext. At most one
 * `primary` and one `failover` (partial unique indexes); names unique (case-insensitive) among non-removed rows.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sms_providers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('driver', 16);
            $table->string('name', 60);
            $table->string('role', 10)->default('draft');
            $table->text('credentials_encrypted')->nullable();
            $table->jsonb('credentials_hint')->default('{}');
            $table->jsonb('settings');
            $table->string('default_sender_id', 11);
            $table->string('promotional_sender_id', 11)->nullable();
            $table->string('promotional_sender_status', 10)->nullable();
            $table->jsonb('message_groups');
            $table->integer('rate_limit_per_minute')->default(300);
            $table->smallInteger('failover_after_failures')->default(3);
            $table->smallInteger('failover_timeout_seconds')->default(10);
            $table->integer('price_masking_paisa')->nullable();
            $table->integer('price_non_masking_paisa')->nullable();
            $table->bigInteger('balance_amount')->nullable();
            $table->timestampTz('balance_fetched_at')->nullable();
            $table->string('balance_status', 12)->nullable();
            $table->smallInteger('balance_failures')->default(0);
            $table->bigInteger('low_threshold_paisa')->nullable()->default(100000);
            $table->boolean('alert_email')->default(true);
            $table->boolean('alert_in_app')->default(true);
            $table->timestampTz('low_balance_alerted_at')->nullable();
            $table->timestampTz('connection_changed_at');
            $table->timestampTz('last_test_at')->nullable();
            $table->string('last_test_status', 8)->nullable();
            $table->string('last_test_error_code', 32)->nullable();
            $table->foreignUlid('last_test_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('credentials_rotated_at')->nullable();
            $table->foreignUlid('credentials_rotated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('activated_at')->nullable();
            $table->foreignUlid('activated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('removed_at')->nullable();
            $table->foreignUlid('removed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();
        });

        DB::statement("CREATE UNIQUE INDEX sms_providers_one_primary ON sms_providers (role) WHERE role = 'primary'");
        DB::statement("CREATE UNIQUE INDEX sms_providers_one_failover ON sms_providers (role) WHERE role = 'failover'");
        DB::statement("CREATE UNIQUE INDEX sms_providers_name_unique ON sms_providers (lower(name)) WHERE role <> 'removed'");

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "sms_providers_driver_check CHECK (driver IN ('revesms','ssl_wireless','alpha_sms','bulksmsbd','http'))",
                "sms_providers_role_check CHECK (role IN ('draft','primary','failover','inactive','removed'))",
                "sms_providers_credentials_check CHECK (credentials_encrypted IS NOT NULL OR role = 'removed')",
                "sms_providers_promo_status_check CHECK (promotional_sender_status IS NULL OR promotional_sender_status IN ('approved','pending'))",
                'sms_providers_rate_check CHECK (rate_limit_per_minute BETWEEN 1 AND 6000)',
                'sms_providers_failures_check CHECK (failover_after_failures BETWEEN 1 AND 10)',
                'sms_providers_timeout_check CHECK (failover_timeout_seconds BETWEEN 3 AND 30)',
                "sms_providers_balance_status_check CHECK (balance_status IS NULL OR balance_status IN ('ok','unsupported','error'))",
                "sms_providers_test_status_check CHECK (last_test_status IS NULL OR last_test_status IN ('passed','failed'))",
                'sms_providers_revision_check CHECK (revision >= 1)',
            ] as $constraint) {
                $db->statement("ALTER TABLE sms_providers ADD CONSTRAINT {$constraint}");
            }
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('REVOKE ALL ON sms_providers FROM '.RlsPolicies::APP_ROLE);
                $db->statement('GRANT SELECT ON sms_providers TO '.RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        Schema::dropIfExists('sms_providers');
    }
};
