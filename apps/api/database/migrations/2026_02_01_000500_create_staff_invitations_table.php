<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('staff_invitations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('email', 254);
            $table->string('name', 120)->nullable();
            $table->string('role', 16);
            $table->char('token_hash', 64)->unique();
            $table->foreignUlid('invited_by')->constrained('users');
            $table->timestamp('expires_at');
            $table->timestamp('accepted_at')->nullable();
            $table->foreignUlid('accepted_user_id')->nullable()->constrained('users');
            $table->timestamp('revoked_at')->nullable();
            $table->timestamp('last_sent_at');
            $table->timestamps();

            $table->unique(['tenant_id', 'id']);
        });

        DB::statement('CREATE UNIQUE INDEX staff_invitations_open_email ON staff_invitations (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('staff_invitations');
    }
};
