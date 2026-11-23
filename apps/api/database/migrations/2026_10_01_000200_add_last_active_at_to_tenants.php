<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-2-CONTRACT §5.1 000200 (P82-16): last merchant-dashboard request of any member, written by ResolveTenant at
 * most once per 15 minutes per tenant. Null = never since deploy. Platform table (no RLS).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->timestampTz('last_active_at')->nullable();
            $table->index('last_active_at');
        });
    }

    public function down(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->dropIndex(['last_active_at']);
            $table->dropColumn('last_active_at');
        });
    }
};
