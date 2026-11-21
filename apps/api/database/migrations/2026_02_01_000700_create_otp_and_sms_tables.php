<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('otp_codes', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('phone', 16); // 8801XXXXXXXXX
            $table->string('purpose', 24);
            $table->char('code_hash', 64); // HMAC-SHA256, never plaintext
            $table->unsignedTinyInteger('attempts')->default(0);
            $table->timestamp('expires_at');
            $table->timestamp('consumed_at')->nullable();
            $table->timestamps();

            $table->index(['phone', 'purpose', 'created_at']);
        });

        Schema::create('sms_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->nullable()->constrained('tenants')->nullOnDelete();
            $table->string('to', 16);
            $table->string('purpose', 32);
            $table->string('template', 64); // template name only — never the OTP
            $table->string('provider_message_id', 128)->nullable();
            $table->string('status', 16)->default('queued'); // queued | sent | failed
            $table->string('error', 255)->nullable();
            $table->timestamps();

            $table->index(['tenant_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sms_messages');
        Schema::dropIfExists('otp_codes');
    }
};
