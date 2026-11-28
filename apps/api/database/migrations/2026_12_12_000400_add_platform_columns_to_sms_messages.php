<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9B §3.2 (P89B-24, ADR 0027 §5): `sms_messages` gains provider_id (soft ref; null = environment or not sent),
 * merchant_tenant_id (platform rows: the merchant the SMS was about) and platform_type. Platform SMS (`otp_*`,
 * `platform_*`) always have tenant_id NULL: the data step moves any account-code row's tenant_id to
 * merchant_tenant_id (owner connection, BYPASSRLS). RLS policies unchanged.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sms_messages', function (Blueprint $table) {
            $table->char('provider_id', 26)->nullable();
            $table->foreignUlid('merchant_tenant_id')->nullable()->constrained('tenants')->nullOnDelete();
            $table->string('platform_type', 24)->nullable();
        });

        DB::statement("UPDATE sms_messages SET merchant_tenant_id = tenant_id, tenant_id = NULL WHERE purpose LIKE 'otp\\_%' ESCAPE '\\' AND tenant_id IS NOT NULL");
        foreach (['otp_verify_phone' => 'phone_verification', 'otp_login' => 'sign_in_code', 'otp_reset_password' => 'password_reset_code'] as $purpose => $type) {
            DB::table('sms_messages')->where('purpose', $purpose)->update(['platform_type' => $type]);
        }

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('CREATE INDEX sms_messages_platform_log_index ON sms_messages (created_at DESC, id DESC) WHERE tenant_id IS NULL');
            DB::statement('CREATE INDEX sms_messages_platform_phone_index ON sms_messages ("to", created_at DESC) WHERE tenant_id IS NULL');
            DB::statement('CREATE INDEX sms_messages_provider_index ON sms_messages (provider_id, created_at) WHERE provider_id IS NOT NULL');
        } else {
            DB::statement('CREATE INDEX sms_messages_platform_log_index ON sms_messages (created_at, id) WHERE tenant_id IS NULL');
            DB::statement('CREATE INDEX sms_messages_platform_phone_index ON sms_messages ("to", created_at) WHERE tenant_id IS NULL');
            DB::statement('CREATE INDEX sms_messages_provider_index ON sms_messages (provider_id, created_at) WHERE provider_id IS NOT NULL');
        }
    }

    public function down(): void
    {
        foreach (['sms_messages_platform_log_index', 'sms_messages_platform_phone_index', 'sms_messages_provider_index'] as $index) {
            DB::statement("DROP INDEX IF EXISTS {$index}");
        }
        Schema::table('sms_messages', function (Blueprint $table) {
            $table->dropConstrainedForeignId('merchant_tenant_id');
            $table->dropColumn(['provider_id', 'platform_type']);
        });
    }
};
